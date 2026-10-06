import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  AuthorizeSecurityGroupIngressCommand, CreateSecurityGroupCommand, DescribeInstancesCommand,
  DescribeSecurityGroupsCommand, DescribeVpcsCommand, EC2Client, ModifyInstanceAttributeCommand, RunInstancesCommand,
} from '@aws-sdk/client-ec2';
import { CreateRepositoryCommand, DescribeRepositoriesCommand, ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import {
  AddRoleToInstanceProfileCommand, AttachRolePolicyCommand, CreateInstanceProfileCommand, CreateRoleCommand,
  DetachRolePolicyCommand, GetInstanceProfileCommand, GetRoleCommand, IAMClient, ListAttachedRolePoliciesCommand, PutRolePolicyCommand,
} from '@aws-sdk/client-iam';
import { readFileSync } from 'node:fs';
import { INSTANCE_ROLE_POLICY } from '../../src/aws/ec2.js';
import { DescribeInstanceInformationCommand, GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { awsSteps } from '../../src/aws/steps.js';
import { dockerFactory } from '../../src/aws/ecr.js';
import { repoSlug } from '../../src/aws/util.js';
import { awsErr, fastTiming, makeCtx, makeRun } from './helpers.js';

const ec2 = mockClient(EC2Client);
const ecr = mockClient(ECRClient);
const iam = mockClient(IAMClient);
const ssm = mockClient(SSMClient);
const step = (id: string) => awsSteps.find((s) => s.id === id)!;

beforeEach(() => {
  ec2.reset(); ecr.reset(); iam.reset(); ssm.reset();
  fastTiming();
});

describe('awsSteps', () => {
  it('exposes the six AWS nodes in order', () => {
    expect(awsSteps.map((s) => s.id)).toEqual(['ecr', 'securityGroup', 'ec2', 'deploy', 'health', 'dashboard']);
  });
  it('sanitizes repo names', () => {
    expect(repoSlug('https://github.com/acme/My_App.git')).toBe('my_app');
    expect(repoSlug('git@github.com:acme/--Weird Name!!.git')).toBe('weird-name');
  });
});

describe('iam policy docs', () => {
  const doc = (f: string) => JSON.parse(readFileSync(new URL(`../../../docs/iam/${f}`, import.meta.url), 'utf8'));
  it('instance-role-policy.json matches the policy the code applies', () => {
    expect(doc('instance-role-policy.json')).toEqual(INSTANCE_ROLE_POLICY);
  });
  it('instance policy scopes parameter reads to /builddoctor/*', () => {
    const reads = INSTANCE_ROLE_POLICY.Statement.filter((s) => s.Action.some((a) => a.startsWith('ssm:GetParameter')));
    expect(reads.map((s) => s.Resource)).toEqual(['arn:aws:ssm:*:*:parameter/builddoctor/*']);
  });
  it('deploy-user policy never grants iam/ecr/ssm-write on wildcard resources', () => {
    for (const s of doc('deploy-user-policy.json').Statement) {
      const actions = ([] as string[]).concat(s.Action);
      const resources = ([] as string[]).concat(s.Resource);
      if (actions.some((a) => a.startsWith('iam:'))) expect(resources.every((r) => /BuildDoctorEC2Role$/.test(r))).toBe(true);
      if (actions.some((a) => a.startsWith('ecr:') && a !== 'ecr:GetAuthorizationToken')) expect(resources).toEqual(['arn:aws:ecr:*:*:repository/builddoctor/*']);
      if (actions.some((a) => a === 'ssm:PutParameter' || a === 'ssm:DeleteParameters')) expect(resources).toEqual(['arn:aws:ssm:*:*:parameter/builddoctor/*']);
    }
  });
});

describe('ecr step', () => {
  function fakeDocker(events: object[]) {
    const tag = vi.fn().mockResolvedValue(undefined);
    const push = vi.fn().mockResolvedValue('stream');
    const docker = {
      getImage: vi.fn(() => ({ tag, push })),
      modem: {
        followProgress: (_s: unknown, done: (e: Error | null, ev: object[]) => void, progress: (ev: object) => void) => {
          events.forEach(progress);
          done(null, events);
        },
      },
    };
    dockerFactory.create = () => docker as never;
    return { docker, tag, push };
  }
  const token = Buffer.from('AWS:secretpw').toString('base64');

  it('creates a missing repo, records it, and pushes <uri>:<runId>', async () => {
    const uri = '172.dkr.ecr.ap-south-1.amazonaws.com/builddoctor/my_app';
    ecr.on(DescribeRepositoriesCommand).rejects(awsErr('RepositoryNotFoundException'));
    ecr.on(CreateRepositoryCommand).resolves({ repository: { repositoryUri: uri } });
    ecr.on(GetAuthorizationTokenCommand).resolves({ authorizationData: [{ authorizationToken: token, proxyEndpoint: 'https://172.dkr.ecr.ap-south-1.amazonaws.com' }] });
    const { tag, push } = fakeDocker([{ id: 'abc', status: 'Pushing', progress: '[==>  ]' }, { id: 'abc', status: 'Pushed' }]);

    const run = makeRun();
    const ctx = makeCtx(run);
    const res = await step('ecr').run(ctx);

    expect(res.ok).toBe(true);
    expect(ecr).toHaveReceivedCommandWith(CreateRepositoryCommand, { repositoryName: 'builddoctor/my_app' });
    expect(run.outputs.created).toEqual([{ type: 'ecr', id: 'builddoctor/my_app' }]);
    expect(run.outputs.imageUri).toBe(`${uri}:run123`);
    expect(tag).toHaveBeenCalledWith({ repo: uri, tag: 'run123' });
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ authconfig: expect.objectContaining({ username: 'AWS', password: 'secretpw' }) }));
    expect(ctx.lines.join('\n')).not.toContain('secretpw');
  });

  it('reuses an existing repo without recording it', async () => {
    ecr.on(DescribeRepositoriesCommand).resolves({ repositories: [{ repositoryUri: 'x/builddoctor/my_app' }] });
    ecr.on(GetAuthorizationTokenCommand).resolves({ authorizationData: [{ authorizationToken: token }] });
    fakeDocker([]);
    const run = makeRun();
    expect((await step('ecr').run(makeCtx(run))).ok).toBe(true);
    expect(ecr).not.toHaveReceivedCommand(CreateRepositoryCommand);
    expect(run.outputs.created).toEqual([]);
  });

  it('fails on push errors', async () => {
    ecr.on(DescribeRepositoriesCommand).resolves({ repositories: [{ repositoryUri: 'x/r' }] });
    ecr.on(GetAuthorizationTokenCommand).resolves({ authorizationData: [{ authorizationToken: token }] });
    fakeDocker([{ error: 'denied: not authorized' }]);
    const res = await step('ecr').run(makeCtx(makeRun()));
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('denied') });
  });
});

describe('securityGroup step', () => {
  it('creates a tagged SG in the default VPC with app + extra ports, never 22', async () => {
    ec2.on(DescribeVpcsCommand).resolves({ Vpcs: [{ VpcId: 'vpc-1' }] });
    ec2.on(CreateSecurityGroupCommand).resolves({ GroupId: 'sg-new' });
    ec2.on(AuthorizeSecurityGroupIngressCommand).resolves({});
    const run = makeRun({}, { openPorts: [22, 80, 3000] });
    const res = await step('securityGroup').run(makeCtx(run));

    expect(res.ok).toBe(true);
    expect(ec2).toHaveReceivedCommandWith(CreateSecurityGroupCommand, {
      GroupName: 'builddoctor-run123', VpcId: 'vpc-1',
      TagSpecifications: [{ ResourceType: 'security-group', Tags: expect.arrayContaining([{ Key: 'Project', Value: 'BuildDoctor' }, { Key: 'RunId', Value: 'run123' }]) }],
    });
    const ports = ec2.commandCalls(AuthorizeSecurityGroupIngressCommand).map((c) => c.args[0].input.IpPermissions![0].FromPort);
    expect(ports.sort()).toEqual([3000, 80].sort());
    expect(run.outputs).toMatchObject({ securityGroupId: 'sg-new', created: [{ type: 'sg', id: 'sg-new' }] });
  });

  it('reuses an existing SG and adds the app port when missing', async () => {
    ec2.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [{ GroupId: 'sg-old', GroupName: 'mine', IpPermissions: [], Tags: [{ Key: 'Project', Value: 'BuildDoctor' }] }] });
    ec2.on(AuthorizeSecurityGroupIngressCommand).resolves({});
    const run = makeRun({}, { existingSecurityGroupId: 'sg-old' });
    const ctx = makeCtx(run);
    expect((await step('securityGroup').run(ctx)).ok).toBe(true);
    expect(ec2).toHaveReceivedCommandTimes(AuthorizeSecurityGroupIngressCommand, 1);
    expect(ec2).not.toHaveReceivedCommand(CreateSecurityGroupCommand);
    expect(run.outputs.created).toEqual([{ type: 'sg-rule', id: 'sg-old:3000:0.0.0.0/0' }]);
    expect(ctx.lines.join('\n')).toMatch(/Adding inbound rule tcp\/3000/);
  });

  it('fails clearly without a default VPC', async () => {
    ec2.on(DescribeVpcsCommand).resolves({ Vpcs: [] });
    const res = await step('securityGroup').run(makeCtx(makeRun()));
    expect(res).toMatchObject({ ok: false, summary: 'No default VPC' });
  });
});

describe('ec2 step', () => {
  it('creates role + profile, retries profile propagation, waits for running and SSM', async () => {
    iam.on(GetRoleCommand).rejects(awsErr('NoSuchEntityException'));
    iam.on(CreateRoleCommand).resolves({});
    iam.on(AttachRolePolicyCommand).resolves({});
    iam.on(PutRolePolicyCommand).resolves({});
    iam.on(ListAttachedRolePoliciesCommand).resolves({ AttachedPolicies: [] });
    iam.on(GetInstanceProfileCommand).rejects(awsErr('NoSuchEntityException'));
    iam.on(CreateInstanceProfileCommand).resolves({});
    iam.on(AddRoleToInstanceProfileCommand).resolves({});
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: 'ami-arm' } });
    ec2.on(RunInstancesCommand)
      .rejectsOnce(awsErr('InvalidParameterValue', 'Value (BuildDoctorEC2Role) for parameter iamInstanceProfile.name is invalid. Invalid IAM Instance Profile name'))
      .resolves({ Instances: [{ InstanceId: 'i-1' }] });
    ec2.on(DescribeInstancesCommand)
      .resolvesOnce({ Reservations: [{ Instances: [{ InstanceId: 'i-1', State: { Name: 'pending' } }] }] })
      .resolves({ Reservations: [{ Instances: [{ InstanceId: 'i-1', State: { Name: 'running' }, PublicIpAddress: '1.2.3.4', InstanceType: 't4g.micro' }] }] });
    ssm.on(DescribeInstanceInformationCommand)
      .resolvesOnce({ InstanceInformationList: [] })
      .resolves({ InstanceInformationList: [{ PingStatus: 'Online' }] });

    const run = makeRun();
    run.outputs.securityGroupId = 'sg-new';
    const res = await step('ec2').run(makeCtx(run));

    expect(res.ok).toBe(true);
    expect(ec2).toHaveReceivedCommandTimes(RunInstancesCommand, 2);
    expect(ec2).toHaveReceivedCommandWith(RunInstancesCommand, {
      ImageId: 'ami-arm', InstanceType: 't4g.micro', SecurityGroupIds: ['sg-new'], IamInstanceProfile: { Name: 'BuildDoctorEC2Role' },
    });
    expect(iam).toHaveReceivedCommandTimes(AttachRolePolicyCommand, 1);
    expect(iam).toHaveReceivedCommandWith(AttachRolePolicyCommand, { PolicyArn: 'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly' });
    expect(iam).toHaveReceivedCommandWith(PutRolePolicyCommand, { RoleName: 'BuildDoctorEC2Role', PolicyDocument: JSON.stringify(INSTANCE_ROLE_POLICY) });
    expect(iam).not.toHaveReceivedCommand(DetachRolePolicyCommand);
    expect(run.outputs).toMatchObject({ instanceId: 'i-1', publicIp: '1.2.3.4' });
    expect(run.outputs.created.map((c) => c.type).sort()).toEqual(['ec2', 'iam-role', 'instance-profile']);
  });

  it('reuses role/profile without recording them, migrating off AmazonSSMManagedInstanceCore', async () => {
    iam.on(GetRoleCommand).resolves({});
    iam.on(PutRolePolicyCommand).resolves({});
    iam.on(DetachRolePolicyCommand).resolves({});
    iam.on(ListAttachedRolePoliciesCommand).resolves({ AttachedPolicies: [
      { PolicyArn: 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore' },
      { PolicyArn: 'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly' },
    ] });
    iam.on(GetInstanceProfileCommand).resolves({ InstanceProfile: { Roles: [{ RoleName: 'BuildDoctorEC2Role' }] } as never });
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: 'ami-arm' } });
    ec2.on(RunInstancesCommand).resolves({ Instances: [{ InstanceId: 'i-2' }] });
    ec2.on(DescribeInstancesCommand).resolves({ Reservations: [{ Instances: [{ InstanceId: 'i-2', State: { Name: 'running' }, PublicIpAddress: '5.6.7.8' }] }] });
    ssm.on(DescribeInstanceInformationCommand).resolves({ InstanceInformationList: [{ PingStatus: 'Online' }] });
    const run = makeRun();
    expect((await step('ec2').run(makeCtx(run))).ok).toBe(true);
    expect(iam).not.toHaveReceivedCommand(CreateRoleCommand);
    expect(iam).not.toHaveReceivedCommand(AddRoleToInstanceProfileCommand);
    expect(iam).toHaveReceivedCommandWith(DetachRolePolicyCommand, { PolicyArn: 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore' });
    expect(iam).not.toHaveReceivedCommand(AttachRolePolicyCommand);
    expect(iam).toHaveReceivedCommandTimes(PutRolePolicyCommand, 1);
    expect(run.outputs.created).toEqual([{ type: 'ec2', id: 'i-2' }]);
  });

  it('rejects an existing x86 instance', async () => {
    ec2.on(DescribeInstancesCommand).resolves({ Reservations: [{ Instances: [{ InstanceId: 'i-x', State: { Name: 'running' }, Architecture: 'x86_64', PublicIpAddress: '1.1.1.1' }] }] });
    ssm.on(DescribeInstanceInformationCommand).resolves({ InstanceInformationList: [{ PingStatus: 'Online' }] });
    const res = await step('ec2').run(makeCtx(makeRun({}, { existingInstanceId: 'i-x' })));
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('arm64') });
    expect(ec2).not.toHaveReceivedCommand(RunInstancesCommand);
  });

  it('accepts an existing arm64 SSM instance and attaches our SG', async () => {
    ec2.on(DescribeInstancesCommand).resolves({ Reservations: [{ Instances: [{ InstanceId: 'i-a', State: { Name: 'running' }, Architecture: 'arm64', PublicIpAddress: '9.9.9.9', SecurityGroups: [{ GroupId: 'sg-a' }], Tags: [{ Key: 'Project', Value: 'BuildDoctor' }] }] }] });
    ec2.on(ModifyInstanceAttributeCommand).resolves({});
    ssm.on(DescribeInstanceInformationCommand).resolves({ InstanceInformationList: [{ PingStatus: 'Online' }] });
    const run = makeRun({}, { existingInstanceId: 'i-a' });
    run.outputs.securityGroupId = 'sg-new';
    expect((await step('ec2').run(makeCtx(run))).ok).toBe(true);
    expect(ec2).toHaveReceivedCommandWith(ModifyInstanceAttributeCommand, { InstanceId: 'i-a', Groups: ['sg-a', 'sg-new'] });
    expect(run.outputs.created).toEqual([]);
  });
});

describe('opt-in tag on pre-existing resources', () => {
  it('refuses an existing SG without Project=BuildDoctor', async () => {
    ec2.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [{ GroupId: 'sg-prod', GroupName: 'prod', IpPermissions: [] }] });
    const run = makeRun({}, { existingSecurityGroupId: 'sg-prod' });
    const res = await step('securityGroup').run(makeCtx(run));
    expect(res.ok).toBe(false);
    expect(ec2).not.toHaveReceivedCommand(AuthorizeSecurityGroupIngressCommand);
  });
});
