// Runs the built image locally and checks it stays up and answers on its port.
import net from 'node:net';
import type { Step, StepContext } from '../pipeline/step.js';
import { diagnose, docker, envFor, hash, scrub, serviceStatus, servicesOf, tailLines } from './common.js';

const TIMEOUT_MS = 30_000;

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

async function httpCheck(port: number): Promise<number | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000), redirect: 'manual' });
    await res.arrayBuffer().catch(() => {});
    return res.status;
  } catch {
    return undefined;
  }
}

// Docker's port proxy accepts connections even when nothing listens in the container and then
// drops them, so a TCP accept only counts if the connection stays open for a moment.
function tcpCheck(port: number, holdMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.once('connect', () => setTimeout(() => finish(true), holdMs));
    sock.once('close', () => finish(false));
    sock.once('end', () => finish(false));
    sock.once('error', () => finish(false));
    sock.setTimeout(2000, () => finish(false));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Ports the app says it is listening on (e.g. "Listening on http://0.0.0.0:5005"), from its own logs.
export function listeningPorts(logs: string): number[] {
  const out = new Set<number>();
  for (const line of logs.split('\n')) {
    if (!/(listen|running|started|serving|server|ready|local:|available|bound|uvicorn|gunicorn)/i.test(line) || /(refused|ECONN|connect(ing|ion)? to|timeout)/i.test(line)) continue;
    for (const m of line.matchAll(/(?:(?:localhost|0\.0\.0\.0|127\.0\.0\.1|\[::\]|::|\*):(\d{2,5})\b)|(?:\bport\s*:?\s*(\d{2,5})\b)/gi)) {
      const n = Number(m[1] ?? m[2]);
      if (n >= 80 && n <= 65535 && n !== 22) out.add(n);
    }
  }
  return [...out];
}

interface Verdict { ok: boolean; how?: 'http' | 'tcp'; status?: number; reason?: string }

async function probe(ctx: StepContext, image: string, name: string, port: number): Promise<{ verdict: Verdict; logs: string }> {
  const hostPort = await freePort();
  const env = envFor(ctx.run, name);
  ctx.log(`docker run -p ${hostPort}:${port} ${image} (env: ${Object.keys(env).join(', ')})`);
  const container = await docker.createContainer({
    Image: image,
    name: `builddoctor-smoke-${ctx.run.id}-${name}-${Date.now()}`,
    Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    Tty: true,
    ExposedPorts: { [`${port}/tcp`]: {} },
    HostConfig: { PortBindings: { [`${port}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(hostPort) }] } },
  });
  const logs = async () => scrub(((await container.logs({ stdout: true, stderr: true, tail: 200 })) as Buffer).toString('utf8').replace(/\r/g, ''), ctx.run);

  let verdict: Verdict = { ok: false };
  try {
    await container.start();
    const started = Date.now();
    let lastStatus: number | undefined;
    let tcpHits = 0;
    while (Date.now() - started < TIMEOUT_MS && !ctx.signal.aborted) {
      await sleep(1000);
      const state = (await container.inspect()).State;
      if (!state.Running) {
        verdict = { ok: false, reason: `container exited with code ${state.ExitCode}${state.OOMKilled ? ' (OOM killed)' : ''}` };
        break;
      }
      const status = await httpCheck(hostPort);
      if (status !== undefined) {
        lastStatus = status;
        if (status < 500) {
          verdict = { ok: true, how: 'http', status };
          break;
        }
        continue;
      }
      // Non-HTTP apps: accept a TCP connection that stays open, seen twice after a short warm-up.
      if (Date.now() - started > 5000 && (await tcpCheck(hostPort))) {
        if (++tcpHits >= 2) {
          verdict = { ok: true, how: 'tcp' };
          break;
        }
      }
    }
    if (!verdict.ok && !verdict.reason) {
      verdict.reason = lastStatus !== undefined
        ? `port ${port} answered HTTP ${lastStatus} for ${TIMEOUT_MS / 1000}s`
        : `nothing answered on port ${port} within ${TIMEOUT_MS / 1000}s`;
    }
    // Give the app a moment to settle so a crash right after the first response is caught.
    if (verdict.ok) {
      await sleep(1500);
      const state = (await container.inspect()).State;
      if (!state.Running) verdict = { ok: false, reason: `container exited with code ${state.ExitCode} right after responding` };
    }
  } catch (err) {
    verdict = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  let out = '';
  try {
    out = await logs();
  } catch {
    // container may already be gone
  }
  await container.remove({ force: true }).catch(() => {});
  return { verdict, logs: out };
}

export const smoke: Step = {
  id: 'smoke',
  async run(ctx) {
    const services = servicesOf(ctx.run);
    if (!services.length) return { ok: false, summary: 'Unknown app port', error: 'no port from analysis or config' };
    const many = services.length > 1;
    const outputs: Record<string, unknown> = {};
    for (const { plan, state, image, primary } of services) {
      const h = hash(state.dockerfile ?? '');
      const port = primary ? ctx.run.config.appPort ?? plan.port : plan.port;
      if (state.smoke?.status === 'success' && state.smoke.hash === `${h}:${port}`) continue;
      const tag = many ? `[${plan.name}] ` : '';
      serviceStatus(ctx, 'smoke', many, plan.name, 'running');
      const { verdict, logs } = await probe(ctx, image, plan.name, port);
      for (const l of tailLines(logs, 40).split('\n')) if (l) ctx.log(`${tag}[app] ${l}`);
      if (verdict.ok) {
        const how = verdict.how === 'http' ? `HTTP ${verdict.status}` : 'TCP accept (no HTTP response; treating as a non-HTTP service)';
        state.smoke = { status: 'success', summary: `port ${port} answered ${how}`, hash: `${h}:${port}` };
        serviceStatus(ctx, 'smoke', many, plan.name, 'success', state.smoke.summary);
        outputs[plan.name] = { port, check: verdict.how, status: verdict.status, logs: tailLines(logs, 40) };
        continue;
      }
      state.smoke = { status: 'failed', summary: verdict.reason, hash: `${h}:${port}` };
      serviceStatus(ctx, 'smoke', many, plan.name, 'failed', verdict.reason);
      let evidence = `${verdict.reason}\n--- container logs ---\n${tailLines(logs, 60) || '(no output)'}`;
      // A clean exit means the start command returned: it daemonised, or it is a one-off task, not the server.
      if (/exited with code 0\b/.test(verdict.reason ?? '')) {
        evidence = `The start command exited with code 0 instead of staying in the foreground: it backgrounds the server (a daemonising process manager) or is not the server process. Start the server process itself in the foreground.\n${evidence}`;
      }
      ctx.log(`${tag}smoke test failed: ${verdict.reason}`);
      // The app says it listens elsewhere: re-plan the port (no user override in play) and let the fix follow it.
      const heard = listeningPorts(logs).filter((p) => p !== port);
      if (heard.length === 1 && !(primary && ctx.run.config.appPort)) {
        ctx.log(`${tag}app logs show it listening on port ${heard[0]}, not ${port}; updating the plan`);
        evidence = `The app listens on port ${heard[0]} (from its logs), but the plan expected ${port}. The service port is now ${heard[0]}.\n${evidence}`;
        plan.port = heard[0];
        plan.portEvidence = `container logs: listening on ${heard[0]}`;
        if (primary && ctx.run.analysis) ctx.run.analysis.port = heard[0];
      }
      ctx.log('diagnosing...');
      const diagnosis = await diagnose(ctx.run, 'smoke', `Expected the app to listen on port ${port}.\n${evidence}`, ctx.signal, { plan, dockerfile: state.dockerfile });
      return { ok: false, summary: `${tag}Smoke test failed: ${verdict.reason}`, error: evidence, retryFrom: 'dockerfile', diagnosis, service: plan.name };
    }
    const p = services[0];
    const primaryOut = (outputs[p.plan.name] ?? { port: p.plan.port }) as Record<string, unknown>;
    return {
      ok: true,
      summary: many ? `${services.length} containers up · ${services.map((s) => `${s.plan.name} :${s.plan.port}`).join(', ')}` : `Container up · ${p.state.smoke?.summary ?? ''}`,
      output: { ...primaryOut, services: outputs },
    };
  },
};
