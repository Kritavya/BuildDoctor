import {
  DeleteSecurityGroupCommand,
  ModifyInstanceAttributeCommand,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';
import { BatchDeleteImageCommand, DeleteRepositoryCommand, DescribeRepositoriesCommand } from '@aws-sdk/client-ecr';
import type { RunState } from '../types.js';
import { clients } from './clients.js';
import { describeInstance } from './ec2.js';
import { describeSg } from './network.js';
import { deleteEnvParams } from './deploy.js';
import { setDashboard } from './dashboard.js';
import { ROLE_NAME, errMsg, errName, hasRunTag, poll, sleep, timing, wasCreated } from './util.js';

// Deletes only what this run recorded in outputs.created, after re-checking the run tags.
// Shared IAM role/profile are always kept. Returns one human-readable line per resource.
export async function teardown(run: RunState): Promise<string[]> {
  const region = run.config.aws.region;
  const { ec2, ecr } = clients(region);
  const out: string[] = [];
  const attempt = async (label: string, fn: () => Promise<string | undefined>) => {
    try {
      const msg = await fn();
      if (msg) out.push(msg);
    } catch (e) {
      out.push(`FAILED ${label}: ${errMsg(e)}`);
    }
  };

  const { instanceId, securityGroupId } = run.outputs;
  let instanceGone = true;

  // Dashboard on a kept instance/SG: stop its containers and revoke its rules first.
  if (run.outputs.dashboard?.enabled && instanceId && !wasCreated(run, 'ec2', instanceId)) {
    await attempt('disable dashboard', async () => {
      await setDashboard(run, false);
      return 'Dashboard containers stopped and their ingress rules revoked';
    });
  }

  if (instanceId && wasCreated(run, 'ec2', instanceId)) {
    await attempt(`terminate ${instanceId}`, async () => {
      const inst = await describeInstance(region, instanceId);
      if (!inst || inst.State?.Name === 'terminated') return `EC2 instance ${instanceId} (already terminated)`;
      if (!hasRunTag(inst.Tags, run.id)) { instanceGone = false; return `Kept EC2 instance ${instanceId}: run tags missing`; }
      await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
      await poll(async () => ((await describeInstance(region, instanceId))?.State?.Name === 'terminated' ? true : undefined), {
        timeoutMs: timing.terminateMs, what: `${instanceId} to terminate`,
      });
      return `EC2 instance ${instanceId} terminated`;
    });
    if (out.at(-1)?.startsWith('FAILED')) instanceGone = false;
  } else if (instanceId && securityGroupId && wasCreated(run, 'sg', securityGroupId)) {
    // Pre-existing instance: detach our SG, leave the instance and its container alone.
    await attempt(`detach ${securityGroupId} from ${instanceId}`, async () => {
      const inst = await describeInstance(region, instanceId);
      const groups = (inst?.SecurityGroups ?? []).map((g) => g.GroupId!);
      if (!groups.includes(securityGroupId)) return undefined;
      const rest = groups.filter((g) => g !== securityGroupId);
      if (!rest.length) { instanceGone = false; return `Kept ${securityGroupId}: it is the only security group on your instance ${instanceId}`; }
      await ec2.send(new ModifyInstanceAttributeCommand({ InstanceId: instanceId, Groups: rest }));
      return `Detached ${securityGroupId} from your instance ${instanceId} (instance kept)`;
    });
  }
  if (instanceId && !wasCreated(run, 'ec2', instanceId)) out.push(`Kept pre-existing instance ${instanceId} (the 'app' container keeps running)`);

  if (securityGroupId && wasCreated(run, 'sg', securityGroupId) && instanceGone) {
    await attempt(`delete ${securityGroupId}`, async () => {
      let sg;
      try { sg = await describeSg(region, securityGroupId); } catch (e) {
        if (errName(e) === 'InvalidGroup.NotFound') return `Security group ${securityGroupId} (already deleted)`;
        throw e;
      }
      if (!hasRunTag(sg.Tags, run.id)) return `Kept security group ${securityGroupId}: run tags missing`;
      // ENIs of a just-terminated instance can hold the group for a little while.
      const start = Date.now();
      for (;;) {
        try {
          await ec2.send(new DeleteSecurityGroupCommand({ GroupId: securityGroupId }));
          return `Security group ${securityGroupId} deleted`;
        } catch (e) {
          if (errName(e) !== 'DependencyViolation' || Date.now() - start >= timing.sgDeleteMs) throw e;
          await sleep(timing.pollMs);
        }
      }
    });
  } else if (securityGroupId && !wasCreated(run, 'sg', securityGroupId)) {
    out.push(`Kept pre-existing security group ${securityGroupId} (rules added by BuildDoctor remain)`);
  }

  const repo = run.outputs.ecrRepoUri?.split('/').slice(1).join('/');
  if (repo && wasCreated(run, 'ecr', repo)) {
    await attempt(`delete ECR ${repo}`, async () => {
      try {
        await ecr.send(new DeleteRepositoryCommand({ repositoryName: repo, force: true }));
      } catch (e) {
        if (errName(e) === 'RepositoryNotFoundException') return `ECR repository ${repo} (already deleted)`;
        throw e;
      }
      return `ECR repository ${repo} deleted (with images)`;
    });
  } else if (repo) {
    // Shared repo from an earlier run: remove only this run's image tag.
    await attempt(`delete image ${repo}:${run.id}`, async () => {
      await ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [repo] }));
      await ecr.send(new BatchDeleteImageCommand({ repositoryName: repo, imageIds: [{ imageTag: run.id }] }));
      return `ECR image ${repo}:${run.id} deleted (repository kept)`;
    });
  }

  if (Object.keys(run.config.env ?? {}).length) {
    await attempt('delete env parameters', async () => {
      const deleted = await deleteEnvParams(run);
      return deleted.length ? `${deleted.length} SSM env parameter(s) deleted` : undefined;
    });
  }

  if (run.outputs.created.some((c) => c.type === 'iam-role' || c.type === 'instance-profile') || !run.config.aws.existingInstanceId) {
    out.push(`Kept shared IAM role/instance profile ${ROLE_NAME} (reused by other runs)`);
  }
  if (run.outputs.dashboard?.enabled) run.outputs.dashboard = { enabled: false };
  return out;
}
