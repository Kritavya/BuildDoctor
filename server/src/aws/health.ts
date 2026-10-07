import type { Step, StepContext, StepResult } from '../pipeline/step.js';
import type { Diagnosis } from '../types.js';
import { chatJson } from '../llm/ollama.js';
import { envFor, serviceStatus } from '../steps/common.js';
import { runShell } from './ssm.js';
import { describeSg, ensureAppPort, portOpenToWorld } from './network.js';
import { deployServices, envLinks, frontService, type DeployService } from './services.js';
import { errMsg, redact, sleep, timing } from './util.js';

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

export async function checkHttp(ctx: StepContext, url: string, prefix = ''): Promise<Probe> {
  const start = Date.now();
  let last: Probe = { ok: false, detail: 'not attempted' };
  for (let i = 1; ; i++) {
    last = await probe(url, ctx.signal);
    if (last.ok) return last;
    const elapsed = Date.now() - start;
    ctx.log(`${prefix}  attempt ${i}: ${last.detail} (${Math.round(elapsed / 1000)}s)`);
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

// Why one service does not answer: security group first, then container evidence + the model.
// Single-service runs keep their original wording; multi-service runs name the service throughout.
async function diagnoseService(
  ctx: StepContext, svc: DeployService, services: DeployService[], url: string, detail: string,
): Promise<Extract<StepResult, { ok: false }>> {
  const { run } = ctx;
  const region = run.config.aws.region;
  const { instanceId, securityGroupId } = run.outputs;
  const multi = services.length > 1;
  const port = svc.port;
  const tag = multi ? `[${svc.name}] ` : '';
  const who = multi ? ` for ${svc.name}` : '';
  const only = multi ? { service: svc.name } : {};
  ctx.log(`${tag}Unreachable after ${Math.round(timing.healthMs / 1000)}s (${detail}); collecting evidence...`);
  const injected = multi ? envLinks(run, services, svc).injected : {};
  const env = envFor(run, svc.name);

  // Security group first: deterministic and cheap.
  if (securityGroupId) {
    try {
      const sg = await describeSg(region, securityGroupId);
      if (!portOpenToWorld(sg, port)) {
        const blocked = await ensureAppPort(run, port, ctx.log);
        if (blocked) {
          return { ok: false, summary: `${tag}Port blocked by your security group`, error: blocked, ...only,
            diagnosis: { rootCause: blocked, evidence: `No ingress rule covering port ${port} from 0.0.0.0/0`, attemptedFix: 'none', result: 'not-fixed', nextStep: `Open tcp/${port} on ${securityGroupId}, then start a new run.` } };
        }
        const diagnosis: Diagnosis = {
          rootCause: `Security group ${securityGroupId} blocked inbound tcp/${port}${who}`,
          evidence: `No ingress rule covering port ${port} from 0.0.0.0/0`,
          attemptedFix: `Added ingress tcp/${port} from 0.0.0.0/0`,
          result: 'not-fixed',
          nextStep: 'Redeploy and re-check health',
        };
        return { ok: false, summary: `${tag}Port blocked by security group`, error: detail, retryFrom: 'deploy', diagnosis, ...only };
      }
    } catch (e) {
      ctx.log(`Could not inspect security group: ${errMsg(e)}`);
    }
  }

  let evidence = '';
  try {
    const res = await runShell(region, instanceId!,
      `echo '== docker ps -a'; docker ps -a; echo '== docker logs --tail 100 ${svc.container}'; docker logs --tail 100 ${svc.container} 2>&1; ` +
      `echo '== listening sockets'; ss -ltnp 2>/dev/null | grep -E ':${port}\\b' || echo 'nothing listening on ${port}'`,
      { comment: `BuildDoctor diagnose ${run.id}`, timeoutMs: 60_000, signal: ctx.signal });
    evidence = redact(`${res.stdout}\n${res.stderr}`.trim(), run);
  } catch (e) {
    evidence = `Could not collect container state via SSM: ${errMsg(e)}`;
  }
  for (const l of evidence.split('\n').slice(-40)) ctx.log(`${tag}${l}`);

  const plan = run.analysis?.services?.find((p) => p.name === svc.name);
  const known = multi ? svc.envVars : run.analysis?.envVars ?? [];
  const providedNames = [...Object.keys(env), ...Object.keys(injected)];
  const prompt = [
    `URL probed: ${url} -> ${detail}`,
    `Expected container port: ${port}`,
    multi
      ? `Service: ${svc.name} (${svc.kind}${plan?.framework ? `, ${plan.framework}` : ''}, start=${plan?.startCommand ?? '?'}), container ${svc.container}, one of ${services.length} services on a shared Docker network: ${services.map((s) => `${s.container}:${s.port}`).join(', ')}`
      : run.analysis ? `Detected app: runtime=${run.analysis.runtime} framework=${run.analysis.framework ?? '?'} entry=${run.analysis.entryCommand ?? '?'} port=${run.analysis.port ?? '?'}` : '',
    `Env var names provided: ${providedNames.join(', ') || '(none)'}; expected by code: ${known.join(', ') || '(unknown)'}`,
    `Security group allows tcp/${port}: yes`,
    `Container evidence:\n${evidence.slice(-6000)}`,
  ].filter(Boolean).join('\n');

  let diagnosis: LlmDiagnosis;
  try {
    diagnosis = await chatJson<LlmDiagnosis>([{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }], { signal: ctx.signal });
  } catch (e) {
    diagnosis = {
      rootCause: `${multi ? `${svc.name}: ` : ''}Application not reachable on port ${port} (${detail})`,
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
    rootCause: redact(String(rest.rootCause ?? 'unknown'), run),
    evidence: redact(String(rest.evidence ?? ''), run),
    attemptedFix: redact(String(rest.attemptedFix ?? ''), run),
    result: 'not-fixed',
    nextStep: rest.nextStep ? redact(String(rest.nextStep), run) : undefined,
  };
  if (multi && !clean.rootCause.startsWith(`${svc.name}:`)) clean.rootCause = `${svc.name}: ${clean.rootCause}`;
  ctx.log(`${tag}Diagnosis (${fixLevel ?? 'unknown'}): ${clean.rootCause}`);
  const error = `${url} -> ${detail}`;

  // Missing env: only the user can supply the value, so stop and ask instead of retrying.
  const provided = Object.fromEntries(providedNames.map((n) => [n, '']));
  const missing = missingEnvNames(missingEnv, evidence, providedNames.length ? provided : run.config.env, known);
  if (missing.length) {
    const list = missing.join(', ');
    return {
      ok: false,
      summary: `${tag}Missing env var(s): ${list}`,
      error,
      ...only,
      diagnosis: {
        ...clean,
        rootCause: `The ${multi ? `${svc.name} service` : 'app'} needs environment variable(s) that were not provided: ${list}`,
        attemptedFix: 'none (BuildDoctor never invents env values)',
        nextStep: multi
          ? `Please provide ${list} for ${svc.name} in the run's per-service environment variables and start a new run.`
          : `Please provide ${list} in the run's environment variables and start a new run.`,
      },
    };
  }

  // Port remap: redeploying with the same config would fail the same way, so retry only with a patch.
  const newPort = fixLevel === 'runtime-config' ? remappedPort(listenPort, evidence, port) : undefined;
  if (newPort) {
    ctx.log(`${tag}App appears to listen on ${newPort}, not ${port}; redeploying with port ${newPort}`);
    return {
      ok: false,
      summary: `${tag}App listens on ${newPort}, not ${port}`,
      error,
      retryFrom: 'deploy',
      patch: multi ? { appPort: newPort, service: svc.name } : { appPort: newPort },
      ...only,
      diagnosis: { ...clean, attemptedFix: `Remap the ${multi ? `${svc.name} ` : ''}container port from ${port} to ${newPort} and redeploy` },
    };
  }
  return { ok: false, summary: `${tag}Unhealthy: ${clean.rootCause}`.slice(0, 200), error, diagnosis: clean, ...only };
}

export const healthStep: Step = {
  id: 'health',
  async run(ctx) {
    const { run } = ctx;
    const { publicIp, instanceId } = run.outputs;
    if (!publicIp || !instanceId) return { ok: false, summary: 'No instance', error: 'Missing publicIp/instanceId from earlier steps' };
    const services = deployServices(run);
    const urlOf = (s: DeployService) => `http://${publicIp}:${s.port}/`;

    if (services.length === 1) {
      const url = urlOf(services[0]);
      ctx.log(`Checking ${url}`);
      const result = await checkHttp(ctx, url);
      if (result.ok) {
        run.outputs.appUrl = url;
        ctx.log(`Healthy: HTTP ${result.status}`);
        return { ok: true, summary: `Live: HTTP ${result.status}`, output: { appUrl: url, status: result.status } };
      }
      return diagnoseService(ctx, services[0], services, url, result.detail);
    }

    // Every service's public port, in parallel so one slow service does not hold the others.
    for (const s of services) {
      ctx.log(`[${s.name}] Checking ${urlOf(s)}`);
      serviceStatus(ctx, 'health', true, s.name, 'running');
    }
    const results = await Promise.all(services.map((s) => checkHttp(ctx, urlOf(s), `[${s.name}]`)));
    const report: Record<string, { url: string; port: number; healthy: boolean; status?: number; detail?: string }> = {};
    services.forEach((s, i) => {
      const r = results[i];
      const url = urlOf(s);
      report[s.name] = { url, port: s.port, healthy: r.ok, ...(r.ok ? { status: r.status } : { detail: r.detail }) };
      run.outputs.services = { ...run.outputs.services, [s.name]: { ...run.outputs.services?.[s.name], port: s.port, container: s.container, url, healthy: r.ok } };
      if (r.ok) ctx.log(`[${s.name}] Healthy: HTTP ${r.status}`);
      serviceStatus(ctx, 'health', true, s.name, r.ok ? 'success' : 'failed', r.ok ? `HTTP ${r.status}` : r.detail);
    });

    const failed = services.filter((_, i) => !results[i].ok);
    if (!failed.length) {
      const front = frontService(services);
      run.outputs.appUrl = urlOf(front);
      return {
        ok: true,
        summary: `Live: ${services.length} services healthy`,
        output: { appUrl: run.outputs.appUrl, services: report },
      };
    }
    // Diagnose one service per pass; after its fix the next pass re-checks all of them.
    const svc = failed[0];
    if (failed.length > 1) ctx.log(`Also unreachable: ${failed.slice(1).map((s) => s.name).join(', ')} (diagnosed after ${svc.name})`);
    const res = await diagnoseService(ctx, svc, services, urlOf(svc), (results[services.indexOf(svc)] as { detail: string }).detail);
    return failed.length > 1 ? { ...res, summary: `${res.summary} (+${failed.length - 1} more unhealthy)`.slice(0, 220) } : res;
  },
};
