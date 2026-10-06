import type { RunState } from '../types.js';

// Poll/wait knobs. Tests shrink these to 0.
export const timing = {
  pollMs: 5_000,
  instanceRunningMs: 3 * 60_000,
  ssmOnlineMs: 5 * 60_000,
  commandMs: 10 * 60_000,
  healthMs: 90_000,
  healthRequestMs: 5_000,
  terminateMs: 5 * 60_000,
  sgDeleteMs: 3 * 60_000,
  profileRetries: 12,
};

export const DASHBOARD_PORTS = { metrics: 18080, logs: 18081 } as const;
export const DASHBOARD_RULE_DESC = 'BuildDoctor dashboard';
export const ROLE_NAME = 'BuildDoctorEC2Role';

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(t); reject(new Error('aborted')); };
    // Remove the listener on resolve: long polls would otherwise pile listeners onto the run's signal.
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Polls `check` until it returns a non-undefined value or the deadline passes.
export async function poll<T>(
  check: () => Promise<T | undefined>,
  opts: { timeoutMs: number; what: string; signal?: AbortSignal; onWait?: (elapsedMs: number) => void },
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await check();
    if (v !== undefined) return v;
    const elapsed = Date.now() - start;
    if (elapsed >= opts.timeoutMs) throw new Error(`Timed out after ${Math.round(elapsed / 1000)}s waiting for ${opts.what}`);
    opts.onWait?.(elapsed);
    await sleep(timing.pollMs, opts.signal);
  }
}

export function errName(e: unknown): string {
  const err = e as { name?: string; Code?: string; code?: string };
  return err?.name ?? err?.Code ?? err?.code ?? '';
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function tags(runId: string, name?: string) {
  const t = [
    { Key: 'Project', Value: 'BuildDoctor' },
    { Key: 'RunId', Value: runId },
  ];
  if (name) t.push({ Key: 'Name', Value: name });
  return t;
}

export function hasRunTag(t: Array<{ Key?: string; Value?: string }> | undefined, runId: string): boolean {
  const map = new Map((t ?? []).map((x) => [x.Key, x.Value]));
  return map.get('Project') === 'BuildDoctor' && map.get('RunId') === runId;
}

// "https://github.com/Foo/My_App.git" -> "my_app"
export function repoSlug(repoUrl: string): string {
  const last = repoUrl.replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop() ?? 'app';
  const s = last.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  return (s || 'app').slice(0, 200);
}

export function appPort(run: RunState): number {
  return run.config.appPort ?? run.analysis?.port ?? 3000;
}

export function recordCreated(run: RunState, type: RunState['outputs']['created'][number]['type'], id: string): void {
  if (!run.outputs.created.some((c) => c.type === type && c.id === id)) run.outputs.created.push({ type, id });
}

export function sgRuleId(groupId: string, port: number, cidr: string): string {
  return `${groupId}:${port}:${cidr}`;
}

export function parseSgRuleId(id: string): { groupId: string; port: number; cidr: string } {
  const [groupId, port, cidr] = id.split(':');
  return { groupId, port: Number(port), cidr };
}

export function forgetCreated(run: RunState, type: RunState['outputs']['created'][number]['type'], id: string): void {
  run.outputs.created = run.outputs.created.filter((c) => !(c.type === type && c.id === id));
}

export function wasCreated(run: RunState, type: RunState['outputs']['created'][number]['type'], id?: string): boolean {
  return !!id && run.outputs.created.some((c) => c.type === type && c.id === id);
}

// Rate-limits noisy progress lines; distinct messages per key, at most one per interval.
export function throttledLogger(log: (l: string) => void, intervalMs = 2_000) {
  const last = new Map<string, { at: number; msg: string }>();
  return (key: string, msg: string, force = false) => {
    const prev = last.get(key);
    const now = Date.now();
    if (!force && prev && (prev.msg === msg || now - prev.at < intervalMs)) return;
    last.set(key, { at: now, msg });
    log(msg);
  };
}

// Masks configured env values in text that leaves the host (logs, LLM prompts).
export function redact(text: string, env: Record<string, string> | undefined): string {
  let out = text;
  for (const v of Object.values(env ?? {})) if (v && v.length >= 4) out = out.split(v).join('***');
  return out;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
