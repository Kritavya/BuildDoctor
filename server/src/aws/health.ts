import type { Step, StepContext } from '../pipeline/step.js';
import type { Diagnosis } from '../types.js';
import { chatJson } from '../llm/ollama.js';
import { runShell } from './ssm.js';
import { authorizePorts, describeSg, portOpenToWorld } from './network.js';
import { appPort, errMsg, redact, sleep, timing } from './util.js';

type Probe = { ok: true; status: number } | { ok: false; detail: string };

async function probe(url: string, signal?: AbortSignal): Promise<Probe> {
  try {
    const timeout = AbortSignal.timeout(timing.healthRequestMs);
    const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'manual' });
    await res.body?.cancel().catch(() => {});
    return res.status < 500 ? { ok: true, status: res.status } : { ok: false, detail: `HTTP ${res.status}` };
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code;
    return { ok: false, detail: cause ?? errMsg(e) };
  }
}

export async function checkHttp(ctx: StepContext, url: string): Promise<Probe> {
  const start = Date.now();
  let last: Probe = { ok: false, detail: 'not attempted' };
  for (let i = 1; ; i++) {
    last = await probe(url, ctx.signal);
    if (last.ok) return last;
    const elapsed = Date.now() - start;
    ctx.log(`  attempt ${i}: ${last.detail} (${Math.round(elapsed / 1000)}s)`);
    if (elapsed >= timing.healthMs) return last;
    await sleep(timing.pollMs, ctx.signal);
  }
}

interface LlmDiagnosis extends Diagnosis {
  fixLevel?: 'runtime-config' | 'code' | 'infrastructure' | 'unknown';
  listenPort?: number | string | null;
  missingEnv?: unknown;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IGNORED_ENV = new Set(['PORT', 'NODE_ENV']);

// Env var names the evidence shows are required but were not provided. Names only: a model can
// flag a missing variable, never supply its value. Each name must appear in the evidence or in the
// names the code was seen to read, so a hallucinated name is dropped.
export function missingEnvNames(suggested: unknown, evidence: string, provided: Record<string, string> | undefined, known: string[]): string[] {
  const names = Array.isArray(suggested) ? suggested.filter((n): n is string => typeof n === 'string') : [];
  return [...new Set(names)]
    .filter((n) => ENV_NAME.test(n) && !IGNORED_ENV.has(n) && !(provided && n in provided))
    .filter((n) => known.includes(n) || new RegExp(`\\b${n}\\b`).test(evidence))
    .sort();
}

// The port the app really listens on, if the model found one in the evidence and it differs.
export function remappedPort(suggested: unknown, evidence: string, current: number): number | undefined {
  const p = Number(suggested);
  if (!Number.isInteger(p) || p < 1 || p > 65535 || p === 22 || p === current) return undefined;
  return new RegExp(`(^|[^0-9A-Za-z])${p}([^0-9A-Za-z]|$)`).test(evidence) ? p : undefined;
}

const SYSTEM = `You are a DevOps engineer diagnosing why a freshly deployed Docker container on AWS EC2 does not answer HTTP.
Reply with JSON only: {"rootCause": string, "evidence": string (quote the decisive log lines), "attemptedFix": string (the concrete fix to apply),
"result": "not-fixed", "nextStep": string, "fixLevel": "runtime-config" | "code" | "infrastructure" | "unknown",
"listenPort": number|null (the port the app inside the container actually listens on, only if the logs show it),
"missingEnv": [string] (names of required environment variables the logs show are missing; names only)}.
fixLevel "runtime-config" means redeploying the same image with different runtime settings (env vars, port mapping) fixes it.
"code" means the Dockerfile or application must change. "infrastructure" means AWS networking or instance capacity.`;

export const healthStep: Step = {
  id: 'health',
  async run(ctx) {
    const { run } = ctx;
    const region = run.config.aws.region;
    const { publicIp, instanceId, securityGroupId } = run.outputs;
    if (!publicIp || !instanceId) return { ok: false, summary: 'No instance', error: 'Missing publicIp/instanceId from earlier steps' };
    const port = appPort(run);
    const url = `http://${publicIp}:${port}/`;
    ctx.log(`Checking ${url}`);

    const result = await checkHttp(ctx, url);
    if (result.ok) {
      run.outputs.appUrl = url;
      ctx.log(`Healthy: HTTP ${result.status}`);
      return { ok: true, summary: `Live: HTTP ${result.status}`, output: { appUrl: url, status: result.status } };
    }

    ctx.log(`Unreachable after ${Math.round(timing.healthMs / 1000)}s (${result.detail}); collecting evidence...`);
    const env = run.config.env;

    // Security group first: deterministic and cheap.
    if (securityGroupId) {
      try {
        const sg = await describeSg(region, securityGroupId);
        if (!portOpenToWorld(sg, port)) {
          ctx.log(`Security group ${securityGroupId} does not allow tcp/${port}; adding it`);
          await authorizePorts(region, securityGroupId, [port], '0.0.0.0/0', 'BuildDoctor app port', run);
          const diagnosis: Diagnosis = {
            rootCause: `Security group ${securityGroupId} blocked inbound tcp/${port}`,
            evidence: `No ingress rule covering port ${port} from 0.0.0.0/0`,
            attemptedFix: `Added ingress tcp/${port} from 0.0.0.0/0`,
            result: 'not-fixed',
            nextStep: 'Redeploy and re-check health',
          };
          return { ok: false, summary: 'Port blocked by security group', error: result.detail, retryFrom: 'deploy', diagnosis };
        }
      } catch (e) {
        ctx.log(`Could not inspect security group: ${errMsg(e)}`);
      }
    }

    let evidence = '';
    try {
      const res = await runShell(region, instanceId,
        "echo '== docker ps -a'; docker ps -a; echo '== docker logs --tail 100 app'; docker logs --tail 100 app 2>&1; " +
        `echo '== listening sockets'; ss -ltnp 2>/dev/null | grep -E ':${port}\\b' || echo 'nothing listening on ${port}'`,
        { comment: `BuildDoctor diagnose ${run.id}`, timeoutMs: 60_000, signal: ctx.signal });
      evidence = redact(`${res.stdout}\n${res.stderr}`.trim(), env);
    } catch (e) {
      evidence = `Could not collect container state via SSM: ${errMsg(e)}`;
    }
    for (const l of evidence.split('\n').slice(-40)) ctx.log(l);

    const prompt = [
      `URL probed: ${url} -> ${result.detail}`,
      `Expected container port: ${port}`,
      run.analysis ? `Detected app: runtime=${run.analysis.runtime} framework=${run.analysis.framework ?? '?'} entry=${run.analysis.entryCommand ?? '?'} port=${run.analysis.port ?? '?'}` : '',
      `Env var names provided: ${Object.keys(env ?? {}).join(', ') || '(none)'}; expected by code: ${run.analysis?.envVars.join(', ') || '(unknown)'}`,
      `Security group allows tcp/${port}: yes`,
      `Container evidence:\n${evidence.slice(-6000)}`,
    ].filter(Boolean).join('\n');

    let diagnosis: LlmDiagnosis;
    try {
      diagnosis = await chatJson<LlmDiagnosis>([{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }], { signal: ctx.signal });
    } catch (e) {
      diagnosis = {
        rootCause: `Application not reachable on port ${port} (${result.detail})`,
        evidence: evidence.split('\n').slice(-10).join('\n'),
        attemptedFix: 'none (LLM diagnosis unavailable)',
        result: 'not-fixed',
        nextStep: 'Inspect the container logs above',
        fixLevel: 'unknown',
      };
      ctx.log(`LLM diagnosis failed: ${errMsg(e)}`);
    }
    const { fixLevel, listenPort, missingEnv, ...rest } = diagnosis;
    const clean: Diagnosis = {
      rootCause: redact(String(rest.rootCause ?? 'unknown'), env),
      evidence: redact(String(rest.evidence ?? ''), env),
      attemptedFix: redact(String(rest.attemptedFix ?? ''), env),
      result: 'not-fixed',
      nextStep: rest.nextStep ? redact(String(rest.nextStep), env) : undefined,
    };
    ctx.log(`Diagnosis (${fixLevel ?? 'unknown'}): ${clean.rootCause}`);
    const error = `${url} -> ${result.detail}`;

    // Missing env: only the user can supply the value, so stop and ask instead of retrying.
    const missing = missingEnvNames(missingEnv, evidence, env, run.analysis?.envVars ?? []);
    if (missing.length) {
      const list = missing.join(', ');
      return {
        ok: false,
        summary: `Missing env var(s): ${list}`,
        error,
        diagnosis: {
          ...clean,
          rootCause: `The app needs environment variable(s) that were not provided: ${list}`,
          attemptedFix: 'none (BuildDoctor never invents env values)',
          nextStep: `Please provide ${list} in the run's environment variables and start a new run.`,
        },
      };
    }

    // Port remap: redeploying with the same config would fail the same way, so retry only with a patch.
    const newPort = fixLevel === 'runtime-config' ? remappedPort(listenPort, evidence, port) : undefined;
    if (newPort) {
      ctx.log(`App appears to listen on ${newPort}, not ${port}; redeploying with port ${newPort}`);
      return {
        ok: false,
        summary: `App listens on ${newPort}, not ${port}`,
        error,
        retryFrom: 'deploy',
        patch: { appPort: newPort },
        diagnosis: { ...clean, attemptedFix: `Remap the container port from ${port} to ${newPort} and redeploy` },
      };
    }
    return { ok: false, summary: `Unhealthy: ${clean.rootCause}`.slice(0, 200), error, diagnosis: clean };
  },
};
