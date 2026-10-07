// Dockerfile handling for the four cases, once per planned service: generate when missing, keep + review
// when present, and rewrite only the failing service when the doctor loop sends execution back here.
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chat, chatJson, type ChatMessage } from '../llm/ollama.js';
import { failures, type Failure } from '../pipeline/engine.js';
import type { Step, StepContext } from '../pipeline/step.js';
import type { AnalysisResult, ServicePlan, ServiceRun } from '../types.js';
import { isSecretFile, readText, scrub, serviceStatus, servicesOf, stripFences, tailLines, walk } from './common.js';

const DOCKERIGNORE = ['.git', 'node_modules', 'npm-debug.log', '.env', '.env.*', '__pycache__', '*.pyc', '.venv', 'venv', 'dist', 'coverage', '.DS_Store', ''].join('\n');
const STATIC_SERVER_IMAGE = 'nginxinc/nginx-unprivileged:1.27-alpine'; // non-root, listens on 8080

const RULES = `Rules:
- FROM the base image given (its slim variant when one exists). WORKDIR /app is the build context; COPY paths are relative to it.
- Use the given install, build and start commands as they are, in the directories given.
- If the package manager is not bundled with the base image (pnpm or yarn on node images), run "corepack enable" before using it.
- Copy dependency manifests and lockfiles first, install, then copy the rest. When the context holds several packages (a workspace), copy the whole context before installing.
- When there is a build command, keep dev dependencies installed until after the build (build tools are usually dev dependencies).
- Static services: build in a first stage, then serve the output directory from a second stage with a static file server that listens on the port as a non-root user.
- Run as a non-root user. Set ENV PORT=<port> and EXPOSE <port>; the server must listen on 0.0.0.0.
- CMD in exec (JSON array) form; wrap a shell command as ["sh", "-c", "..."].
- Output ONLY the Dockerfile, no explanations.`;

interface Context {
  svc: ServicePlan;
  rootRel: string;      // service dir relative to the build context
  warnings: string[];
  shown: string[];      // context-relative files shown to the model
  files: string[];      // every context-relative file, to validate COPY sources
  manifests: string;
}

const rel = (from: string, to: string) => path.posix.relative(from === '.' ? '' : from, to === '.' ? '' : to) || '.';

async function gather(ctx: StepContext, svc: ServicePlan): Promise<Context> {
  const dir = path.join(ctx.workdir, svc.context);
  const files = await walk(dir, 10_000, new Set(['.git', 'node_modules']));
  const rootRel = rel(svc.context, svc.root);
  const under = (f: string) => rootRel === '.' || f.startsWith(`${rootRel}/`);
  const visible = files.filter((f) => !isSecretFile(f) && !/(^|\/)(dist|build|\.next|coverage|__pycache__|\.venv|venv)\//.test(f));
  const shown = [...new Set([...visible.filter(under).slice(0, 100), ...visible.filter((f) => !f.includes('/')).slice(0, 40), ...visible.filter((f) => /(^|\/)(package\.json|requirements\.txt|pyproject\.toml|go\.mod)$/.test(f)).slice(0, 30)])].sort();
  const manifestFiles = [...new Set([rootRel, '.'].flatMap((d) => ['package.json', 'requirements.txt', 'pyproject.toml', 'Pipfile', 'go.mod', 'pnpm-workspace.yaml'].map((m) => (d === '.' ? m : `${d}/${m}`))))].filter((f) => files.includes(f));
  let manifests = '';
  for (const f of manifestFiles) manifests += `--- ${f}\n${((await readText(path.join(dir, f))) ?? '').slice(0, 2500)}\n`;
  const out = ctx.run.nodes.analyze.output as { warnings?: string[] } | undefined;
  return { svc, rootRel, warnings: svc.root === '.' ? out?.warnings ?? [] : [], shown, files, manifests };
}

function describe(c: Context): string {
  const s = c.svc;
  const lockfiles = c.files.filter((f) => /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|poetry\.lock|Pipfile\.lock|uv\.lock|go\.sum)$/.test(f) && (!f.includes('/') || f.startsWith(`${c.rootRel}/`)));
  return [
    `Service "${s.name}": ${s.kind === 'static' ? 'static site' : 'server'} · runtime ${s.runtime}${s.framework ? ` (${s.framework})` : ''}`,
    `Build context: repo directory "${s.context}" (WORKDIR /app)`,
    `Service directory inside the context: ${c.rootRel}${c.rootRel === '.' ? '' : ` (/app/${c.rootRel})`}`,
    `Base image: ${s.runtimeImage ?? `an official ${s.runtime} image`}`,
    s.installCommand ? `Install command (run in /app): ${s.installCommand}` : '',
    s.buildCommand ? `Build command (run in the service directory): ${s.buildCommand}` : '',
    s.startCommand ? `Start command (run in the service directory): ${s.startCommand}` : '',
    s.kind === 'static' ? `Static output directory: ${path.posix.join(c.rootRel, s.outputDir ?? 'dist')} (serve it with ${STATIC_SERVER_IMAGE}, which listens on ${s.port})` : '',
    `Port: ${s.port}`,
    `Lockfiles: ${lockfiles.join(', ') || 'NONE (do not use npm ci or frozen-lockfile installs, do not COPY a lockfile)'}`,
    `Env var names (values supplied at runtime): ${s.envVars.join(', ') || 'none'}`,
    c.warnings.length ? `Analysis warnings:\n- ${c.warnings.join('\n- ')}` : '',
    `Files (relative to the build context):\n${c.shown.join('\n')}`,
    c.manifests,
  ].filter(Boolean).join('\n');
}

// Returns a list of problems; empty means the Dockerfile is usable. With `files` (build-context paths),
// COPY/ADD sources and lockfile-only commands are checked against what actually exists.
export function validate(df: string, port?: number, files?: string[]): string[] {
  const lines = df.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const problems: string[] = [];
  if (!lines.length || !/^(FROM|ARG)\s/i.test(lines[0]) || !lines.some((l) => /^FROM\s/i.test(l))) problems.push('missing FROM instruction');
  if (!lines.some((l) => /^(CMD|ENTRYPOINT)\s/i.test(l))) problems.push('missing CMD/ENTRYPOINT');
  if (port && !lines.some((l) => new RegExp(`^EXPOSE\\s+.*\\b${port}\\b`, 'i').test(l))) problems.push(`does not EXPOSE ${port}`);
  const execCmd = lines.filter((l) => /^(CMD|ENTRYPOINT)\s+\[/i.test(l)).find((l) => /\$\{?[A-Za-z_]/.test(l) && !/"(ba)?sh",\s*"-c"/.test(l));
  if (execCmd) problems.push(`"${execCmd}" uses a $VARIABLE in exec form, where it is not expanded; use ["sh", "-c", "..."] or a literal value`);
  if (files) {
    problems.push(...copyProblems(lines, files));
    if (/\bnpm ci\b/.test(df) && !files.includes('package-lock.json') && !files.includes('npm-shrinkwrap.json')) problems.push('uses "npm ci" but there is no package-lock.json (use "npm install")');
  }
  return problems;
}

function copyProblems(lines: string[], files: string[]): string[] {
  const problems: string[] = [];
  const exists = (src: string) => {
    const p = src.replace(/^\.\//, '').replace(/\/$/, '');
    return p === '.' || p === '' || files.some((f) => f === p || f.startsWith(`${p}/`));
  };
  for (const l of lines) {
    const m = l.match(/^(COPY|ADD)\s+(.*)$/i);
    if (!m || /--from=/i.test(m[2])) continue;
    let args: string[];
    try {
      args = m[2].trim().startsWith('[') ? JSON.parse(m[2]) : m[2].split(/\s+/);
    } catch {
      continue;
    }
    args = args.filter((a) => !a.startsWith('--'));
    for (const src of args.slice(0, -1)) {
      if (/[*?[$]|^https?:/.test(src)) continue;
      if (!exists(src)) problems.push(`${m[1].toUpperCase()} source "${src}" does not exist in the repository`);
    }
  }
  return problems;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

// Plan checks on top of validate(): the Dockerfile must run the planned build and start commands.
export function validateForService(df: string, svc: ServicePlan, files: string[]): string[] {
  const problems = validate(df, svc.port, files);
  const flat = squash(df.replace(/\\\n/g, ' '));
  if (svc.buildCommand && !flat.includes(squash(svc.buildCommand))) problems.push(`does not run the build command "${svc.buildCommand}"`);
  if (svc.kind === 'server' && svc.startCommand) {
    const cmd = df.split('\n').filter((l) => /^\s*(CMD|ENTRYPOINT)\s/i.test(l)).join(' ');
    const words = svc.startCommand.split(/\s+/).filter(Boolean);
    const missing = words.filter((w) => !cmd.includes(w));
    if (missing.length) problems.push(`CMD does not run the start command "${svc.startCommand}" (missing: ${missing.join(' ')})`);
  }
  if (svc.kind === 'static' && svc.outputDir && !new RegExp(`COPY\\s+--from=\\S+\\s+\\S*${svc.outputDir.replace(/^\.\//, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(df)) {
    problems.push(`does not copy the build output "${svc.outputDir}" into a serving stage`);
  }
  return problems;
}

// Small models often skip the non-root user; add one before the final CMD/ENTRYPOINT if missing.
export function ensureNonRoot(df: string): string {
  const lines = df.trimEnd().split('\n');
  const finalFrom = [...lines].reverse().find((l) => /^\s*FROM\s/i.test(l)) ?? '';
  const fromIdx = lines.lastIndexOf(finalFrom);
  if (lines.slice(fromIdx).some((l) => /^\s*USER\s/i.test(l)) || (fromIdx === 0 && lines.some((l) => /^\s*USER\s/i.test(l)))) return df;
  let idx = -1;
  lines.forEach((l, i) => {
    if (/^\s*(CMD|ENTRYPOINT)\s/i.test(l)) idx = i;
  });
  if (idx < 0) return df;
  const user = /\bnode:/.test(finalFrom) ? ['USER node'] : /\b(python|debian|ubuntu|golang):/.test(finalFrom) ? ['RUN useradd --create-home app', 'USER app'] : [];
  if (!user.length) return df;
  lines.splice(idx, 0, ...user);
  return lines.join('\n') + '\n';
}

// Deterministic fallback when the model cannot produce a valid Dockerfile (single-service, legacy shape).
export function template(a: AnalysisResult, files: string[]): string {
  const port = a.port ?? 8080;
  const cmd = JSON.stringify((a.entryCommand ?? '').split(/\s+/).filter(Boolean));
  if (a.runtime === 'node') {
    const install = files.includes('package-lock.json') ? 'npm ci --omit=dev' : 'npm install --omit=dev';
    return `FROM node:20-slim\nWORKDIR /app\nENV NODE_ENV=production PORT=${port}\nCOPY package*.json ./\nRUN ${install}\nCOPY --chown=node:node . .\nUSER node\nEXPOSE ${port}\nCMD ${a.entryCommand ? cmd : '["npm","start"]'}\n`;
  }
  if (a.runtime === 'python') {
    const install = files.includes('requirements.txt') ? 'COPY requirements.txt ./\nRUN pip install --no-cache-dir -r requirements.txt\nCOPY . .' : 'COPY . .\nRUN pip install --no-cache-dir .';
    return `FROM python:3.12-slim\nWORKDIR /app\nENV PYTHONUNBUFFERED=1 PORT=${port}\n${install}\nRUN useradd -m app && chown -R app /app\nUSER app\nEXPOSE ${port}\nCMD ${cmd}\n`;
  }
  return `FROM golang:1.22 AS build\nWORKDIR /src\nCOPY . .\nRUN CGO_ENABLED=0 go build -o /app .\n\nFROM debian:bookworm-slim\nCOPY --from=build /app /app\nRUN useradd -m app\nUSER app\nENV PORT=${port}\nEXPOSE ${port}\nCMD ["/app"]\n`;
}

const DEFAULT_IMAGES: Record<string, string> = { node: 'node:22-slim', python: 'python:3.12-slim', go: 'golang:1.23' };

// Plan-driven fallback: the planned commands, run in the planned directories. Runtime-agnostic.
export function planTemplate(svc: ServicePlan): string {
  const image = svc.runtimeImage ?? DEFAULT_IMAGES[svc.runtime] ?? 'debian:bookworm-slim';
  const rootRel = rel(svc.context, svc.root);
  const needsCorepack = /\b(pnpm|yarn)\b/.test(`${svc.installCommand ?? ''} ${svc.buildCommand ?? ''} ${svc.startCommand ?? ''}`) && /\bnode:/.test(image);
  const build = [
    `FROM ${image}${svc.kind === 'static' ? ' AS build' : ''}`,
    'WORKDIR /app',
    ...(needsCorepack ? ['RUN corepack enable'] : []),
    'COPY . .',
    ...(svc.installCommand ? [`RUN ${svc.installCommand}`] : []),
    ...(rootRel !== '.' ? [`WORKDIR /app/${rootRel}`] : []),
    ...(svc.buildCommand ? [`RUN ${svc.buildCommand}`] : []),
  ];
  if (svc.kind === 'static') {
    const out = path.posix.join('/app', rootRel, svc.outputDir ?? 'dist');
    return [...build, '', `FROM ${STATIC_SERVER_IMAGE}`, `COPY --from=build ${out} /usr/share/nginx/html`, `EXPOSE ${svc.port}`, 'CMD ["nginx", "-g", "daemon off;"]', ''].join('\n');
  }
  const df = [...build, `ENV PORT=${svc.port} HOST=0.0.0.0`, `EXPOSE ${svc.port}`, `CMD ${JSON.stringify(['sh', '-c', `exec ${svc.startCommand ?? 'false'}`])}`, ''].join('\n');
  return ensureNonRoot(df);
}

async function generate(ctx: StepContext, c: Context): Promise<{ dockerfile: string; source: 'llm' | 'template' }> {
  const messages: ChatMessage[] = [
    { role: 'system', content: `You write production Dockerfiles.\n${RULES}` },
    { role: 'user', content: `Write a Dockerfile for this service.\n${describe(c)}` },
  ];
  for (let i = 0; i < 3; i++) {
    try {
      const raw = await chat(messages, { signal: ctx.signal, numCtx: 12288, temperature: i === 0 ? 0.2 : 0.4 });
      const df = ensureNonRoot(stripFences(raw));
      const problems = validateForService(df, c.svc, c.files);
      if (!problems.length) return { dockerfile: df, source: 'llm' };
      ctx.log(`[${c.svc.name}] model Dockerfile rejected: ${problems.join('; ')}`);
      messages.push({ role: 'assistant', content: df }, { role: 'user', content: `That Dockerfile is not acceptable: ${problems.join('; ')}. Return a corrected complete Dockerfile only.` });
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log(`model unavailable: ${err instanceof Error ? err.message : err}`);
      break;
    }
  }
  ctx.log(`[${c.svc.name}] falling back to the plan template`);
  return { dockerfile: planTemplate(c.svc), source: 'template' };
}

interface Review {
  valid: boolean;
  issues: Array<{ severity: 'error' | 'warning'; message: string }>;
  suggestions: string[];
  optimizedDockerfile?: string;
}

// Case 2/4: the existing Dockerfile is kept; the review is advisory and never auto-applied.
async function review(ctx: StepContext, c: Context, current: string): Promise<Review | undefined> {
  try {
    const r = await chatJson<Partial<Review> & { optimizedDockerfile?: string | null }>(
      [
        {
          role: 'system',
          content:
            'You review an existing Dockerfile against the service it builds. Check: dependencies installed correctly, ' +
            'start command matches the service, port matches the service port, image size / dev dependencies / layer order. ' +
            'Reply with JSON only: {"valid": boolean, "issues": [{"severity": "error"|"warning", "message": string}], ' +
            '"suggestions": [string], "optimizedDockerfile": string|null}.',
        },
        { role: 'user', content: `Service:\n${describe(c)}\n\nExisting Dockerfile:\n${current}` },
      ],
      { signal: ctx.signal, numCtx: 12288 },
    );
    const issues = Array.isArray(r.issues) ? r.issues.filter((i) => i && typeof i.message === 'string').map((i) => ({ severity: i.severity === 'error' ? 'error' as const : 'warning' as const, message: i.message })) : [];
    const opt = typeof r.optimizedDockerfile === 'string' && r.optimizedDockerfile.trim() ? stripFences(r.optimizedDockerfile) : undefined;
    return {
      valid: r.valid !== false && !issues.some((i) => i.severity === 'error'),
      issues,
      suggestions: Array.isArray(r.suggestions) ? r.suggestions.filter((s) => typeof s === 'string') : [],
      optimizedDockerfile: opt && !validate(opt).length ? opt : undefined,
    };
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    ctx.log(`review skipped, model unavailable: ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
}

// Case 3 and doctor-loop retries: rewrite one service's Dockerfile from its failure log.
async function fix(ctx: StepContext, c: Context, current: string, failure: Failure, history: Failure[]): Promise<string | undefined> {
  const earlier = history
    .filter((h) => h !== failure && h.diagnosis && (h.service ?? c.svc.name) === c.svc.name)
    .map((h) => `- attempt ${h.attempt} (${h.node}): ${h.diagnosis!.rootCause} -> tried: ${h.diagnosis!.attemptedFix}`)
    .join('\n');
  const prompt =
    `The ${failure.node} step failed for this service.\n\nService:\n${describe(c)}\n\n` +
    `Current Dockerfile:\n${current}\n` +
    `Failure log (last lines):\n${scrub(tailLines(failure.error, 60), ctx.run)}\n\n` +
    (failure.diagnosis ? `Diagnosis: ${failure.diagnosis.rootCause}\nSuggested fix: ${failure.diagnosis.attemptedFix}\n\n` : '') +
    (earlier ? `Earlier attempts that did not fully work:\n${earlier}\n\n` : '') +
    'Return the complete corrected Dockerfile. Fix the root cause shown in the log (for example a wrong CMD or entry file, ' +
    'a missing build step, a missing dependency or tool, files missing from the image, or the wrong port). ' +
    'Do not change parts that are unrelated to the failure. Output ONLY the Dockerfile.';
  const messages: ChatMessage[] = [
    { role: 'system', content: `You fix broken Dockerfiles.\n${RULES}` },
    { role: 'user', content: prompt },
  ];
  for (let i = 0; i < 3; i++) {
    let df: string;
    try {
      df = ensureNonRoot(stripFences(await chat(messages, { signal: ctx.signal, numCtx: 12288, temperature: i === 0 ? 0.2 : 0.5 })));
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log(`model unavailable: ${err instanceof Error ? err.message : err}`);
      return undefined;
    }
    // A fix may change the commands (that is often the root cause); it must still build and expose the port.
    const problems = validate(df, c.svc.port, c.files);
    if (df.trim() === current.trim()) problems.push('it is identical to the failing Dockerfile, so it would fail the same way');
    if (!problems.length) return df;
    ctx.log(`[${c.svc.name}] model fix rejected: ${problems.join('; ')}`);
    messages.push({ role: 'assistant', content: df }, { role: 'user', content: `That Dockerfile is not acceptable: ${problems.join('; ')}. Return a corrected complete Dockerfile only.` });
  }
  return undefined;
}

// For a kept Dockerfile, the build context is the first candidate its COPY sources resolve in.
async function contextFor(ctx: StepContext, svc: ServicePlan, df: string): Promise<string> {
  const lines = df.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const candidates = [...new Set([svc.context, path.posix.dirname(svc.dockerfile), '.'])];
  for (const cand of candidates) {
    const files = await walk(path.join(ctx.workdir, cand), 10_000, new Set(['.git', 'node_modules']));
    if (!copyProblems(lines, files).length) return cand;
  }
  return svc.context;
}

async function write(ctx: StepContext, svc: ServicePlan, content: string): Promise<void> {
  const file = path.join(ctx.workdir, svc.dockerfile);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

export const dockerfile: Step = {
  id: 'dockerfile',
  async run(ctx) {
    if (!ctx.run.analysis) return { ok: false, summary: 'No analysis available', error: 'analyze step has not run' };
    const services = servicesOf(ctx.run);
    if (!services.length) return { ok: false, summary: 'No services planned', error: 'the analysis has no services' };
    const state = failures.get(ctx.run);
    const failure = state?.pending;

    if (failure) {
      state!.pending = undefined;
      const target = services.find((s) => s.plan.name === failure.service) ?? services[0];
      const { plan: svc, state: st } = target;
      const many = services.length > 1;
      serviceStatus(ctx, 'dockerfile', many, svc.name, 'running', `fixing (attempt ${failure.attempt})`);
      const c = await gather(ctx, svc);
      const file = path.join(ctx.workdir, svc.dockerfile);
      const current = st.dockerfile ?? (await readFile(file, 'utf8').catch(() => ''));
      const max = ctx.run.config.maxFixAttempts ?? 3;
      ctx.log(`[${svc.name}] doctor loop attempt ${failure.attempt}: ${failure.node} failed — ${failure.diagnosis?.rootCause ?? 'see log'}`);
      let fixed: string | undefined;
      let how = 'model';
      const tpl = planTemplate(svc);
      // Last attempt on a generated Dockerfile: the plan template, unless it already failed.
      if (!svc.existingDockerfile && failure.attempt >= max && tpl.trim() !== current.trim()) {
        ctx.log(`[${svc.name}] last attempt: using the plan template`);
        fixed = tpl;
        how = 'template';
      } else {
        fixed = await fix(ctx, c, current, failure, state!.history);
        if (!fixed && !svc.existingDockerfile && tpl.trim() !== current.trim()) {
          ctx.log(`[${svc.name}] model could not fix it; falling back to the plan template`);
          fixed = tpl;
          how = 'template';
        }
      }
      if (!fixed) {
        serviceStatus(ctx, 'dockerfile', many, svc.name, 'failed', 'no corrected Dockerfile');
        return {
          ok: false,
          summary: `Could not produce a corrected Dockerfile for ${svc.name}`,
          error: failure.error,
          service: svc.name,
          diagnosis: { ...(failure.diagnosis ?? { rootCause: `${failure.node} failed`, evidence: tailLines(failure.error, 5) }), attemptedFix: 'Model could not produce a different valid Dockerfile', result: 'not-fixed', nextStep: 'Fix the Dockerfile manually using the diagnosis above.' },
        };
      }
      if (svc.existingDockerfile && !existsSync(`${file}.original`)) await copyFile(file, `${file}.original`).catch(() => {});
      await write(ctx, svc, fixed);
      st.dockerfile = fixed;
      st.dockerfileMode = 'fixed';
      if (target.primary) ctx.run.dockerfile = fixed;
      serviceStatus(ctx, 'dockerfile', many, svc.name, 'success', `rewritten (fix attempt ${failure.attempt})`);
      for (const l of fixed.trimEnd().split('\n')) ctx.log(`  ${l}`);
      return {
        ok: true,
        summary: `${services.length > 1 ? `${svc.name}: ` : ''}Dockerfile rewritten (fix attempt ${failure.attempt}${how === 'template' ? ', plan template' : ''})`,
        output: { mode: 'fixed', service: svc.name, path: svc.dockerfile, dockerfile: fixed, previous: current, fixing: failure.diagnosis, services: summary(ctx.run.services!) },
      };
    }

    const outputs: Record<string, unknown> = {};
    const many = services.length > 1;
    for (const { plan: svc, state: st, primary } of services) {
      serviceStatus(ctx, 'dockerfile', many, svc.name, 'running');
      if (svc.existingDockerfile) {
        const current = await readFile(path.join(ctx.workdir, svc.dockerfile), 'utf8');
        svc.context = await contextFor(ctx, svc, current);
        const c = await gather(ctx, svc);
        st.dockerfile = current;
        st.dockerfileMode = 'existing';
        ctx.log(`[${svc.name}] existing ${svc.dockerfile} found — keeping it (context ${svc.context}), reviewing`);
        const r = await review(ctx, c, current);
        for (const i of r?.issues ?? []) ctx.log(`[${svc.name}] ${i.severity}: ${i.message}`);
        const local = validate(current, svc.port).map((p) => ({ severity: 'warning' as const, message: p }));
        const issues = [...local, ...(r?.issues ?? [])];
        outputs[svc.name] = { mode: 'existing', path: svc.dockerfile, dockerfile: current, review: r && { ...r, issues }, suggestions: r?.suggestions ?? [], optimizedDockerfile: r?.optimizedDockerfile };
      } else {
        const c = await gather(ctx, svc);
        ctx.log(`[${svc.name}] no Dockerfile — generating ${svc.dockerfile}`);
        const g = await generate(ctx, c);
        await write(ctx, svc, g.dockerfile);
        st.dockerfile = g.dockerfile;
        st.dockerfileMode = 'generated';
        for (const l of g.dockerfile.trimEnd().split('\n')) ctx.log(`  ${l}`);
        outputs[svc.name] = { mode: 'generated', source: g.source, path: svc.dockerfile, dockerfile: g.dockerfile };
      }
      const ignore = path.join(ctx.workdir, svc.context, '.dockerignore');
      if (!existsSync(ignore)) await writeFile(ignore, DOCKERIGNORE);
      if (primary) ctx.run.dockerfile = st.dockerfile;
      serviceStatus(ctx, 'dockerfile', many, svc.name, 'success', st.dockerfileMode);
    }
    const primary = outputs[services[0].plan.name] as Record<string, unknown>;
    const modes = services.map((s) => `${s.plan.name}: ${s.state.dockerfileMode}`);
    const one = services.length === 1;
    const p0 = primary as { mode: string; source?: string };
    return {
      ok: true,
      summary: one
        ? p0.mode === 'existing' ? 'Existing Dockerfile kept' : `Dockerfile generated (${p0.source === 'llm' ? 'model' : 'template'})`
        : `${services.length} Dockerfiles · ${modes.join(', ')}`,
      output: { ...primary, dockerignore: DOCKERIGNORE, services: outputs },
    };
  },
};

function summary(services: Record<string, ServiceRun>): Record<string, { mode?: string }> {
  return Object.fromEntries(Object.entries(services).map(([k, v]) => [k, { mode: v.dockerfileMode }]));
}
