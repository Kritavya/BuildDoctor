// Dockerfile handling for the four cases: generate when missing, keep + review when present,
// and rewrite from the failure log when the doctor loop sends execution back here.
import { existsSync } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chat, chatJson, type ChatMessage } from '../llm/ollama.js';
import { failures, type Failure } from '../pipeline/engine.js';
import type { Step, StepContext } from '../pipeline/step.js';
import type { AnalysisResult } from '../types.js';
import { isSecretFile, readText, scrub, stripFences, tailLines, walk } from './common.js';

const DOCKERIGNORE = ['.git', 'node_modules', 'npm-debug.log', '.env', '.env.*', '__pycache__', '*.pyc', '.venv', 'venv', 'dist', 'coverage', '.DS_Store', ''].join('\n');

const RULES = `Rules:
- Use a slim official base image (node:20-slim, python:3.12-slim, golang:1.22 builder + debian:bookworm-slim runtime).
- WORKDIR /app. Copy dependency manifests first and install dependencies, then copy the source (layer caching).
- Node: "npm ci --omit=dev" only if package-lock.json exists, otherwise "npm install --omit=dev".
- Python: "pip install --no-cache-dir -r requirements.txt" (or "pip install --no-cache-dir ." for pyproject).
- Run as a non-root user (node images already have user "node"; for python create one with useradd).
- Set ENV PORT=<port>, EXPOSE <port>, and the server must listen on 0.0.0.0.
- CMD in exec (JSON array) form.
- Output ONLY the Dockerfile, no explanations.`;

interface Context {
  analysis: AnalysisResult;
  warnings: string[];
  files: string[];      // shown to the model
  allFiles: string[];   // used to validate COPY sources
  manifests: string;
}

async function gather(ctx: StepContext): Promise<Context> {
  const analysis = ctx.run.analysis!;
  const files = (await walk(ctx.workdir, 150)).filter((f) => !isSecretFile(f));
  let manifests = '';
  for (const f of analysis.dependencyFiles) {
    manifests += `--- ${f}\n${((await readText(path.join(ctx.workdir, f))) ?? '').slice(0, 2500)}\n`;
  }
  const out = ctx.run.nodes.analyze.output as { warnings?: string[] } | undefined;
  const allFiles = await walk(ctx.workdir, 10_000, new Set(['.git', 'node_modules']));
  return { analysis, warnings: out?.warnings ?? [], files, allFiles, manifests };
}

function describe(c: Context): string {
  const a = c.analysis;
  return [
    `Runtime: ${a.runtime}${a.framework ? ` (${a.framework})` : ''}`,
    `Start command: ${a.entryCommand ?? 'unknown'}`,
    `Port: ${a.port}`,
    a.runtime === 'node' ? `Lockfile: ${c.allFiles.includes('package-lock.json') ? 'package-lock.json present' : 'NO package-lock.json (do not use npm ci, do not COPY package-lock.json)'}` : '',
    `Env var names (values supplied at runtime): ${a.envVars.join(', ') || 'none'}`,
    c.warnings.length ? `Analysis warnings:\n- ${c.warnings.join('\n- ')}` : '',
    `Files:\n${c.files.join('\n')}`,
    c.manifests,
  ].filter(Boolean).join('\n');
}

// Returns a list of problems; empty means the Dockerfile is usable. With `files` (repo paths),
// COPY/ADD sources and lockfile-only commands are checked against what actually exists.
export function validate(df: string, port?: number, files?: string[]): string[] {
  const lines = df.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const problems: string[] = [];
  if (!lines.length || !/^(FROM|ARG)\s/i.test(lines[0]) || !lines.some((l) => /^FROM\s/i.test(l))) problems.push('missing FROM instruction');
  if (!lines.some((l) => /^(CMD|ENTRYPOINT)\s/i.test(l))) problems.push('missing CMD/ENTRYPOINT');
  if (port && !lines.some((l) => new RegExp(`^EXPOSE\\s+.*\\b${port}\\b`, 'i').test(l))) problems.push(`does not EXPOSE ${port}`);
  if (files) {
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
        if (/[*?[]|^https?:/.test(src)) continue;
        if (!exists(src)) problems.push(`${m[1].toUpperCase()} source "${src}" does not exist in the repository`);
      }
    }
    if (/\bnpm ci\b/.test(df) && !files.includes('package-lock.json')) problems.push('uses "npm ci" but there is no package-lock.json (use "npm install --omit=dev")');
  }
  return problems;
}

// Small models often skip the non-root user; add one before the final CMD/ENTRYPOINT if missing.
export function ensureNonRoot(df: string): string {
  const lines = df.trimEnd().split('\n');
  if (lines.some((l) => /^\s*USER\s/i.test(l))) return df;
  const finalFrom = [...lines].reverse().find((l) => /^\s*FROM\s/i.test(l)) ?? '';
  let idx = -1;
  lines.forEach((l, i) => {
    if (/^\s*(CMD|ENTRYPOINT)\s/i.test(l)) idx = i;
  });
  if (idx < 0) return df;
  const user = /\bnode:/.test(finalFrom) ? ['USER node'] : /\b(python|debian|ubuntu):/.test(finalFrom) ? ['RUN useradd --create-home app', 'USER app'] : [];
  if (!user.length) return df;
  lines.splice(idx, 0, ...user);
  return lines.join('\n') + '\n';
}

// Deterministic fallback when the model cannot produce a valid Dockerfile.
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

async function generate(ctx: StepContext, c: Context): Promise<{ dockerfile: string; source: 'llm' | 'template'; problems: string[] }> {
  let feedback = '';
  for (let i = 0; i < 3; i++) {
    try {
      const raw = await chat(
        [
          { role: 'system', content: `You write production Dockerfiles.\n${RULES}` },
          { role: 'user', content: `Write a Dockerfile for this project.\n${describe(c)}${feedback}` },
        ],
        { signal: ctx.signal },
      );
      const df = ensureNonRoot(stripFences(raw));
      const problems = validate(df, c.analysis.port, c.allFiles);
      if (!problems.length) return { dockerfile: df, source: 'llm', problems };
      ctx.log(`model Dockerfile rejected: ${problems.join(', ')}`);
      feedback = `\n\nYour previous answer was invalid (${problems.join(', ')}). Return a complete Dockerfile.`;
    } catch (err) {
      ctx.log(`model unavailable: ${err instanceof Error ? err.message : err}`);
      break;
    }
  }
  ctx.log('falling back to the built-in template');
  return { dockerfile: template(c.analysis, c.files), source: 'template', problems: [] };
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
            'You review an existing Dockerfile against the project it builds. Check: dependencies installed correctly, ' +
            'start command matches the project entry point, port matches the app port, image size / dev dependencies / layer order. ' +
            'Reply with JSON only: {"valid": boolean, "issues": [{"severity": "error"|"warning", "message": string}], ' +
            '"suggestions": [string], "optimizedDockerfile": string|null}.',
        },
        { role: 'user', content: `Project:\n${describe(c)}\n\nExisting Dockerfile:\n${current}` },
      ],
      { signal: ctx.signal },
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
    ctx.log(`review skipped, model unavailable: ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
}

// Case 3 and doctor-loop retries: rewrite the Dockerfile from the failure log.
async function fix(ctx: StepContext, c: Context, current: string, failure: Failure, history: Failure[]): Promise<string | undefined> {
  const earlier = history
    .filter((h) => h !== failure && h.diagnosis)
    .map((h) => `- attempt ${h.attempt} (${h.node}): ${h.diagnosis!.rootCause} -> tried: ${h.diagnosis!.attemptedFix}`)
    .join('\n');
  const prompt =
    `The ${failure.node} step failed with this Dockerfile.\n\nProject:\n${describe(c)}\n\n` +
    `Current Dockerfile:\n${current}\n` +
    `Failure log (last lines):\n${scrub(tailLines(failure.error, 60), ctx.run)}\n\n` +
    (failure.diagnosis ? `Diagnosis: ${failure.diagnosis.rootCause}\nSuggested fix: ${failure.diagnosis.attemptedFix}\n\n` : '') +
    (earlier ? `Earlier attempts that did not fully work:\n${earlier}\n\n` : '') +
    'Return the complete corrected Dockerfile. Fix the root cause shown in the log: e.g. a wrong CMD/entry file, wrong port, ' +
    'or a dependency the code imports but the manifest lacks (install it explicitly in the Dockerfile, e.g. "RUN npm install <pkg>"). ' +
    'Do not change parts that are unrelated to the failure. Output ONLY the Dockerfile.';
  const messages: ChatMessage[] = [
    { role: 'system', content: `You fix broken Dockerfiles.\n${RULES}` },
    { role: 'user', content: prompt },
  ];
  for (let i = 0; i < 3; i++) {
    let df: string;
    try {
      df = stripFences(await chat(messages, { signal: ctx.signal, temperature: i === 0 ? 0.2 : 0.5 }));
    } catch (err) {
      ctx.log(`model unavailable: ${err instanceof Error ? err.message : err}`);
      return undefined;
    }
    const problems = validate(df, c.analysis.port, c.allFiles);
    if (df.trim() === current.trim()) problems.push('it is identical to the failing Dockerfile, so it would fail the same way');
    if (!problems.length) return df;
    ctx.log(`model fix rejected: ${problems.join('; ')}`);
    messages.push({ role: 'assistant', content: df }, { role: 'user', content: `That Dockerfile is not acceptable: ${problems.join('; ')}. Return a corrected complete Dockerfile only.` });
  }
  return undefined;
}

export const dockerfile: Step = {
  id: 'dockerfile',
  async run(ctx) {
    if (!ctx.run.analysis) return { ok: false, summary: 'No analysis available', error: 'analyze step has not run' };
    const c = await gather(ctx);
    const file = path.join(ctx.workdir, 'Dockerfile');
    const ignore = path.join(ctx.workdir, '.dockerignore');
    const state = failures.get(ctx.run);
    const failure = state?.pending;

    if (failure) {
      state!.pending = undefined;
      const current = ctx.run.dockerfile ?? (await readFile(file, 'utf8').catch(() => ''));
      ctx.log(`doctor loop attempt ${failure.attempt}: ${failure.node} failed — ${failure.diagnosis?.rootCause ?? 'see log'}`);
      let fixed = await fix(ctx, c, current, failure, state!.history);
      if (!fixed && c.analysis.dockerfile === 'missing') {
        const t = template(c.analysis, c.allFiles);
        if (t.trim() !== current.trim()) {
          ctx.log('model could not fix it; falling back to the built-in template');
          fixed = t;
        }
      }
      if (!fixed) {
        return {
          ok: false,
          summary: 'Could not produce a corrected Dockerfile',
          error: failure.error,
          diagnosis: { ...(failure.diagnosis ?? { rootCause: `${failure.node} failed`, evidence: tailLines(failure.error, 5) }), attemptedFix: 'Model could not produce a different valid Dockerfile', result: 'not-fixed', nextStep: 'Fix the Dockerfile manually using the diagnosis above.' },
        };
      }
      if (c.analysis.dockerfile === 'present' && !existsSync(`${file}.original`)) await copyFile(file, `${file}.original`).catch(() => {});
      await writeFile(file, fixed);
      ctx.run.dockerfile = fixed;
      for (const l of fixed.trimEnd().split('\n')) ctx.log(`  ${l}`);
      return {
        ok: true,
        summary: `Dockerfile rewritten (fix attempt ${failure.attempt})`,
        output: { mode: 'fixed', dockerfile: fixed, previous: current, fixing: failure.diagnosis },
      };
    }

    if (c.analysis.dockerfile === 'present') {
      const current = await readFile(file, 'utf8');
      ctx.run.dockerfile = current;
      ctx.log('existing Dockerfile found — keeping it, reviewing');
      const r = await review(ctx, c, current);
      for (const i of r?.issues ?? []) ctx.log(`${i.severity}: ${i.message}`);
      const local = validate(current, c.analysis.port).map((p) => ({ severity: 'warning' as const, message: p }));
      const issues = [...local, ...(r?.issues ?? [])];
      return {
        ok: true,
        summary: issues.length ? `Existing Dockerfile kept · ${issues.length} issue(s) flagged` : 'Existing Dockerfile kept · looks valid',
        output: { mode: 'existing', dockerfile: current, review: r && { ...r, issues }, suggestions: r?.suggestions ?? [], optimizedDockerfile: r?.optimizedDockerfile },
      };
    }

    ctx.log('no Dockerfile — generating one');
    const g = await generate(ctx, c);
    await writeFile(file, g.dockerfile);
    if (!existsSync(ignore)) await writeFile(ignore, DOCKERIGNORE);
    ctx.run.dockerfile = g.dockerfile;
    for (const l of g.dockerfile.trimEnd().split('\n')) ctx.log(`  ${l}`);
    return {
      ok: true,
      summary: `Dockerfile generated (${g.source === 'llm' ? 'model' : 'template'})`,
      output: { mode: 'generated', source: g.source, dockerfile: g.dockerfile, dockerignore: DOCKERIGNORE },
    };
  },
};
