import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  AuthorizeSecurityGroupIngressCommand, DeleteSecurityGroupCommand, DescribeInstancesCommand,
  DescribeSecurityGroupsCommand, EC2Client, RevokeSecurityGroupIngressCommand, TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';
import { BatchDeleteImageCommand, DeleteRepositoryCommand, ECRClient, ListImagesCommand } from '@aws-sdk/client-ecr';
import { CADVISOR_IMAGE, DOZZLE_IMAGE } from '../../src/aws/dashboard.js';
import {
  DeleteParametersCommand, GetCommandInvocationCommand, PutParameterCommand, SendCommandCommand, SSMClient,
} from '@aws-sdk/client-ssm';

vi.mock('../../src/llm/ollama.js', () => ({ chatJson: vi.fn() }));
import { chatJson } from '../../src/llm/ollama.js';
import { awsSteps, setDashboard, teardown } from '../../src/aws/steps.js';
import { awsErr, fastTiming, makeCtx, makeRun } from './helpers.js';

const ec2 = mockClient(EC2Client);
const ecr = mockClient(ECRClient);
const ssm = mockClient(SSMClient);
const step = (id: string) => awsSteps.find((s) => s.id === id)!;
const SECRET = 'sup3r-s3cret-value';

function deployedRun() {
  const run = makeRun({ env: { DB_PASSWORD: SECRET, EMPTY: '' } });
  Object.assign(run.outputs, {
    ecrRepoUri: '172.dkr.ecr.ap-south-1.amazonaws.com/builddoctor/my_app',
    imageUri: '172.dkr.ecr.ap-south-1.amazonaws.com/builddoctor/my_app:run123',
    instanceId: 'i-1', publicIp: '1.2.3.4', securityGroupId: 'sg-1',
  });
  return run;
}

function commandReturns(stdout: string, status = 'Success') {
  ssm.on(SendCommandCommand).resolves({ Command: { CommandId: 'cmd-1' } });
  ssm.on(GetCommandInvocationCommand)
    .rejectsOnce(awsErr('InvocationDoesNotExist'))
    .resolvesOnce({ Status: 'InProgress', StandardOutputContent: stdout.split('\n')[0] + '\n' })
    .resolves({ Status: status as 'Success', ResponseCode: status === 'Success' ? 0 : 1, StandardOutputContent: stdout, StandardErrorContent: '' });
}

beforeEach(() => {
  ec2.reset(); ecr.reset(); ssm.reset();
  vi.mocked(chatJson).mockReset();
  fastTiming();
});
afterEach(() => vi.unstubAllGlobals());

describe('deploy step', () => {
  it('stores env as SecureStrings and never puts values in the SSM command or logs', async () => {
    ssm.on(PutParameterCommand).resolves({});
    commandReturns('Logging in\nPulling\napp container: Up 3 seconds');
    const run = deployedRun();
    const ctx = makeCtx(run);
    const res = await step('deploy').run(ctx);

    expect(res.ok).toBe(true);
    expect(ssm).toHaveReceivedCommandWith(PutParameterCommand, { Name: '/builddoctor/run123/env/DB_PASSWORD', Type: 'SecureString', Value: SECRET });
    expect(ssm).toHaveReceivedCommandTimes(PutParameterCommand, 1); // empty value not stored
    const script = ssm.commandCalls(SendCommandCommand)[0].args[0].input.Parameters!.commands[0];
    expect(script).not.toContain(SECRET);
    expect(script).toContain('docker run -d --name app --restart unless-stopped -p 3000:3000');
    expect(script).toContain("printf '%s=\\n' EMPTY");
    expect(script).not.toMatch(/set -x/);
    expect(ctx.lines.join('\n')).not.toContain(SECRET);
    expect(ctx.lines).toContain('app container: Up 3 seconds');
  });

  it('overwrites parameters on redeploy', async () => {
    ssm.on(PutParameterCommand).rejectsOnce(awsErr('ParameterAlreadyExists')).resolves({});
    commandReturns('ok');
    expect((await step('deploy').run(makeCtx(deployedRun()))).ok).toBe(true);
    expect(ssm).toHaveReceivedCommandWith(PutParameterCommand, { Overwrite: true });
  });

  it('fails when the remote script fails', async () => {
    ssm.on(PutParameterCommand).resolves({});
    commandReturns('Error response from daemon: manifest unknown', 'Failed');
    const res = await step('deploy').run(makeCtx(deployedRun()));
    expect(res).toMatchObject({ ok: false, summary: 'Deploy command Failed', error: expect.stringContaining('manifest unknown') });
  });
});

describe('health step', () => {
  const openSg = { SecurityGroups: [{ GroupId: 'sg-1', IpPermissions: [{ IpProtocol: 'tcp', FromPort: 3000, ToPort: 3000, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }] }] };

  it('succeeds on a <500 response and sets appUrl', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok', { status: 404 })));
    const run = deployedRun();
    const res = await step('health').run(makeCtx(run));
    expect(res.ok).toBe(true);
    expect(run.outputs.appUrl).toBe('http://1.2.3.4:3000/');
  });

  it('fixes a blocked SG port and retries from deploy', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } })));
    ec2.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [{ GroupId: 'sg-1', IpPermissions: [] }] });
    ec2.on(AuthorizeSecurityGroupIngressCommand).resolves({});
    const res = await step('health').run(makeCtx(deployedRun()));
    expect(res).toMatchObject({ ok: false, retryFrom: 'deploy', diagnosis: { rootCause: expect.stringContaining('blocked') } });
    expect(chatJson).not.toHaveBeenCalled();
  });

  it('asks the LLM with redacted evidence and retries only for runtime-config fixes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    ec2.on(DescribeSecurityGroupsCommand).resolves(openSg);
    commandReturns(`== docker ps -a\napp Exited (1)\nError: connect failed password=${SECRET}`);
    vi.mocked(chatJson).mockResolvedValue({
      rootCause: 'DATABASE_URL missing', evidence: 'connect failed', attemptedFix: 'set DATABASE_URL', result: 'not-fixed', fixLevel: 'runtime-config',
    });
    const ctx = makeCtx(deployedRun());
    const res = await step('health').run(ctx);

    expect(res).toMatchObject({ ok: false, retryFrom: 'deploy', diagnosis: { rootCause: 'DATABASE_URL missing' } });
    expect((res as { diagnosis: object }).diagnosis).not.toHaveProperty('fixLevel');
    const prompt = JSON.stringify(vi.mocked(chatJson).mock.calls[0][0]);
    expect(prompt).not.toContain(SECRET);
    expect(prompt).toContain('***');
    expect(ctx.lines.join('\n')).not.toContain(SECRET);
  });

  it('does not retry for code-level fixes, and survives LLM outages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 502 })));
    ec2.on(DescribeSecurityGroupsCommand).resolves(openSg);
    commandReturns('app Exited (1)');
    vi.mocked(chatJson).mockResolvedValueOnce({ rootCause: 'syntax error', evidence: '', attemptedFix: 'edit code', result: 'not-fixed', fixLevel: 'code' });
    const res = await step('health').run(makeCtx(deployedRun()));
    expect(res.ok).toBe(false);
    expect(res).not.toHaveProperty('retryFrom');

    vi.mocked(chatJson).mockRejectedValueOnce(new Error('Ollama down'));
    const res2 = await step('health').run(makeCtx(deployedRun()));
    expect(res2).toMatchObject({ ok: false, diagnosis: { attemptedFix: expect.stringContaining('LLM diagnosis unavailable') } });
    expect(res2).not.toHaveProperty('retryFrom');
  });
});

describe('dashboard', () => {
  it('step leaves it off but available', async () => {
    const run = deployedRun();
    const res = await step('dashboard').run(makeCtx(run));
    expect(res).toMatchObject({ ok: true, output: { enabled: false, available: true } });
    expect(run.outputs.dashboard).toEqual({ enabled: false });
    expect(ssm).not.toHaveReceivedCommand(SendCommandCommand);
  });

  it('enable starts containers and opens 18080/18081 to caller /32 only, revoking stale IPs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('203.0.113.7\n')));
    commandReturns('bd-cadvisor: Up\nbd-dozzle: Up');
    ec2.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [{ GroupId: 'sg-1', IpPermissions: [
      { IpProtocol: 'tcp', FromPort: 18080, ToPort: 18080, IpRanges: [{ CidrIp: '198.51.100.1/32', Description: 'BuildDoctor dashboard' }] },
      { IpProtocol: 'tcp', FromPort: 3000, ToPort: 3000, IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'BuildDoctor' }] },
    ] }] });
    ec2.on(RevokeSecurityGroupIngressCommand).resolves({});
    ec2.on(AuthorizeSecurityGroupIngressCommand).resolves({});
    const run = deployedRun();
    const out = await setDashboard(run, true);

    expect(out).toEqual({ enabled: true, metricsUrl: 'http://1.2.3.4:18080/', logsUrl: 'http://1.2.3.4:18081/' });
    const script = ssm.commandCalls(SendCommandCommand)[0].args[0].input.Parameters!.commands[0];
    expect(script).toContain('/var/run/docker.sock:/var/run/docker.sock:ro');
    expect(script).toContain(CADVISOR_IMAGE);
    expect(script).toContain(DOZZLE_IMAGE);
    expect(DOZZLE_IMAGE).not.toMatch(/:latest$/);
    const cidrs = ec2.commandCalls(AuthorizeSecurityGroupIngressCommand).map((c) => c.args[0].input.IpPermissions![0].IpRanges![0].CidrIp);
    expect(cidrs).toEqual(['203.0.113.7/32', '203.0.113.7/32']);
    // sg-1 is pre-existing here, so the new dashboard rules are tracked for teardown.
    expect(run.outputs.created).toEqual([
      { type: 'sg-rule', id: 'sg-1:18080:203.0.113.7/32' }, { type: 'sg-rule', id: 'sg-1:18081:203.0.113.7/32' },
    ]);
    expect(ec2).toHaveReceivedCommandWith(RevokeSecurityGroupIngressCommand, {
      IpPermissions: [{ IpProtocol: 'tcp', FromPort: 18080, ToPort: 18080, IpRanges: [{ CidrIp: '198.51.100.1/32', Description: 'BuildDoctor dashboard' }] }],
    });
  });

  it('disable removes containers and only dashboard rules', async () => {
    commandReturns('stopped');
    ec2.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [{ GroupId: 'sg-1', IpPermissions: [
      { IpProtocol: 'tcp', FromPort: 18081, ToPort: 18081, IpRanges: [{ CidrIp: '203.0.113.7/32', Description: 'BuildDoctor dashboard' }] },
      { IpProtocol: 'tcp', FromPort: 3000, ToPort: 3000, IpRanges: [{ CidrIp: '0.0.0.0/0' }] },
    ] }] });
    ec2.on(RevokeSecurityGroupIngressCommand).resolves({});
    const run = deployedRun();
    expect(await setDashboard(run, false)).toEqual({ enabled: false });
    expect(ec2).toHaveReceivedCommandTimes(RevokeSecurityGroupIngressCommand, 1);
    const revoked = ec2.commandCalls(RevokeSecurityGroupIngressCommand)[0].args[0].input.IpPermissions!;
    expect(revoked.map((p) => p.FromPort)).toEqual([18081]);
  });
});

describe('teardown', () => {
  const tagged = [{ Key: 'Project', Value: 'BuildDoctor' }, { Key: 'RunId', Value: 'run123' }];

  it('deletes only recorded resources, in order, retrying SG DependencyViolation', async () => {
    const run = deployedRun();
    run.outputs.created = [
      { type: 'ecr', id: 'builddoctor/my_app' }, { type: 'sg', id: 'sg-1' }, { type: 'iam-role', id: 'BuildDoctorEC2Role' }, { type: 'ec2', id: 'i-1' },
    ];
    ec2.on(DescribeInstancesCommand)
      .resolvesOnce({ Reservations: [{ Instances: [{ InstanceId: 'i-1', State: { Name: 'running' }, Tags: tagged }] }] })
      .resolvesOnce({ Reservations: [{ Instances: [{ InstanceId: 'i-1', State: { Name: 'shutting-down' }, Tags: tagged }] }] })
      .resolves({ Reservations: [{ Instances: [{ InstanceId: 'i-1', State: { Name: 'terminated' }, Tags: tagged }] }] });
    ec2.on(TerminateInstancesCommand).resolves({});
    ec2.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [{ GroupId: 'sg-1', Tags: tagged }] });
    ec2.on(DeleteSecurityGroupCommand).rejectsOnce(awsErr('DependencyViolation')).resolves({});
    ecr.on(BatchDeleteImageCommand).resolves({});
    ecr.on(ListImagesCommand).resolves({ imageIds: [] });
    ecr.on(DeleteRepositoryCommand).resolves({});
    ssm.on(DeleteParametersCommand).resolves({ DeletedParameters: ['/builddoctor/run123/env/DB_PASSWORD'] });

    const out = await teardown(run);
    expect(out).toEqual([
      'EC2 instance i-1 terminated',
      'Security group sg-1 deleted',
      'ECR image builddoctor/my_app:run123 deleted; empty ECR repository builddoctor/my_app deleted',
      '1 SSM env parameter(s) deleted',
      'Kept shared IAM role/instance profile BuildDoctorEC2Role (reused by other runs)',
    ]);
    expect(ec2).toHaveReceivedCommandWith(TerminateInstancesCommand, { InstanceIds: ['i-1'] });
    expect(ec2).toHaveReceivedCommandTimes(DeleteSecurityGroupCommand, 2);
    expect(ecr).toHaveReceivedCommandWith(BatchDeleteImageCommand, { repositoryName: 'builddoctor/my_app', imageIds: [{ imageTag: 'run123' }] });
    expect(ecr.commandCalls(DeleteRepositoryCommand)[0].args[0].input).toEqual({ repositoryName: 'builddoctor/my_app' });
    expect(run.outputs.created.map((c) => c.type)).not.toContain('ecr');
  });

  it('keeps a created repo that still holds other runs\' images', async () => {
    const run = deployedRun();
    run.config.env = {};
    run.outputs.instanceId = undefined;
    run.outputs.securityGroupId = undefined;
    run.outputs.created = [{ type: 'ecr', id: 'builddoctor/my_app' }];
    ecr.on(BatchDeleteImageCommand).resolves({});
    ecr.on(ListImagesCommand).resolves({ imageIds: [{ imageTag: 'otherrun' }] });
    const out = await teardown(run);
    expect(ecr).not.toHaveReceivedCommand(DeleteRepositoryCommand);
    expect(out[0]).toMatch(/kept \(still holds images/);
  });

  it('revokes rules recorded on a pre-existing security group', async () => {
    const run = deployedRun();
    run.config.env = {};
    run.outputs.ecrRepoUri = undefined;
    run.config.aws.existingSecurityGroupId = 'sg-1';
    run.outputs.created = [{ type: 'ec2', id: 'i-1' }, { type: 'sg-rule', id: 'sg-1:3000:0.0.0.0/0' }];
    ec2.on(DescribeInstancesCommand).resolves({ Reservations: [{ Instances: [{ InstanceId: 'i-1', State: { Name: 'terminated' } }] }] });
    ec2.on(RevokeSecurityGroupIngressCommand).resolves({});
    const out = await teardown(run);
    expect(ec2).toHaveReceivedCommandWith(RevokeSecurityGroupIngressCommand, {
      GroupId: 'sg-1', IpPermissions: [{ IpProtocol: 'tcp', FromPort: 3000, ToPort: 3000, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }],
    });
    expect(ec2).not.toHaveReceivedCommand(DeleteSecurityGroupCommand);
    expect(out).toContain('Revoked inbound tcp/3000 from 0.0.0.0/0 on your security group sg-1');
    expect(run.outputs.created.some((c) => c.type === 'sg-rule')).toBe(false);
  });

  it('never deletes pre-existing resources', async () => {
    const run = deployedRun();
    run.config.env = {};
    run.config.aws.existingInstanceId = 'i-1';
    run.config.aws.existingSecurityGroupId = 'sg-1';
    ecr.on(BatchDeleteImageCommand).resolves({});
    const out = await teardown(run);
    expect(ec2).not.toHaveReceivedCommand(TerminateInstancesCommand);
    expect(ec2).not.toHaveReceivedCommand(DeleteSecurityGroupCommand);
    expect(ecr).not.toHaveReceivedCommand(DeleteRepositoryCommand);
    expect(ecr).toHaveReceivedCommandWith(BatchDeleteImageCommand, { imageIds: [{ imageTag: 'run123' }] });
    expect(out.join('\n')).toMatch(/Kept pre-existing instance i-1/);
    expect(out.join('\n')).toMatch(/Kept pre-existing security group sg-1/);
  });

  it('refuses to terminate a recorded instance whose tags do not match', async () => {
    const run = deployedRun();
    run.config.env = {};
    run.outputs.ecrRepoUri = undefined;
    run.outputs.created = [{ type: 'ec2', id: 'i-1' }, { type: 'sg', id: 'sg-1' }];
    ec2.on(DescribeInstancesCommand).resolves({ Reservations: [{ Instances: [{ InstanceId: 'i-1', State: { Name: 'running' }, Tags: [] }] }] });
    const out = await teardown(run);
    expect(ec2).not.toHaveReceivedCommand(TerminateInstancesCommand);
    expect(ec2).not.toHaveReceivedCommand(DeleteSecurityGroupCommand);
    expect(out[0]).toMatch(/Kept EC2 instance i-1: run tags missing/);
  });
});
