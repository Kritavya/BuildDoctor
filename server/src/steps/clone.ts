// Shallow-clones the repository into workspaces/<runId>/repo.
import { rm, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import type { Step } from '../pipeline/step.js';

export const clone: Step = {
  id: 'clone',
  async run(ctx) {
    const { repoUrl, branch } = ctx.run.config;
    await rm(ctx.workdir, { recursive: true, force: true });
    await mkdir(path.dirname(ctx.workdir), { recursive: true });
    ctx.log(`git clone --depth 1${branch ? ` --branch ${branch}` : ''} ${redact(repoUrl)}`);
    const args = ['--depth', '1', ...(branch ? ['--branch', branch] : [])];
    try {
      await simpleGit({ abort: ctx.signal, allowEnvironment: ['GIT_TERMINAL_PROMPT'] }).env(gitEnv()).clone(repoUrl, ctx.workdir, args);
    } catch (err) {
      const msg = redact(err instanceof Error ? err.message : String(err));
      return {
        ok: false,
        summary: 'Clone failed',
        error: msg,
        diagnosis: {
          rootCause: /not found|could not read|authentication/i.test(msg)
            ? 'Repository not found or not accessible (private repos need credentials)'
            : 'git clone failed',
          evidence: msg.split('\n').slice(-5).join('\n'),
          attemptedFix: 'none',
          result: 'not-fixed',
          nextStep: 'Check the repository URL and branch, and that the repo is public.',
        },
      };
    }
    const git = simpleGit(ctx.workdir);
    const [commit, files] = await Promise.all([git.revparse(['HEAD']), readdir(ctx.workdir)]);
    const ref = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    ctx.log(`checked out ${ref} @ ${commit.slice(0, 7)}`);
    return {
      ok: true,
      summary: `Cloned ${ref} @ ${commit.slice(0, 7)}`,
      output: { branch: ref, commit, topLevel: files.filter((f) => f !== '.git').sort() },
    };
  },
};

// Minimal env: never prompt for credentials (private repos fail fast instead of hanging).
function gitEnv(): Record<string, string> {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSH_AUTH_SOCK'];
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

// Hide credentials embedded in https URLs.
function redact(s: string): string {
  return s.replace(/(https?:\/\/)[^@\s/]+@/g, '$1***@');
}
