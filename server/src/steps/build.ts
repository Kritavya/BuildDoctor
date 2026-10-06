// docker build via the Engine API, native arch (arm64 here, matching the t4g deploy target).
import os from 'node:os';
import type { Step } from '../pipeline/step.js';
import { diagnose, docker, imageTag, scrub, tailLines, walk } from './common.js';

const platform = () => `linux/${os.arch() === 'arm64' ? 'arm64' : 'amd64'}`;

export const build: Step = {
  id: 'build',
  async run(ctx) {
    const tag = imageTag(ctx.run.id);
    const lines: string[] = [];
    const push = (l: string) => {
      const line = scrub(l.replace(/\x1b\[[0-9;]*m/g, '').trimEnd(), ctx.run);
      if (!line) return;
      lines.push(line);
      ctx.log(line);
    };
    const started = Date.now();
    let error: string | undefined;
    try {
      const src = await walk(ctx.workdir, 50_000, new Set(['.git']));
      const stream = await docker.buildImage({ context: ctx.workdir, src }, { t: tag, platform: platform(), rm: true, forcerm: true, abortSignal: ctx.signal });
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
      ctx.log('diagnosing build failure...');
      const diagnosis = await diagnose(ctx.run, 'build', logTail, ctx.signal);
      return { ok: false, summary: `Build failed: ${error.split('\n')[0].slice(0, 120)}`, error: logTail, retryFrom: 'dockerfile', diagnosis };
    }
    const info = await docker.getImage(tag).inspect();
    const mb = Math.round(info.Size / 1e6);
    return {
      ok: true,
      summary: `Built ${tag} · ${mb} MB · ${Math.round((Date.now() - started) / 1000)}s`,
      output: { image: tag, imageId: info.Id, sizeMb: mb, arch: info.Architecture, layers: info.RootFS?.Layers?.length },
    };
  },
};
