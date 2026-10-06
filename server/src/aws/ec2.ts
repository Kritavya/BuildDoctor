import {
  DescribeInstancesCommand,
  ModifyInstanceAttributeCommand,
  RunInstancesCommand,
  type Instance,
} from '@aws-sdk/client-ec2';
import {
  AddRoleToInstanceProfileCommand,
  AttachRolePolicyCommand,
  CreateInstanceProfileCommand,
  CreateRoleCommand,
  GetInstanceProfileCommand,
  GetRoleCommand,
} from '@aws-sdk/client-iam';
import { DescribeInstanceInformationCommand, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { Step, StepContext } from '../pipeline/step.js';
import { clients } from './clients.js';
import { ROLE_NAME, errMsg, errName, poll, recordCreated, sleep, tags, timing } from './util.js';

const AMI_PARAM = '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64';
const MANAGED_POLICIES = [
  'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
  'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly',
];

// AL2023 ships the SSM agent and AWS CLI; only Docker is added.
export const USER_DATA = `#!/bin/bash
set -e
dnf install -y docker
systemctl enable --now docker
usermod -aG docker ec2-user
`;

// Shared role/profile, reused across runs. Created ones are recorded but never deleted by teardown.
export async function ensureInstanceProfile(ctx: StepContext): Promise<string> {
  const { run } = ctx;
  const { iam } = clients(run.config.aws.region);
  try {
    await iam.send(new GetRoleCommand({ RoleName: ROLE_NAME }));
    ctx.log(`Reusing IAM role ${ROLE_NAME}`);
  } catch (e) {
    if (errName(e) !== 'NoSuchEntityException' && errName(e) !== 'NoSuchEntity') throw e;
    await iam.send(new CreateRoleCommand({
      RoleName: ROLE_NAME,
      Description: 'BuildDoctor EC2 hosts: SSM management + ECR pull',
      AssumeRolePolicyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }],
      }),
      Tags: [{ Key: 'Project', Value: 'BuildDoctor' }],
    }));
    recordCreated(run, 'iam-role', ROLE_NAME);
    ctx.log(`Created IAM role ${ROLE_NAME}`);
  }
  // Attach is idempotent.
  for (const arn of MANAGED_POLICIES) await iam.send(new AttachRolePolicyCommand({ RoleName: ROLE_NAME, PolicyArn: arn }));

  let roles: string[] = [];
  try {
    const res = await iam.send(new GetInstanceProfileCommand({ InstanceProfileName: ROLE_NAME }));
    roles = (res.InstanceProfile?.Roles ?? []).map((r) => r.RoleName!);
  } catch (e) {
    if (errName(e) !== 'NoSuchEntityException' && errName(e) !== 'NoSuchEntity') throw e;
    await iam.send(new CreateInstanceProfileCommand({
      InstanceProfileName: ROLE_NAME,
      Tags: [{ Key: 'Project', Value: 'BuildDoctor' }],
    }));
    recordCreated(run, 'instance-profile', ROLE_NAME);
    ctx.log(`Created instance profile ${ROLE_NAME}`);
  }
  if (!roles.includes(ROLE_NAME)) {
    await iam.send(new AddRoleToInstanceProfileCommand({ InstanceProfileName: ROLE_NAME, RoleName: ROLE_NAME }));
  }
  return ROLE_NAME;
}

export async function describeInstance(region: string, instanceId: string): Promise<Instance | undefined> {
  const res = await clients(region).ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  return res.Reservations?.[0]?.Instances?.[0];
}

async function ssmOnline(region: string, instanceId: string): Promise<boolean> {
  const res = await clients(region).ssm.send(new DescribeInstanceInformationCommand({
    Filters: [{ Key: 'InstanceIds', Values: [instanceId] }],
  }));
  return res.InstanceInformationList?.[0]?.PingStatus === 'Online';
}

async function waitForSsm(ctx: StepContext, instanceId: string): Promise<void> {
  ctx.log('Waiting for the SSM agent to come online...');
  await poll(async () => ((await ssmOnline(ctx.run.config.aws.region, instanceId)) ? true : undefined), {
    timeoutMs: timing.ssmOnlineMs,
    what: `SSM agent on ${instanceId}`,
    signal: ctx.signal,
    onWait: (ms) => ctx.log(`  SSM agent not online yet (${Math.round(ms / 1000)}s)`),
  });
  ctx.log('SSM agent online');
}

async function useExisting(ctx: StepContext, instanceId: string) {
  const { run } = ctx;
  const region = run.config.aws.region;
  const inst = await describeInstance(region, instanceId);
  if (!inst) throw new Error(`Instance ${instanceId} not found in ${region}`);
  const problems: string[] = [];
  if (inst.State?.Name !== 'running') problems.push(`state is ${inst.State?.Name}, expected running`);
  if (inst.Architecture !== 'arm64') problems.push(`architecture is ${inst.Architecture}; images are built for arm64 (use a t4g/Graviton instance)`);
  if (!inst.PublicIpAddress) problems.push('it has no public IP address');
  if (!(await ssmOnline(region, instanceId))) problems.push('it is not SSM-managed/online (needs the SSM agent and an instance profile with AmazonSSMManagedInstanceCore)');
  if (problems.length) throw new Error(`Instance ${instanceId} unusable: ${problems.join('; ')}`);

  // Our security group must be attached for the app port to be reachable.
  const sgId = run.outputs.securityGroupId;
  const groups = (inst.SecurityGroups ?? []).map((g) => g.GroupId!);
  if (sgId && !groups.includes(sgId)) {
    ctx.log(`Attaching security group ${sgId} to ${instanceId}`);
    await clients(region).ec2.send(new ModifyInstanceAttributeCommand({ InstanceId: instanceId, Groups: [...groups, sgId] }));
  }
  ctx.log(`Using existing instance ${instanceId} (${inst.InstanceType}, ${inst.PublicIpAddress})`);
  return inst;
}

async function launch(ctx: StepContext): Promise<Instance> {
  const { run } = ctx;
  const region = run.config.aws.region;
  const { ec2, ssm } = clients(region);
  const profile = await ensureInstanceProfile(ctx);

  const ami = (await ssm.send(new GetParameterCommand({ Name: AMI_PARAM }))).Parameter?.Value;
  if (!ami) throw new Error(`Could not resolve AMI from ${AMI_PARAM}`);
  ctx.log(`AMI ${ami} (Amazon Linux 2023 arm64)`);

  const name = `builddoctor-${run.id}`;
  let instanceId: string | undefined;
  // A freshly created instance profile takes a few seconds to become usable by EC2.
  for (let attempt = 1; !instanceId; attempt++) {
    try {
      const res = await ec2.send(new RunInstancesCommand({
        ImageId: ami,
        InstanceType: run.config.aws.instanceType,
        MinCount: 1,
        MaxCount: 1,
        SecurityGroupIds: run.outputs.securityGroupId ? [run.outputs.securityGroupId] : undefined,
        IamInstanceProfile: { Name: profile },
        UserData: Buffer.from(USER_DATA).toString('base64'),
        MetadataOptions: { HttpTokens: 'required', HttpEndpoint: 'enabled' },
        BlockDeviceMappings: [{ DeviceName: '/dev/xvda', Ebs: { VolumeSize: 16, VolumeType: 'gp3', DeleteOnTermination: true } }],
        TagSpecifications: [
          { ResourceType: 'instance', Tags: tags(run.id, name) },
          { ResourceType: 'volume', Tags: tags(run.id, name) },
        ],
      }));
      instanceId = res.Instances![0].InstanceId!;
    } catch (e) {
      const propagating = errName(e) === 'InvalidParameterValue' && /instance profile/i.test(errMsg(e));
      if (!propagating || attempt >= timing.profileRetries) throw e;
      ctx.log(`Instance profile not yet visible to EC2, retrying (${attempt}/${timing.profileRetries})`);
      await sleep(timing.pollMs, ctx.signal);
    }
  }
  recordCreated(run, 'ec2', instanceId);
  run.outputs.instanceId = instanceId;
  ctx.log(`Launched ${instanceId} (${run.config.aws.instanceType})`);

  const inst = await poll(async () => {
    const i = await describeInstance(region, instanceId!);
    if (i?.State?.Name === 'terminated' || i?.State?.Name === 'shutting-down') throw new Error(`Instance ${instanceId} ${i.State.Name}: ${i.StateReason?.Message ?? ''}`);
    return i?.State?.Name === 'running' && i.PublicIpAddress ? i : undefined;
  }, {
    timeoutMs: timing.instanceRunningMs, what: `${instanceId} to be running`, signal: ctx.signal,
    onWait: (ms) => ctx.log(`  instance starting (${Math.round(ms / 1000)}s)`),
  });
  ctx.log(`Instance running at ${inst.PublicIpAddress}`);
  return inst;
}

export const ec2Step: Step = {
  id: 'ec2',
  async run(ctx) {
    const { run } = ctx;
    try {
      const existing = run.config.aws.existingInstanceId;
      const inst = existing ? await useExisting(ctx, existing) : await launch(ctx);
      if (!existing) await waitForSsm(ctx, inst.InstanceId!);
      run.outputs.instanceId = inst.InstanceId;
      run.outputs.publicIp = inst.PublicIpAddress;
      return {
        ok: true,
        summary: `${inst.InstanceId} @ ${inst.PublicIpAddress}`,
        output: { instanceId: inst.InstanceId, publicIp: inst.PublicIpAddress, instanceType: inst.InstanceType, reused: !!existing },
      };
    } catch (e) {
      return { ok: false, summary: 'EC2 setup failed', error: errMsg(e) };
    }
  },
};
