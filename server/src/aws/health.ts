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
}

const SYSTEM = `You are a DevOps engineer diagnosing why a freshly deployed Docker container on AWS EC2 does not answer HTTP.
Reply with JSON only: {"rootCause": string, "evidence": string (quote the decisive log lines), "attemptedFix": string (the concrete fix to apply),
"result": "not-fixed", "nextStep": string, "fixLevel": "runtime-config" | "code" | "infrastructure" | "unknown"}.
fixLevel "runtime-config" means redeploying the same image with different runtime settings (env vars, port mapping, restart) fixes it.
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
    const { fixLevel, ...rest } = diagnosis;
    const clean: Diagnosis = {
      rootCause: redact(String(rest.rootCause ?? 'unknown'), env),
      evidence: redact(String(rest.evidence ?? ''), env),
      attemptedFix: redact(String(rest.attemptedFix ?? ''), env),
      result: 'not-fixed',
      nextStep: rest.nextStep ? redact(String(rest.nextStep), env) : undefined,
    };
    ctx.log(`Diagnosis (${fixLevel ?? 'unknown'}): ${clean.rootCause}`);
    return {
      ok: false,
      summary: `Unhealthy: ${clean.rootCause}`.slice(0, 200),
      error: `${url} -> ${result.detail}`,
      diagnosis: clean,
      ...(fixLevel === 'runtime-config' ? { retryFrom: 'deploy' as const } : {}),
    };
  },
};
