// Corpus evaluation: runs the LOCAL pipeline (clone -> analyze -> dockerfile -> lint -> build -> smoke)
// against real public repos and writes a results table. Never touches AWS and never approves.
//
//   npx tsx scripts/eval-corpus.ts --label final [--only name,name] [--jobs 1] [--timeout-min 30]
//
// Each label gets its own section in the output file; other sections are kept, so a baseline and a
// final run sit side by side. Images and containers a run creates are removed when it ends.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/pipeline/engine.js';
import { RunStore } from '../src/pipeline/store.js';
import { docker } from '../src/steps/common.js';
import { localSteps } from '../src/steps/index.js';
import type { RunEvent, RunState } from '../src/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1]?.startsWith('--') || i + 1 >= process.argv.length ? 'true' : process.argv[++i]);
}
const label = args.get('label') ?? 'run';
const corpusPath = path.resolve(args.get('corpus') ?? path.join(HERE, '../test/corpus.json'));
const outPath = path.resolve(args.get('out') ?? path.join(HERE, '../test/corpus-results.md'));
const only = args.get('only')?.split(',').filter(Boolean);
const jobs = Math.max(1, Number(args.get('jobs') ?? 1));
const timeoutMs = Number(args.get('timeout-min') ?? 30) * 60_000;
const logsDir = args.get('logs'); // optional: per-repo node logs for debugging (already scrubbed of env values)

interface Entry { url: string; expectServices?: number; covers?: string }
interface ServiceRow { name: string; root?: string; port?: number; start?: string; build?: string; kind?: string; smoke?: string; mode?: string }
interface Result {
  repo: string;
  expect: number;
  status: 'pass' | 'partial' | 'fail';
  servicesUp: number;
  services: ServiceRow[];
  attempts: number;
  seconds: number;
  reason?: string;
  raw?: string;      // table row recovered from an older results file without embedded data
}

const repoName = (url: string) => url.replace(/\.git$/, '').split('/').slice(-2).join('/');
const oneLine = (s: string | undefined, n = 160) => (s ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim().slice(0, n);

// Removes every image and container this run created (tags builddoctor/<runId>*, smoke containers).
async function cleanup(runId: string): Promise<void> {
  const containers = await docker.listContainers({ all: true, filters: { name: [`builddoctor-smoke-${runId}`] } }).catch(() => []);
  for (const c of containers) await docker.getContainer(c.Id).remove({ force: true }).catch(() => {});
  const images = await docker.listImages().catch(() => []);
  for (const img of images) {
    for (const tag of img.RepoTags ?? []) if (tag.startsWith(`builddoctor/${runId}`)) await docker.getImage(tag).remove({ force: true }).catch(() => {});
  }
}

// Reads the run in a contract-tolerant way so the same harness works before and after multi-service.
function services(run: RunState): ServiceRow[] {
  const r = run as unknown as {
    analysis?: { port?: number; entryCommand?: string; framework?: string; runtime?: string; services?: Array<Record<string, unknown>> };
    services?: Record<string, { smoke?: { status?: string }; dockerfileMode?: string }>;
  };
  const plan = r.analysis?.services;
  if (Array.isArray(plan) && plan.length) {
    return plan.map((s) => ({
      name: String(s.name),
      root: String(s.root ?? '.'),
      port: typeof s.port === 'number' ? s.port : undefined,
      start: typeof s.startCommand === 'string' ? s.startCommand : undefined,
      build: typeof s.buildCommand === 'string' ? s.buildCommand : undefined,
      kind: typeof s.kind === 'string' ? s.kind : undefined,
      smoke: r.services?.[String(s.name)]?.smoke?.status,
      mode: r.services?.[String(s.name)]?.dockerfileMode,
    }));
  }
  if (!r.analysis) return [];
  return [{
    name: 'app',
    root: '.',
    port: run.config.appPort ?? r.analysis.port,
    start: r.analysis.entryCommand,
    kind: r.analysis.framework ?? r.analysis.runtime,
    smoke: run.nodes.smoke.status === 'success' ? 'success' : run.nodes.smoke.status === 'idle' || run.nodes.smoke.status === 'skipped' ? undefined : 'failed',
    mode: (run.nodes.dockerfile.output as { mode?: string } | undefined)?.mode,
  }];
}

async function evaluate(entry: Entry, root: string): Promise<Result> {
  const store = new RunStore();
  const engine = new Engine(store, localSteps, { workspaceRoot: root, nodes: ['clone', 'analyze', 'dockerfile', 'lint', 'build', 'smoke'], cleanup: (run) => cleanup(run.id) });
  const run = store.create({ repoUrl: entry.url, maxFixAttempts: 3, aws: { region: 'ap-south-1', instanceType: 't4g.small', openPorts: [] } });
  const events: RunEvent[] = [];
  store.subscribe(run.id, (e) => {
    events.push(e);
    if (e.type === 'node' && e.status !== 'idle') console.log(`[${repoName(entry.url)}] ${e.node} ${e.status}${e.summary ? ` · ${e.summary}` : ''}`);
    if (e.type === 'retry') console.log(`[${repoName(entry.url)}] retry ${e.attempt}: ${e.from} -> ${e.to}: ${oneLine(e.diagnosis.rootCause)}`);
  });
  const started = Date.now();
  const timer = setTimeout(() => {
    console.log(`[${repoName(entry.url)}] timeout, cancelling`);
    void engine.cancel(run.id);
  }, timeoutMs);
  await engine.start(run).finally(() => clearTimeout(timer));
  await cleanup(run.id);
  if (logsDir) {
    await mkdir(logsDir, { recursive: true });
    const nodes = Object.fromEntries((['analyze', 'dockerfile', 'lint', 'build', 'smoke'] as const).map((n) => [n, run.nodes[n].logs]));
    await writeFile(path.join(logsDir, `${repoName(entry.url).replace('/', '__')}.json`), JSON.stringify({ nodes, services: run.services, plan: run.analysis?.services }, null, 2));
  }

  const done = [...events].reverse().find((e) => e.type === 'done') as Extract<RunEvent, { type: 'done' }> | undefined;
  const svc = services(run);
  const expect = entry.expectServices ?? 1;
  const up = svc.filter((s) => s.smoke === 'success').length;
  const status: Result['status'] = done?.status === 'live' && up >= expect ? 'pass' : up > 0 ? 'partial' : 'fail';
  const failedNode = (['clone', 'analyze', 'dockerfile', 'lint', 'build', 'smoke'] as const).find((n) => run.nodes[n].status === 'failed');
  return {
    repo: repoName(entry.url),
    expect,
    status,
    servicesUp: up,
    services: svc,
    attempts: events.filter((e) => e.type === 'retry').length,
    seconds: Math.round((Date.now() - started) / 1000),
    reason: status === 'pass' ? undefined
      : done?.status === 'live' ? `only ${up}/${expect} expected services deployed`
      : [failedNode && `${failedNode}: ${run.nodes[failedNode].summary ?? ''}`, done?.diagnosis?.rootCause].filter(Boolean).join(' — '),
  };
}

function render(results: Result[]): string {
  const pass = results.filter((r) => r.status === 'pass').length;
  const expected = results.reduce((n, r) => n + r.expect, 0);
  const up = results.reduce((n, r) => n + Math.min(r.servicesUp, r.expect), 0);
  const rows = results.map((r) => {
    if (r.raw) return r.raw;
    const s = r.services;
    const cell = (f: (x: ServiceRow) => string) => s.map(f).join('<br>') || '-';
    return `| ${r.repo} | ${cell((x) => `${x.name} (${x.root}${x.kind ? `, ${x.kind}` : ''}${x.mode ? `, ${x.mode}` : ''})`)} | ${cell((x) => String(x.port ?? '?'))} | ${cell((x) => oneLine([x.build && `build: ${x.build}`, x.start && `start: ${x.start}`].filter(Boolean).join('; '), 140) || '?')} | ${r.attempts} | ${r.status}${r.expect > 1 || r.servicesUp > 1 ? ` (${r.servicesUp}/${r.expect})` : ''} | ${r.seconds}s | ${oneLine(r.reason, 220)} |`;
  });
  return [
    `Repos passed: **${pass}/${results.length}** (${Math.round((100 * pass) / Math.max(1, results.length))}%) · expected services up: **${up}/${expected}** · ${new Date().toISOString().slice(0, 16)}Z · model ${process.env.OLLAMA_MODEL ?? 'qwen2.5-coder:7b'}`,
    '',
    '| Repo | Services (root, kind, Dockerfile mode) | Ports | Commands | Fix attempts | Result (up/expected) | Time | Failure reason |',
    '|---|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

// Rows already recorded under this label (so a --only rerun updates just those repos).
async function previous(): Promise<Result[]> {
  const text = await readFile(outPath, 'utf8').catch(() => '');
  const m = text.match(new RegExp(`<!-- label:${label} -->[\\s\\S]*?<!-- data:([A-Za-z0-9+/=]*) -->`));
  if (!m) {
    // Older sections carry only the table: keep their rows verbatim.
    const block = text.match(new RegExp(`<!-- label:${label} -->([\\s\\S]*?)<!-- /label:${label} -->`))?.[1] ?? '';
    return block.split('\n').filter((l) => /^\| [^|-][^|]*\/[^|]+ \|/.test(l) && !l.startsWith('| Repo')).map((l) => {
      const cells = l.split(/(?<!\\)\|/).map((c) => c.trim());
      const status = (cells[6].match(/pass|partial|fail/)?.[0] ?? 'fail') as Result['status'];
      const ratio = cells[6].match(/\((\d+)\/(\d+)\)/);
      return { repo: cells[1], expect: ratio ? Number(ratio[2]) : 1, status, servicesUp: ratio ? Number(ratio[1]) : status === 'pass' ? 1 : 0, services: [], attempts: Number(cells[5]) || 0, seconds: parseInt(cells[7]) || 0, raw: l };
    });
  }
  try {
    return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) as Result[];
  } catch {
    return [];
  }
}

async function writeSection(rows: Result[]): Promise<void> {
  const body = `${render(rows)}\n<!-- data:${Buffer.from(JSON.stringify(rows)).toString('base64')} -->`;
  const header = '# Corpus results\n\nGenerated by `server/scripts/eval-corpus.ts` (local pipeline only: clone, analyze, plan, Dockerfile, lint, build, smoke). A repo passes when its run ends live with at least the expected number of services answering the smoke test.\n';
  let text = (await readFile(outPath, 'utf8').catch(() => '')) || header;
  const start = `<!-- label:${label} -->`;
  const end = `<!-- /label:${label} -->`;
  const block = `${start}\n## ${label}\n\n${body}\n${end}`;
  const re = new RegExp(`${start}[\\s\\S]*?${end}`);
  text = re.test(text) ? text.replace(re, block) : `${text.trimEnd()}\n\n${block}\n`;
  await writeFile(outPath, text);
}

async function main(): Promise<void> {
  await docker.ping();
  const corpus = JSON.parse(await readFile(corpusPath, 'utf8')) as { repos: Entry[] };
  const entries = corpus.repos.filter((e) => !only || only.some((o) => e.url.includes(o)));
  const root = await mkdtemp(path.join(os.tmpdir(), 'builddoctor-corpus-'));
  const results: Result[] = new Array(entries.length);
  const earlier = await previous();
  // Corpus order, with this run's rows replacing earlier rows for the same repo.
  const merged = () => corpus.repos.map((e) => results[entries.indexOf(e)] ?? earlier.find((r) => r.repo === repoName(e.url))).filter((r): r is Result => !!r);
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const i = next++;
      console.log(`\n=== ${repoName(entries[i].url)} ===`);
      try {
        results[i] = await evaluate(entries[i], root);
      } catch (err) {
        results[i] = { repo: repoName(entries[i].url), expect: entries[i].expectServices ?? 1, status: 'fail', servicesUp: 0, services: [], attempts: 0, seconds: 0, reason: `harness error: ${err instanceof Error ? err.message : err}` };
      }
      console.log(`=== ${results[i].repo}: ${results[i].status} (${results[i].seconds}s) ${results[i].reason ?? ''}`);
      await writeSection(merged());
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, entries.length) }, worker));
  await rm(root, { recursive: true, force: true });
  await writeSection(merged());
  console.log(`\n${render(merged())}\n\nwritten to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
