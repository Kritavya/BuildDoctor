// Runs the built image locally and checks it stays up and answers on its port.
import net from 'node:net';
import type { Step } from '../pipeline/step.js';
import { diagnose, docker, imageTag, scrub, tailLines } from './common.js';

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

export const smoke: Step = {
  id: 'smoke',
  async run(ctx) {
    const port = ctx.run.config.appPort ?? ctx.run.analysis?.port;
    if (!port) return { ok: false, summary: 'Unknown app port', error: 'no port from analysis or config' };
    const hostPort = await freePort();
    const env = ctx.run.config.env ?? {};
    ctx.log(`docker run -p ${hostPort}:${port} ${imageTag(ctx.run.id)} (env: ${Object.keys(env).join(', ')})`);

    const container = await docker.createContainer({
      Image: imageTag(ctx.run.id),
      name: `builddoctor-smoke-${ctx.run.id}-${Date.now()}`,
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      Tty: true,
      ExposedPorts: { [`${port}/tcp`]: {} },
      HostConfig: { PortBindings: { [`${port}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(hostPort) }] } },
    });
    const logs = async () => scrub(((await container.logs({ stdout: true, stderr: true, tail: 200 })) as Buffer).toString('utf8').replace(/\r/g, ''), ctx.run);

    let verdict: { ok: boolean; how?: 'http' | 'tcp'; status?: number; reason?: string } = { ok: false };
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
    for (const l of tailLines(out, 40).split('\n')) if (l) ctx.log(`[app] ${l}`);
    await container.remove({ force: true }).catch(() => {});

    if (verdict.ok) {
      const how = verdict.how === 'http' ? `HTTP ${verdict.status}` : 'TCP accept (no HTTP response; treating as a non-HTTP service)';
      return { ok: true, summary: `Container up · port ${port} answered ${how}`, output: { port, check: verdict.how, status: verdict.status, logs: tailLines(out, 40) } };
    }
    const evidence = `${verdict.reason}\n--- container logs ---\n${tailLines(out, 60) || '(no output)'}`;
    ctx.log(`smoke test failed: ${verdict.reason}`);
    ctx.log('diagnosing...');
    const diagnosis = await diagnose(ctx.run, 'smoke', `Expected the app to listen on port ${port}.\n${evidence}`, ctx.signal);
    return { ok: false, summary: `Smoke test failed: ${verdict.reason}`, error: evidence, retryFrom: 'dockerfile', diagnosis };
  },
};
