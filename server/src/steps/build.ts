// docker build via the Engine API, pinned to linux/arm64 to match the t4g (Graviton) deploy target.
import os from 'node:os';
import path from 'node:path';
import type { Step } from '../pipeline/step.js';
import { diagnose, docker, hash, scrub, servicesOf, tailLines, walk } from './common.js';

export const PLATFORM = 'linux/arm64';

export const build: Step = {
  id: 'build',
  async run(ctx) {
    const services = servicesOf(ctx.run);
    const outputs: Record<string, unknown> = {};
    const many = services.length > 1;
    if (os.arch() !== 'arm64') ctx.log(`warning: host is ${os.arch()}; building ${PLATFORM} under emulation (slower; needs QEMU/binfmt)`);
    for (const { plan, state, image } of services) {
      const h = hash(state.dockerfile ?? '');
      if (state.build?.status === 'success' && state.build.hash === h) continue; // image is current
      const tag = many ? `[${plan.name}] ` : '';
      const lines: string[] = [];
      const push = (l: string) => {
        const line = scrub(l.replace(/\x1b\[[0-9;]*m/g, '').trimEnd(), ctx.run);
        if (!line) return;
        lines.push(line);
        ctx.log(`${tag}${line}`);
      };
      const started = Date.now();
      let error: string | undefined;
      try {
        const contextDir = path.join(ctx.workdir, plan.context);
        const dockerfile = path.posix.relative(plan.context === '.' ? '' : plan.context, plan.dockerfile);
        const src = await walk(contextDir, 50_000, new Set(['.git']));
        const stream = await docker.buildImage({ context: contextDir, src }, { t: image, dockerfile, platform: PLATFORM, rm: true, forcerm: true, abortSignal: ctx.signal });
        await new Promise<void>((resolve, reject) => {
          docker.modem.followProgress(
            stream,
            (err) => (err ? reject(err) : resolve()),
            (ev: { stream?: string; status?: string; error?: string; errorDetail?: { message?: string } }) => {
              if (ev.stream) ev.stream.split('\n').forEach(push);
              else if (ev.status) push(ev.status);
              if (ev.error) {
                error = ev.errorDetail?.message ?? ev.error;
                push(`ERROR: ${error}`);
              }
            },
          );
        });
      } catch (err) {
        error ??= err instanceof Error ? err.message : String(err);
        push(`ERROR: ${error}`);
      }

      if (error) {
        const logTail = tailLines(lines.join('\n'), 80);
        state.build = { status: 'failed', summary: error.split('\n')[0].slice(0, 120), hash: h };
        ctx.log('diagnosing build failure...');
        const diagnosis = await diagnose(ctx.run, 'build', logTail, ctx.signal, { plan, dockerfile: state.dockerfile });
        return { ok: false, summary: `${tag}Build failed: ${error.split('\n')[0].slice(0, 120)}`, error: logTail, retryFrom: 'dockerfile', diagnosis, service: plan.name };
      }
      const info = await docker.getImage(image).inspect();
      const mb = Math.round(info.Size / 1e6);
      state.build = { status: 'success', summary: `${mb} MB · ${Math.round((Date.now() - started) / 1000)}s`, hash: h };
      outputs[plan.name] = { image, imageId: info.Id, sizeMb: mb, arch: info.Architecture, layers: info.RootFS?.Layers?.length };
    }
    const p = services[0];
    const primaryOut = (outputs[p.plan.name] ?? { image: p.image }) as Record<string, unknown>;
    return {
      ok: true,
      summary: many ? `Built ${services.length} images · ${services.map((s) => `${s.plan.name} ${s.state.build?.summary ?? ''}`).join(', ')}` : `Built ${p.image} · ${p.state.build?.summary ?? ''}`,
      output: { ...primaryOut, services: outputs },
    };
  },
};
