// Multi-service Dockerfile handling and per-service retries, with the model mocked.
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';

const chatReplies: string[] = [];
vi.mock('../src/llm/ollama.js', () => ({
  chat: vi.fn(async () => {
    if (!chatReplies.length) throw new Error('no mocked reply');
    return chatReplies.shift()!;
  }),
  chatJson: vi.fn(async () => {
    throw new Error('model down');
  }),
}));

const { Engine, failures } = await import('../src/pipeline/engine.js');
const { RunStore } = await import('../src/pipeline/store.js');
const { dockerfile, planTemplate, validateForService, validate } = await import('../src/steps/dockerfile.js');
const { listeningPorts } = await import('../src/steps/smoke.js');
const { buildInventory } = await import('../src/steps/inventory.js');
const { finalize } = await import('../src/steps/plan.js');
const { PIPELINE } = await import('../src/types.js');
type ServicePlan = import('../src/types.js').ServicePlan;
type Step = import('../src/pipeline/step.js').Step;

const fx = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'workspaces-monorepo');
const tmp: string[] = [];
afterAll(async () => {
  for (const d of tmp) await rm(d, { recursive: true, force: true });
});

const svc = (over: Partial<ServicePlan>): ServicePlan => ({
  name: 'api', root: 'apps/api', context: '.', dockerfile: 'apps/api/Dockerfile', existingDockerfile: false, kind: 'server', runtime: 'node',
  runtimeImage: 'node:22-slim', installCommand: 'npm ci', startCommand: 'npm start', port: 4000, portEvidence: 'e2', envVars: [], dependsOn: [], ...over,
});

describe('plan template and service validation', () => {
  it('server template runs the planned commands in the planned dirs as non-root', () => {
    const df = planTemplate(svc({ buildCommand: 'npm run build' }));
    expect(df).toBe([
      'FROM node:22-slim', 'WORKDIR /app', 'COPY . .', 'RUN npm ci', 'WORKDIR /app/apps/api', 'RUN npm run build',
      'ENV PORT=4000 HOST=0.0.0.0', 'EXPOSE 4000', 'USER node', 'CMD ["sh","-c","exec npm start"]', '',
    ].join('\n'));
    expect(validateForService(df, svc({ buildCommand: 'npm run build' }), ['package.json', 'package-lock.json'])).toEqual([]);
  });

  it('static template builds then serves the output dir; pnpm gets corepack', () => {
    const s = svc({ name: 'web', root: 'apps/web', kind: 'static', installCommand: 'pnpm install --frozen-lockfile', buildCommand: 'pnpm run build', startCommand: undefined, outputDir: 'dist', port: 8080 });
    const df = planTemplate(s);
    expect(df).toMatch(/^FROM node:22-slim AS build\nWORKDIR \/app\nRUN corepack enable\n/);
    expect(df).toMatch(/COPY --from=build \/app\/apps\/web\/dist \/usr\/share\/nginx\/html\nEXPOSE 8080/);
    expect(validateForService(df, s, [])).toEqual([]);
  });

  it('flags Dockerfiles that ignore the plan or cannot expand $VARS', () => {
    const df = 'FROM node:22-slim\nCOPY . .\nRUN npm ci\nEXPOSE 4000\nCMD ["node", "index.js"]\n';
    expect(validateForService(df, svc({ buildCommand: 'npm run build' }), ['package.json', 'package-lock.json'])).toEqual([
      'does not run the build command "npm run build"',
      'CMD does not run the start command "npm start" (missing: npm start)',
    ]);
    expect(validate('FROM python:3.12-slim\nEXPOSE 8000\nCMD ["uvicorn", "main:app", "--port", "$PORT"]\n', 8000)).toEqual([
      '"CMD ["uvicorn", "main:app", "--port", "$PORT"]" uses a $VARIABLE in exec form, where it is not expanded; use ["sh", "-c", "..."] or a literal value',
    ]);
  });

  it('reads the port an app reports in its logs, ignoring ports it connects to', () => {
    expect(listeningPorts('  ▲ Next.js 16\n  - Local:        http://localhost:3000\n')).toEqual([3000]);
    expect(listeningPorts('INFO: Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)')).toEqual([8000]);
    expect(listeningPorts('Server listening on port 5005')).toEqual([5005]);
    expect(listeningPorts('Error: connect ECONNREFUSED 127.0.0.1:5432')).toEqual([]);
  });
});

describe('dockerfile step: one Dockerfile per service, retries touch only the failing one', () => {
  it('generates per-app Dockerfiles, then rewrites only the failing service', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'bd-svc-'));
    tmp.push(root);
    const workdir = path.join(root, 'repo');
    await cp(fx, workdir, { recursive: true });
    const inv = await buildInventory(workdir);
    const services = finalize(inv, [svc({}), svc({ name: 'web', root: 'apps/web', dockerfile: '', port: 5050, portEvidence: 'e4' })]);
    const store = new RunStore();
    const run = store.create({ repoUrl: 'file://fixture', aws: { region: 'ap-south-1', instanceType: 't4g.small', openPorts: [] } });
    run.analysis = { runtime: 'node', port: 4000, entryCommand: 'npm start', envVars: [], dependencyFiles: [], dockerfile: 'missing', services };
    const logs: string[] = [];
    const ctx = { run, workdir, log: (l: string) => logs.push(l), emit: () => {}, signal: new AbortController().signal };

    const apiDf = 'FROM node:22-slim\nWORKDIR /app\nCOPY . .\nRUN npm ci\nWORKDIR /app/apps/api\nENV PORT=4000\nEXPOSE 4000\nCMD ["npm", "start"]\n';
    chatReplies.push(apiDf, 'FROM node:22-slim\nCMD ["npm", "start"]\n'); // web's first answer is rejected (no EXPOSE)
    chatReplies.push(apiDf.replace(/4000/g, '5050').replace('apps/api', 'apps/web'));
    const first = await dockerfile.run(ctx);
    expect(first.ok).toBe(true);
    expect(await readFile(path.join(workdir, 'apps/api/Dockerfile'), 'utf8')).toContain('EXPOSE 4000\nUSER node\nCMD');
    expect(await readFile(path.join(workdir, 'apps/web/Dockerfile'), 'utf8')).toContain('EXPOSE 5050');
    expect(run.services!.api.dockerfileMode).toBe('generated');
    expect(run.services!.web.image).toBe(`builddoctor/${run.id}-web:latest`);
    expect(run.services!.api.image).toBe(`builddoctor/${run.id}:latest`); // primary keeps the legacy tag
    expect(run.dockerfile).toBe(run.services!.api.dockerfile);
    expect(logs.join('\n')).toMatch(/\[web\] model Dockerfile rejected: does not EXPOSE 5050/);

    const apiBefore = run.services!.api.dockerfile;
    const failure = { node: 'smoke' as const, error: 'container exited with code 1', attempt: 1, service: 'web', diagnosis: { rootCause: 'web crashed', evidence: '', attemptedFix: 'x', result: 'not-fixed' as const } };
    failures.set(run, { pending: failure, history: [failure] });
    chatReplies.push(apiDf.replace(/4000/g, '5050').replace('apps/api', 'apps/web').replace('npm ci', 'npm install'));
    const second = await dockerfile.run(ctx);
    expect(second).toMatchObject({ ok: true, summary: expect.stringMatching(/^web: Dockerfile rewritten \(fix attempt 1\)/) });
    expect(run.services!.web.dockerfileMode).toBe('fixed');
    expect(run.services!.api.dockerfile).toBe(apiBefore);
    expect(await readFile(path.join(workdir, 'apps/web/Dockerfile'), 'utf8')).toContain('npm install');
  });
});

describe('engine: retry budget per service', () => {
  it('each service gets its own fix attempts', async () => {
    const calls: string[] = [];
    let smokeRuns = 0;
    const steps: Step[] = PIPELINE.map((id) => ({
      id,
      async run() {
        calls.push(id);
        if (id !== 'smoke') return { ok: true, summary: 'ok' };
        smokeRuns++;
        // api fails 3 times, then web fails 3 times: 6 retries in total, within a budget of 3 per service.
        if (smokeRuns <= 3) return { ok: false, summary: 'api down', error: 'x', retryFrom: 'dockerfile', service: 'api' };
        if (smokeRuns <= 6) return { ok: false, summary: 'web down', error: 'x', retryFrom: 'dockerfile', service: 'web' };
        return { ok: true, summary: 'all up' };
      },
    }));
    const store = new RunStore();
    const engine = new Engine(store, steps, { workspaceRoot: path.join(os.tmpdir(), 'bd-engine-svc'), nodes: ['clone', 'analyze', 'dockerfile', 'lint', 'build', 'smoke'] });
    const run = store.create({ repoUrl: 'x', aws: { region: 'ap-south-1', instanceType: 't4g.small', openPorts: [] } });
    const retries: Array<{ service?: string; attempt: number }> = [];
    store.subscribe(run.id, (e) => e.type === 'retry' && retries.push({ service: e.service, attempt: e.attempt }));
    await engine.start(run);
    expect(run.status).toBe('live');
    expect(retries).toEqual([1, 2, 3].map((a) => ({ service: 'api', attempt: a })).concat([1, 2, 3].map((a) => ({ service: 'web', attempt: a }))));
  });
});
