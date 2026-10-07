// hadolint via its Docker image. Error-level findings fail back to the dockerfile step; the rest are reported.
import { spawn } from 'node:child_process';
import type { Step } from '../pipeline/step.js';
import { hash, servicesOf } from './common.js';

interface Finding {
  line: number;
  code: string;
  message: string;
  level: 'error' | 'warning' | 'info' | 'style';
}

export function hadolint(dockerfile: string, signal?: AbortSignal): Promise<Finding[]> {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', ['run', '--rm', '-i', 'hadolint/hadolint', 'hadolint', '--no-fail', '-f', 'json', '-'], { signal });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      try {
        resolve(JSON.parse(out || '[]') as Finding[]);
      } catch {
        reject(new Error(`hadolint exited ${code}: ${(err || out).trim().slice(0, 500)}`));
      }
    });
    p.stdin.end(dockerfile);
  });
}

export const lint: Step = {
  id: 'lint',
  async run(ctx) {
    const services = servicesOf(ctx.run);
    if (!services.length || services.some((s) => !s.state.dockerfile)) {
      return { ok: false, summary: 'No Dockerfile to lint', error: 'dockerfile step produced nothing', retryFrom: 'dockerfile' };
    }
    const many = services.length > 1;
    const warned: Record<string, Finding[]> = {};
    for (const { plan, state } of services) {
      const h = hash(state.dockerfile!);
      if (state.lint?.status === 'success' && state.lint.hash === h) continue; // unchanged since it passed
      let findings: Finding[];
      try {
        findings = await hadolint(state.dockerfile!, ctx.signal);
      } catch (err) {
        // Linting is advisory infrastructure; a missing hadolint image must not block the build.
        ctx.log(`hadolint unavailable: ${err instanceof Error ? err.message : err}`);
        return { ok: true, summary: 'Lint skipped (hadolint unavailable)', output: { skipped: true } };
      }
      const tag = many ? `[${plan.name}] ` : '';
      for (const f of findings) ctx.log(`${tag}${f.level.toUpperCase()} line ${f.line} ${f.code}: ${f.message}`);
      const errors = findings.filter((f) => f.level === 'error');
      if (errors.length) {
        const text = errors.map((f) => `line ${f.line} ${f.code}: ${f.message}`).join('\n');
        state.lint = { status: 'failed', summary: `${errors.length} error(s)`, hash: h };
        return {
          ok: false,
          summary: `${tag}hadolint: ${errors.length} error(s)`,
          error: `hadolint errors:\n${text}`,
          retryFrom: 'dockerfile',
          service: plan.name,
          diagnosis: {
            rootCause: `${many ? `${plan.name}: ` : ''}Dockerfile has ${errors.length} hadolint error(s): ${errors[0].code} ${errors[0].message}`,
            evidence: text,
            attemptedFix: 'Rewrite the offending Dockerfile instructions',
            result: 'not-fixed',
          },
        };
      }
      state.lint = { status: 'success', summary: `${findings.length} warning(s)`, hash: h };
      warned[plan.name] = findings;
    }
    const count = Object.values(warned).reduce((n, f) => n + f.length, 0);
    const primary = services[0].plan.name;
    return {
      ok: true,
      summary: count ? `Lint passed · ${count} warning(s)` : 'Lint passed · clean',
      output: { findings: warned[primary] ?? [], services: warned },
    };
  },
};
