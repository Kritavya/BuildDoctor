import Docker from 'dockerode';
import {
  CreateRepositoryCommand,
  DescribeRepositoriesCommand,
  GetAuthorizationTokenCommand,
} from '@aws-sdk/client-ecr';
import type { Step, StepContext } from '../pipeline/step.js';
import { clients } from './clients.js';
import { imageTag } from '../steps/common.js';
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

async function pushImage(ctx: StepContext, repoUri: string): Promise<string> {
  const { run } = ctx;
  const { ecr } = clients(run.config.aws.region);
  const auth = (await ecr.send(new GetAuthorizationTokenCommand({}))).authorizationData?.[0];
  if (!auth?.authorizationToken) throw new Error('ECR returned no authorization token');
  const [username, password] = Buffer.from(auth.authorizationToken, 'base64').toString().split(':');
  const serveraddress = auth.proxyEndpoint ?? `https://${repoUri.split('/')[0]}`;

  const docker = dockerFactory.create();
  const local = imageTag(run.id);
  await docker.getImage(local).tag({ repo: repoUri, tag: run.id });
  ctx.log(`Tagged ${local} as ${repoUri}:${run.id}; pushing...`);

  const stream = await docker.getImage(`${repoUri}:${run.id}`).push({ tag: run.id, authconfig: { username, password, serveraddress } });
  const tlog = throttledLogger(ctx.log);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      stream,
      (err: Error | null, events: Array<{ error?: string }>) => {
        const failed = err?.message ?? events?.find((ev) => ev.error)?.error;
        if (failed) reject(new Error(`docker push failed: ${failed}`));
        else resolve();
      },
      (ev: { id?: string; status?: string; progress?: string; error?: string }) => {
        if (ev.error) return ctx.log(`push error: ${ev.error}`);
        if (!ev.status) return;
        const line = ev.id ? `${ev.id}: ${ev.status}${ev.progress ? ' ' + ev.progress : ''}` : ev.status;
        // Status transitions always show; byte-progress updates are throttled.
        tlog(ev.id ?? 'push', line, !ev.progress);
      },
    );
  });
  return `${repoUri}:${run.id}`;
}

export const ecrStep: Step = {
  id: 'ecr',
  async run(ctx) {
    try {
      const repoUri = await ensureRepo(ctx);
      ctx.run.outputs.ecrRepoUri = repoUri;
      const imageUri = await pushImage(ctx, repoUri);
      ctx.run.outputs.imageUri = imageUri;
      return { ok: true, summary: `Pushed ${imageUri.split('/').pop()}`, output: { ecrRepoUri: repoUri, imageUri } };
    } catch (e) {
      return { ok: false, summary: 'ECR push failed', error: errMsg(e) };
    }
  },
};
