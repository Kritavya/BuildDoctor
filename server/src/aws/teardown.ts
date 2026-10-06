import {
  DeleteSecurityGroupCommand,
  ModifyInstanceAttributeCommand,
  RevokeSecurityGroupIngressCommand,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';
import { BatchDeleteImageCommand, DeleteRepositoryCommand, ListImagesCommand } from '@aws-sdk/client-ecr';
import type { RunState } from '../types.js';
import { clients } from './clients.js';
import { describeInstance } from './ec2.js';
import { describeSg } from './network.js';
import { deleteEnvParams } from './deploy.js';
import { setDashboard } from './dashboard.js';
import {
  ROLE_NAME, errMsg, errName, forgetCreated, hasRunTag, parseSgRuleId, poll, sleep, timing, wasCreated,
} from './util.js';

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
  }

  // Ingress rules we added to security groups we did not create.
  for (const rule of run.outputs.created.filter((c) => c.type === 'sg-rule')) {
    const { groupId, port, cidr } = parseSgRuleId(rule.id);
    await attempt(`revoke ${groupId} tcp/${port} from ${cidr}`, async () => {
      try {
        await ec2.send(new RevokeSecurityGroupIngressCommand({
          GroupId: groupId,
          IpPermissions: [{ IpProtocol: 'tcp', FromPort: port, ToPort: port, IpRanges: [{ CidrIp: cidr }] }],
        }));
      } catch (e) {
        if (errName(e) !== 'InvalidPermission.NotFound' && errName(e) !== 'InvalidGroup.NotFound') throw e;
      }
      forgetCreated(run, 'sg-rule', rule.id);
      return `Revoked inbound tcp/${port} from ${cidr} on your security group ${groupId}`;
    });
  }
  if (securityGroupId && !wasCreated(run, 'sg', securityGroupId)) out.push(`Kept pre-existing security group ${securityGroupId}`);

  // ECR: always drop this run's tag; the repo goes only if we created it and it is now empty.
  const repo = run.outputs.ecrRepoUri?.split('/').slice(1).join('/');
  if (repo) {
    await attempt(`clean up ECR ${repo}`, async () => {
      try {
        await ecr.send(new BatchDeleteImageCommand({ repositoryName: repo, imageIds: [{ imageTag: run.id }] }));
      } catch (e) {
        if (errName(e) === 'RepositoryNotFoundException') return `ECR repository ${repo} (already deleted)`;
        throw e;
      }
      const msg = `ECR image ${repo}:${run.id} deleted`;
      if (!wasCreated(run, 'ecr', repo)) return `${msg} (pre-existing repository kept)`;
      const left = (await ecr.send(new ListImagesCommand({ repositoryName: repo, maxResults: 1 }))).imageIds ?? [];
      if (left.length) return `${msg}; repository ${repo} kept (still holds images from other runs)`;
      try {
        // No force: if another run pushed meanwhile, the repo is kept.
        await ecr.send(new DeleteRepositoryCommand({ repositoryName: repo }));
      } catch (e) {
        if (errName(e) === 'RepositoryNotEmptyException') return `${msg}; repository ${repo} kept (not empty)`;
        throw e;
      }
      forgetCreated(run, 'ecr', repo);
      return `${msg}; empty ECR repository ${repo} deleted`;
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
  // Drop records of what is now gone (done last: the steps above read the record to decide what to keep).
  const gone = (line: string | undefined) => !!line && !line.startsWith('FAILED') && /terminated|deleted/.test(line);
  if (instanceId && gone(out.find((l) => l.startsWith(`EC2 instance ${instanceId}`)))) forgetCreated(run, 'ec2', instanceId);
  if (securityGroupId && gone(out.find((l) => l.startsWith(`Security group ${securityGroupId}`)))) forgetCreated(run, 'sg', securityGroupId);
  return out;
}
