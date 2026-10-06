// Helpers shared by the local steps: file walking, LLM output cleanup and failure diagnosis.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import Docker from 'dockerode';
import { chatJson } from '../llm/ollama.js';
import type { Diagnosis, RunState } from '../types.js';

export const docker = new Docker();

export const imageTag = (runId: string) => `builddoctor/${runId}:latest`;

const SKIP_DIRS = new Set(['node_modules', '.git', 'venv', '.venv', 'env', '__pycache__', 'dist', 'build', '.next', 'vendor', 'target', 'coverage']);

// Relative paths of files under dir (skips dependency/build dirs), capped.
export async function walk(dir: string, limit = 500, skip: Set<string> = SKIP_DIRS): Promise<string[]> {
  const out: string[] = [];
  async function go(rel: string): Promise<void> {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = await readdir(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!skip.has(e.name)) await go(p);
      } else if (e.isFile()) out.push(p);
    }
  }
  await go('');
  return out.sort();
}

export async function readText(file: string, maxBytes = 200_000): Promise<string | undefined> {
  try {
    if ((await stat(file)).size > maxBytes) return undefined;
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

// Files whose contents must never leave the machine (they hold env values / secrets).
export const isSecretFile = (f: string) => /(^|\/)\.env(\.|$)|\.pem$|\.key$|id_rsa/.test(f);

export function stripFences(s: string): string {
  const m = s.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  return (m ? m[1] : s).trim() + '\n';
}

export function tailLines(text: string, n: number): string {
  return text.split('\n').filter((l) => l.trim()).slice(-n).join('\n');
}

// Replace any configured env value that shows up in a log before it reaches the LLM or the UI.
export function scrub(text: string, run: RunState): string {
  let out = text;
  for (const v of Object.values(run.config.env ?? {})) if (v && v.length >= 3) out = out.split(v).join('***');
  return out;
}

// LLM root-cause report from a log tail. Falls back to a plain report if the model is unavailable.
export async function diagnose(
  run: RunState,
  stage: 'lint' | 'build' | 'smoke',
  logTail: string,
  signal?: AbortSignal,
): Promise<Diagnosis> {
  const safeLog = scrub(logTail, run);
  try {
    const d = await chatJson<Partial<Diagnosis>>(
      [
        {
          role: 'system',
          content:
            'You are a DevOps engineer diagnosing a failed Docker ' + stage + ' step. Reply with JSON only: ' +
            '{"rootCause": one sentence, "evidence": the 1-3 most relevant log lines quoted verbatim, ' +
            '"attemptedFix": the concrete Dockerfile change you recommend, "nextStep": one sentence}.',
        },
        {
          role: 'user',
          content:
            `Project: ${JSON.stringify(run.analysis ?? {})}\n\nDockerfile:\n${run.dockerfile ?? '(none)'}\n\n` +
            `Failure log (last lines):\n${safeLog}`,
        },
      ],
      { signal },
    );
    return {
      rootCause: str(d.rootCause) || `${stage} failed`,
      evidence: str(d.evidence) || tailLines(safeLog, 5),
      attemptedFix: str(d.attemptedFix) || 'Regenerate the Dockerfile from the error log',
      result: 'not-fixed',
      nextStep: str(d.nextStep) || undefined,
    };
  } catch {
    return {
      rootCause: `${stage} failed`,
      evidence: tailLines(safeLog, 5),
      attemptedFix: 'Regenerate the Dockerfile from the error log',
      result: 'not-fixed',
    };
  }
}

function str(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return v.map(String).join('\n');
  return v == null ? '' : JSON.stringify(v);
}
