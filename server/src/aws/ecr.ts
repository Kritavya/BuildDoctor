import Docker from 'dockerode';
import {
  CreateRepositoryCommand,
  DescribeRepositoriesCommand,
  GetAuthorizationTokenCommand,
} from '@aws-sdk/client-ecr';
import type { Step, StepContext } from '../pipeline/step.js';
import { clients } from './clients.js';
import { deployServices } from './services.js';
import { errMsg, errName, recordCreated, repoSlug, tags, throttledLogger } from './util.js';

// Swappable in tests.
export const dockerFactory = { create: (): Docker => new Docker() };

export function repoName(repoUrl: string): string {
  return `builddoctor/${repoSlug(repoUrl)}`;
}

async function ensureRepo(ctx: StepContext): Promise<string> {
  const { run } = ctx;
  const { ecr } = clients(run.config.aws.region);
  const name = repoName(run.config.repoUrl);
  try {
    const res = await ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [name] }));
    ctx.log(`Reusing ECR repository ${name}`);
    return res.repositories![0].repositoryUri!;
  } catch (e) {
    if (errName(e) !== 'RepositoryNotFoundException') throw e;
  }
  const res = await ecr.send(new CreateRepositoryCommand({
    repositoryName: name,
    imageTagMutability: 'MUTABLE',
    tags: tags(run.id),
  }));
  recordCreated(run, 'ecr', name);
  ctx.log(`Created ECR repository ${name}`);
  return res.repository!.repositoryUri!;
}

interface RegistryAuth { username: string; password: string; serveraddress: string }

async function registryAuth(ctx: StepContext, repoUri: string): Promise<RegistryAuth> {
  const { ecr } = clients(ctx.run.config.aws.region);
  const auth = (await ecr.send(new GetAuthorizationTokenCommand({}))).authorizationData?.[0];
  if (!auth?.authorizationToken) throw new Error('ECR returned no authorization token');
  const [username, password] = Buffer.from(auth.authorizationToken, 'base64').toString().split(':');
  return { username, password, serveraddress: auth.proxyEndpoint ?? `https://${repoUri.split('/')[0]}` };
}

// Tags the local image as <repoUri>:<tag> and pushes it.
async function pushImage(ctx: StepContext, repoUri: string, local: string, tag: string, authconfig: RegistryAuth, prefix = ''): Promise<string> {
  const docker = dockerFactory.create();
  await docker.getImage(local).tag({ repo: repoUri, tag });
  ctx.log(`${prefix}Tagged ${local} as ${repoUri}:${tag}; pushing...`);

  const stream = await docker.getImage(`${repoUri}:${tag}`).push({ tag, authconfig });
  const tlog = throttledLogger(ctx.log);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      stream,
      (err: Error | null, events: Array<{ error?: string }>) => {
        const failed = err?.message ?? events?.find((ev) => ev.error)?.error;
        if (failed) reject(new Error(`${prefix}docker push failed: ${failed}`));
        else resolve();
      },
      (ev: { id?: string; status?: string; progress?: string; error?: string }) => {
        if (ev.error) return ctx.log(`${prefix}push error: ${ev.error}`);
        if (!ev.status) return;
        const line = ev.id ? `${prefix}${ev.id}: ${ev.status}${ev.progress ? ' ' + ev.progress : ''}` : `${prefix}${ev.status}`;
        // Status transitions always show; byte-progress updates are throttled.
        tlog(`${prefix}${ev.id ?? 'push'}`, line, !ev.progress);
      },
    );
  });
  return `${repoUri}:${tag}`;
}

// One repository per source repo; every service image goes in it (see deployServices for the tags).
export const ecrStep: Step = {
  id: 'ecr',
  async run(ctx) {
    const { run } = ctx;
    const services = deployServices(run);
    const multi = services.length > 1;
    try {
      const repoUri = await ensureRepo(ctx);
      run.outputs.ecrRepoUri = repoUri;
      const auth = await registryAuth(ctx, repoUri);
      const pushed: Record<string, string> = {};
      for (const s of services) {
        const uri = await pushImage(ctx, repoUri, s.localImage, s.tag, auth, multi ? `[${s.name}] ` : '');
        pushed[s.name] = uri;
        if (s.primary) run.outputs.imageUri = uri;
        if (multi) {
          run.outputs.services = { ...run.outputs.services, [s.name]: { ...run.outputs.services?.[s.name], port: s.port, container: s.container, imageUri: uri } };
        }
      }
      const imageUri = run.outputs.imageUri!;
      if (!multi) return { ok: true, summary: `Pushed ${imageUri.split('/').pop()}`, output: { ecrRepoUri: repoUri, imageUri } };
      return {
        ok: true,
        summary: `Pushed ${services.length} images · ${services.map((s) => `${s.name}`).join(', ')}`,
        output: { ecrRepoUri: repoUri, imageUri, services: pushed },
      };
    } catch (e) {
      return { ok: false, summary: 'ECR push failed', error: errMsg(e) };
    }
  },
};
