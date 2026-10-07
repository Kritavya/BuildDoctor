import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  AuthorizeSecurityGroupIngressCommand, CreateSecurityGroupCommand, DescribeSecurityGroupsCommand, DescribeVpcsCommand, EC2Client,
} from '@aws-sdk/client-ec2';
import {
  BatchDeleteImageCommand, CreateRepositoryCommand, DescribeRepositoriesCommand, ECRClient, GetAuthorizationTokenCommand, ListImagesCommand,
} from '@aws-sdk/client-ecr';
import {
  DeleteParametersCommand, GetCommandInvocationCommand, PutParameterCommand, SendCommandCommand, SSMClient,
} from '@aws-sdk/client-ssm';

vi.mock('../../src/llm/ollama.js', () => ({ chatJson: vi.fn() }));
import { chatJson } from '../../src/llm/ollama.js';
import { approvalPlan, awsSteps, plannedActions, teardown } from '../../src/aws/steps.js';
import { dockerFactory } from '../../src/aws/ecr.js';
import { addressRef, deployServices, envLinks, startOrder } from '../../src/aws/services.js';
import { applyPatch } from '../../src/pipeline/engine.js';
import { RunStore } from '../../src/pipeline/store.js';
import type { RunEvent, RunState, ServicePlan } from '../../src/types.js';
import { awsErr, fastTiming, makeCtx, makeRun } from './helpers.js';

const ec2 = mockClient(EC2Client);
const ecr = mockClient(ECRClient);
const ssm = mockClient(SSMClient);
const step = (id: string) => awsSteps.find((s) => s.id === id)!;
const SECRET = 'api-db-s3cret-pw';
const REPO = '172.dkr.ecr.ap-south-1.amazonaws.com/builddoctor/my_app';

function plan(name: string, over: Partial<ServicePlan> = {}): ServicePlan {
  return {
    name, root: `apps/${name}`, context: '.', dockerfile: `apps/${name}/Dockerfile`, existingDockerfile: false,
    kind: 'server', runtime: 'node', port: 3000, portEvidence: 'e1', envVars: [], dependsOn: [], ...over,
  };
}

// web (primary, server) calls api through API_URL; api needs DATABASE_URL.
function monorepoRun(over: Parameters<typeof makeRun>[0] = {}, aws: Parameters<typeof makeRun>[1] = {}): RunState {
  const run = makeRun({ env: { LOG_LEVEL: 'info' }, serviceEnv: { api: { DATABASE_URL: SECRET, EMPTY: '' } }, ...over }, aws);
  const services = [
    plan('web', { port: 3000, envVars: ['API_URL', 'PORT', 'SESSION_SECRET'], dependsOn: ['api'] }),
    plan('api', { port: 4000, envVars: ['DATABASE_URL', 'PORT'] }),
  ];
  run.analysis = { runtime: 'node', port: 3000, envVars: [], dependencyFiles: [], dockerfile: 'missing', services };
  return run;
}

function deployed(run = monorepoRun()): RunState {
  Object.assign(run.outputs, {
    ecrRepoUri: REPO, imageUri: `${REPO}:run123`, instanceId: 'i-1', publicIp: '1.2.3.4', securityGroupId: 'sg-1',
    services: {
      web: { port: 3000, container: 'app-web', imageUri: `${REPO}:run123` },
      api: { port: 4000, container: 'app-api', imageUri: `${REPO}:run123-api` },
    },
  });
  return run;
}

function commandReturns(stdout: string, status = 'Success') {
  ssm.on(SendCommandCommand).resolves({ Command: { CommandId: 'cmd-1' } });
  ssm.on(GetCommandInvocationCommand).resolves({ Status: status as 'Success', ResponseCode: status === 'Success' ? 0 : 1, StandardOutputContent: stdout, StandardErrorContent: '' });
}

const sgOpen = (...ports: number[]) => ({
  SecurityGroups: [{ GroupId: 'sg-1', Tags: [{ Key: 'Project', Value: 'BuildDoctor' }], IpPermissions: ports.map((p) => ({ IpProtocol: 'tcp', FromPort: p, ToPort: p, IpRanges: [{ CidrIp: '0.0.0.0/0' }] })) }],
});

function ctxWithEvents(run: RunState) {
  const ctx = makeCtx(run);
  const events: RunEvent[] = [];
  ctx.emit = (e) => events.push(e);
  return { ctx, events, serviceEvents: (node: string) => events.filter((e): e is Extract<RunEvent, { type: 'service' }> => e.type === 'service' && e.node === node) };
}

beforeEach(() => {
  ec2.reset(); ecr.reset(); ssm.reset();
  vi.mocked(chatJson).mockReset();
  fastTiming();
});
afterEach(() => vi.unstubAllGlobals());

describe('deployServices', () => {
  it('single-service runs stay one container named app on the run tag', () => {
    expect(deployServices(makeRun())).toEqual([expect.objectContaining({ container: 'app', tag: 'run123', port: 3000, localImage: 'builddoctor/run123:latest', primary: true })]);
  });

  it('multi-service runs get app-<service> containers and <runId>-<service> tags; the primary keeps <runId>', () => {
    expect(deployServices(monorepoRun()).map((s) => [s.container, s.tag, s.localImage, s.port])).toEqual([
      ['app-web', 'run123', 'builddoctor/run123:latest', 3000],
      ['app-api', 'run123-api', 'builddoctor/run123-api:latest', 4000],
    ]);
  });

  it('starts dependencies first', () => {
    expect(startOrder(deployServices(monorepoRun())).map((s) => s.name)).toEqual(['api', 'web']);
  });
});

describe('inter-service env', () => {
  it('recognises address variables by the dependency name', () => {
    expect(addressRef('API_URL', 'api')).toBe('url');
    expect(addressRef('VITE_API_BASE_URL', 'api')).toBe('url');
    expect(addressRef('NEXT_PUBLIC_API_ORIGIN', 'api')).toBe('url');
    expect(addressRef('AUTH_SERVICE_URL', 'auth-service')).toBe('url');
    expect(addressRef('API_HOST', 'api')).toBe('host');
    expect(addressRef('API_PORT', 'api')).toBe('port');
    expect(addressRef('API_KEY', 'api')).toBeUndefined();
    expect(addressRef('RAPID_URL', 'api')).toBeUndefined();
    expect(addressRef('BACKEND_URL', 'api')).toBeUndefined();
  });

  it('injects the container address, lets a user value win, and reports unset names', () => {
    const run = monorepoRun();
    const services = deployServices(run);
    const web = envLinks(run, services, services[0]);
    expect(web).toEqual({ injected: { API_URL: 'http://app-api:4000' }, unset: ['SESSION_SECRET'], notes: [] });

    run.config.serviceEnv = { web: { API_URL: 'https://api.example.com' } };
    expect(envLinks(run, services, services[0]).injected).toEqual({});
    expect(envLinks(run, services, services[1]).unset).toEqual(['DATABASE_URL']);
  });

  it('never invents a value it cannot map: unknown names and static builds become notes', () => {
    const run = monorepoRun();
    run.analysis!.services![0].envVars = ['BACKEND_URL'];
    let services = deployServices(run);
    const unmapped = envLinks(run, services, services[0]);
    expect(unmapped.injected).toEqual({});
    expect(unmapped.notes[0]).toMatch(/web calls api, but none of the env vars it reads names api's address; you may need to set one/);

    Object.assign(run.analysis!.services![0], { kind: 'static', port: 8080, envVars: ['VITE_API_URL'] });
    services = deployServices(run);
    const stat = envLinks(run, services, services[0]);
    expect(stat.injected).toEqual({});
    expect(stat.unset).toEqual([]);
    expect(stat.notes[0]).toMatch(/you may need to set VITE_API_URL for web: it is a static build/);
  });
});

describe('ecr step (multi-service)', () => {
  it('pushes every service image into one repo as <runId>-<service>, keeping <runId> for the primary', async () => {
    ecr.on(DescribeRepositoriesCommand).rejects(awsErr('RepositoryNotFoundException'));
    ecr.on(CreateRepositoryCommand).resolves({ repository: { repositoryUri: REPO } });
    ecr.on(GetAuthorizationTokenCommand).resolves({ authorizationData: [{ authorizationToken: Buffer.from('AWS:pw').toString('base64') }] });
    const tag = vi.fn().mockResolvedValue(undefined);
    const push = vi.fn().mockResolvedValue('stream');
    const getImage = vi.fn(() => ({ tag, push }));
    dockerFactory.create = () => ({ getImage, modem: { followProgress: (_s: unknown, done: (e: null, ev: object[]) => void) => done(null, []) } }) as never;

    const run = monorepoRun();
    const res = await step('ecr').run(makeCtx(run));

    expect(res).toMatchObject({ ok: true, summary: 'Pushed 2 images · web, api' });
    expect(ecr).toHaveReceivedCommandTimes(CreateRepositoryCommand, 1);
    expect(ecr).toHaveReceivedCommandTimes(GetAuthorizationTokenCommand, 1);
    expect(getImage).toHaveBeenCalledWith('builddoctor/run123:latest');
    expect(getImage).toHaveBeenCalledWith('builddoctor/run123-api:latest');
    expect(tag.mock.calls.map((c) => c[0])).toEqual([{ repo: REPO, tag: 'run123' }, { repo: REPO, tag: 'run123-api' }]);
    expect(run.outputs.imageUri).toBe(`${REPO}:run123`);
    expect(run.outputs.services).toEqual({
      web: { port: 3000, container: 'app-web', imageUri: `${REPO}:run123` },
      api: { port: 4000, container: 'app-api', imageUri: `${REPO}:run123-api` },
    });
  });
});

describe('securityGroup step (multi-service)', () => {
  it('opens every service port plus openPorts on a new group, never 22', async () => {
    ec2.on(DescribeVpcsCommand).resolves({ Vpcs: [{ VpcId: 'vpc-1' }] });
    ec2.on(CreateSecurityGroupCommand).resolves({ GroupId: 'sg-new' });
    ec2.on(AuthorizeSecurityGroupIngressCommand).resolves({});
    const res = await step('securityGroup').run(makeCtx(monorepoRun({}, { openPorts: [22, 80] })));
    expect(res).toMatchObject({ ok: true, output: { ports: [3000, 4000, 80] } });
    const ports = ec2.commandCalls(AuthorizeSecurityGroupIngressCommand).map((c) => c.args[0].input.IpPermissions![0].FromPort);
    expect(ports).toEqual([3000, 4000, 80]);
  });

  it('adds only the missing service ports to a pre-existing group and records each rule', async () => {
    ec2.on(DescribeSecurityGroupsCommand).resolves(sgOpen(3000));
    ec2.on(AuthorizeSecurityGroupIngressCommand).resolves({});
    const run = monorepoRun({}, { existingSecurityGroupId: 'sg-1', openPorts: [80] });
    expect((await step('securityGroup').run(makeCtx(run))).ok).toBe(true);
    // Only 4000: 3000 is already open and openPorts never widen a user-owned group.
    expect(ec2).toHaveReceivedCommandTimes(AuthorizeSecurityGroupIngressCommand, 1);
    expect(ec2).toHaveReceivedCommandWith(AuthorizeSecurityGroupIngressCommand, { GroupId: 'sg-1', IpPermissions: [expect.objectContaining({ FromPort: 4000 })] });
    expect(run.outputs.created).toEqual([{ type: 'sg-rule', id: 'sg-1:4000:0.0.0.0/0' }]);
  });
});

describe('deploy step (multi-service)', () => {
  it('runs every service on one user-defined network with per-service env and dependency addresses', async () => {
    ec2.on(DescribeSecurityGroupsCommand).resolves(sgOpen(3000, 4000));
    ssm.on(PutParameterCommand).resolves({});
    commandReturns('app-api container: Up 3 seconds\napp-web container: Up 2 seconds');
    const run = deployed();
    const { ctx, serviceEvents } = ctxWithEvents(run);
    const res = await step('deploy').run(ctx);

    expect(res).toMatchObject({ ok: true, summary: '2 containers started · web :3000, api :4000', output: { network: 'builddoctor-run123' } });
    expect(ssm).toHaveReceivedCommandWith(PutParameterCommand, { Name: '/builddoctor/run123/env/LOG_LEVEL', Type: 'SecureString', Value: 'info' });
    expect(ssm).toHaveReceivedCommandWith(PutParameterCommand, { Name: '/builddoctor/run123/svc/api/env/DATABASE_URL', Type: 'SecureString', Value: SECRET });
    expect(ssm).toHaveReceivedCommandTimes(PutParameterCommand, 2); // the empty value is not stored

    const script = ssm.commandCalls(SendCommandCommand)[0].args[0].input.Parameters!.commands[0];
    expect(script).not.toContain(SECRET);
    expect(script).toContain('docker network inspect builddoctor-run123 >/dev/null 2>&1 || docker network create builddoctor-run123');
    expect(script).toContain(`docker pull -q ${REPO}:run123\n`);
    expect(script).toContain(`docker pull -q ${REPO}:run123-api`);
    const api = script.indexOf('docker run -d --name app-api --network builddoctor-run123 --restart unless-stopped -p 4000:4000 -e PORT=4000 --env-file /opt/builddoctor/app-api.env');
    const web = script.indexOf('docker run -d --name app-web --network builddoctor-run123 --restart unless-stopped -p 3000:3000 -e PORT=3000 --env-file /opt/builddoctor/app-web.env');
    expect(api).toBeGreaterThan(0);
    expect(web).toBeGreaterThan(api); // the dependency starts first
    expect(script).toContain("--name '/builddoctor/run123/svc/api/env/DATABASE_URL'");
    expect(script).toContain("printf '%s=\\n' EMPTY >> /opt/builddoctor/app-api.env");
    expect(script).toContain("printf '%s=%s\\n' API_URL 'http://app-api:4000' >> /opt/builddoctor/app-web.env");
    // Global env reaches both containers; api's own env stays with api.
    expect(script.match(/--name '\/builddoctor\/run123\/env\/LOG_LEVEL'/g)).toHaveLength(2);
    expect(script).not.toMatch(/DATABASE_URL.*app-web\.env/);
    expect(script).toContain("docker ps -a --filter name=^app-web$ --format 'app-web container: {{.Status}}'");
    expect(script).not.toMatch(/--name app /);
    expect(ctx.lines.join('\n')).not.toContain(SECRET);
    expect(ctx.lines).toContain('[web] API_URL=http://app-api:4000 (address of a service it calls)');

    expect(serviceEvents('deploy').filter((e) => e.status === 'success').map((e) => e.service)).toEqual(['web', 'api']);
    expect(run.outputs.services?.api).toMatchObject({ container: 'app-api', port: 4000 });
  });

  it('a service-level value overrides the global one and is fetched from the service parameter', async () => {
    ec2.on(DescribeSecurityGroupsCommand).resolves(sgOpen(3000, 4000));
    ssm.on(PutParameterCommand).resolves({});
    commandReturns('ok');
    const run = deployed(monorepoRun({ env: { LOG_LEVEL: 'info' }, serviceEnv: { api: { LOG_LEVEL: 'debug' } } }));
    expect((await step('deploy').run(makeCtx(run))).ok).toBe(true);
    const script = ssm.commandCalls(SendCommandCommand)[0].args[0].input.Parameters!.commands[0];
    const apiPart = script.slice(script.indexOf(': > /opt/builddoctor/app-api.env'), script.indexOf('docker run -d --name app-api'));
    expect(apiPart).toContain('/builddoctor/run123/svc/api/env/LOG_LEVEL');
    expect(apiPart).not.toContain("'/builddoctor/run123/env/LOG_LEVEL'");
  });

  it('marks services that did not start as failed when the script fails', async () => {
    ec2.on(DescribeSecurityGroupsCommand).resolves(sgOpen(3000, 4000));
    ssm.on(PutParameterCommand).resolves({});
    commandReturns('app-api container: Up 1 second\nError response from daemon: port is already allocated', 'Failed');
    const { ctx, serviceEvents } = ctxWithEvents(deployed());
    const res = await step('deploy').run(ctx);
    expect(res).toMatchObject({ ok: false, summary: 'Deploy command Failed' });
    expect(serviceEvents('deploy').filter((e) => e.status !== 'running').map((e) => [e.service, e.status])).toEqual([['web', 'failed'], ['api', 'success']]);
  });

  it('refuses to open port 22 even on a security group it created', async () => {
    ec2.on(DescribeSecurityGroupsCommand).resolves(sgOpen(3000));
    const run = deployed();
    run.analysis!.services![1].port = 22;
    run.outputs.created.push({ type: 'sg', id: 'sg-1' });
    const res = await step('deploy').run(makeCtx(run));
    expect(res).toMatchObject({ ok: false, service: 'api', error: expect.stringMatching(/Port 22 is never opened/) });
    expect(ec2).not.toHaveReceivedCommand(AuthorizeSecurityGroupIngressCommand);
  });
});

describe('health step (multi-service)', () => {
  const up = (failing: string[] = []) => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (failing.some((p) => url.includes(`:${p}/`))) throw new Error('ECONNREFUSED');
    return new Response('ok', { status: 200 });
  }));

  it('checks every public port and reports per-service URLs', async () => {
    up();
    const run = deployed();
    const { ctx, serviceEvents } = ctxWithEvents(run);
    const res = await step('health').run(ctx);
    expect(res).toMatchObject({ ok: true, summary: 'Live: 2 services healthy' });
    expect(run.outputs.appUrl).toBe('http://1.2.3.4:3000/');
    expect(run.outputs.services).toMatchObject({
      web: { url: 'http://1.2.3.4:3000/', port: 3000, healthy: true },
      api: { url: 'http://1.2.3.4:4000/', port: 4000, healthy: true },
    });
    expect(serviceEvents('health').filter((e) => e.status === 'success').map((e) => e.service)).toEqual(['web', 'api']);
  });

  it('picks a static frontend for appUrl', async () => {
    up();
    const run = deployed();
    Object.assign(run.analysis!.services![1], { kind: 'static', port: 8080 });
    run.outputs.services!.api.port = 8080;
    expect((await step('health').run(makeCtx(run))).ok).toBe(true);
    expect(run.outputs.appUrl).toBe('http://1.2.3.4:8080/');
  });

  it('diagnoses the failing service from its own container and patches only its port', async () => {
    up(['4000']);
    ec2.on(DescribeSecurityGroupsCommand).resolves(sgOpen(3000, 4000));
    commandReturns(`== docker logs --tail 100 app-api\napi listening on port 4100 db=${SECRET}`);
    vi.mocked(chatJson).mockResolvedValue({ rootCause: 'api listens on 4100', evidence: 'listening on port 4100', attemptedFix: 'map 4100', result: 'not-fixed', fixLevel: 'runtime-config', listenPort: 4100, missingEnv: [] });
    const run = deployed();
    const { ctx, serviceEvents } = ctxWithEvents(run);
    const res = await step('health').run(ctx);

    expect(res).toMatchObject({ ok: false, retryFrom: 'deploy', service: 'api', patch: { appPort: 4100, service: 'api' }, summary: '[api] App listens on 4100, not 4000' });
    const script = ssm.commandCalls(SendCommandCommand)[0].args[0].input.Parameters!.commands[0];
    expect(script).toContain('docker logs --tail 100 app-api');
    expect(script).toContain(":4000\\b");
    const prompt = JSON.stringify(vi.mocked(chatJson).mock.calls[0][0]);
    expect(prompt).toContain('Service: api');
    expect(prompt).not.toContain(SECRET);
    expect(ctx.lines.join('\n')).not.toContain(SECRET);
    expect(serviceEvents('health').filter((e) => e.status !== 'running').map((e) => [e.service, e.status])).toEqual([['web', 'success'], ['api', 'failed']]);
    expect(run.outputs.appUrl).toBeUndefined();

    // The engine applies it to api's planned port only.
    expect(applyPatch(run, (res as { patch: object }).patch)).toEqual({ applied: { appPort: 4100, service: 'api' } });
    expect(run.analysis!.services![1].port).toBe(4100);
    expect(run.config.appPort).toBe(3000);
    expect(deployServices(run)[1].port).toBe(4100);
  });

  it('asks for a missing env var for that service instead of retrying', async () => {
    up(['4000']);
    ec2.on(DescribeSecurityGroupsCommand).resolves(sgOpen(3000, 4000));
    commandReturns('== docker logs --tail 100 app-api\nError: REDIS_URL is not set');
    vi.mocked(chatJson).mockResolvedValue({ rootCause: 'no redis', evidence: 'REDIS_URL is not set', attemptedFix: '', result: 'not-fixed', fixLevel: 'runtime-config', missingEnv: ['REDIS_URL', 'DATABASE_URL'] });
    const res = await step('health').run(makeCtx(deployed()));
    expect(res).toMatchObject({
      ok: false, service: 'api', summary: '[api] Missing env var(s): REDIS_URL',
      diagnosis: { nextStep: expect.stringMatching(/^Please provide REDIS_URL for api /) },
    });
    expect(res).not.toHaveProperty('retryFrom');
  });

  it('opens a blocked service port on its own security group and retries the deploy', async () => {
    up(['4000']);
    ec2.on(DescribeSecurityGroupsCommand).resolves(sgOpen(3000));
    ec2.on(AuthorizeSecurityGroupIngressCommand).resolves({});
    const run = deployed();
    run.outputs.created.push({ type: 'sg', id: 'sg-1' });
    const res = await step('health').run(makeCtx(run));
    expect(res).toMatchObject({ ok: false, retryFrom: 'deploy', service: 'api', diagnosis: { rootCause: expect.stringContaining('tcp/4000 for api') } });
    expect(ec2).toHaveReceivedCommandWith(AuthorizeSecurityGroupIngressCommand, { IpPermissions: [expect.objectContaining({ FromPort: 4000 })] });
  });
});

describe('applyPatch (multi-service)', () => {
  it('rejects unknown services and no-op ports', () => {
    const run = monorepoRun();
    expect(applyPatch(run, { appPort: 5000, service: 'nope' })).toEqual({ rejected: 'unknown service nope' });
    expect(applyPatch(run, { appPort: 4000, service: 'api' })).toMatchObject({ rejected: expect.stringMatching(/already 4000/) });
    expect(applyPatch(run, { appPort: 3100, service: 'web' })).toEqual({ applied: { appPort: 3100, service: 'web' } });
    expect(run.config.appPort).toBe(3100);
  });
});

describe('approval plan (multi-service)', () => {
  it('lists each service with its port and image, the env wiring and what may need setting', () => {
    const req = approvalPlan(monorepoRun({}, { openPorts: [80] }));
    expect(req.actions).toEqual(expect.arrayContaining([
      'Create ECR repository builddoctor/my_app in ap-south-1 if missing, and push 2 images (one per service)',
      'Create security group with inbound tcp/3000, tcp/4000, tcp/80 from 0.0.0.0/0 (no SSH)',
      'Store env vars as SSM SecureString parameters',
      'Create Docker network builddoctor-run123 on the instance so the 2 services reach each other by container name',
      "Run container 'app-web' (web, image builddoctor/my_app:run123) on port 3000, with API_URL=http://app-api:4000",
      "Run container 'app-api' (api, image builddoctor/my_app:run123-api) on port 4000",
      'Env vars web reads that were not provided: SESSION_SECRET (you may need to set it)',
    ]));
    expect(req.services?.map((s) => [s.name, s.port, s.image])).toEqual([['web', 3000, 'builddoctor/my_app:run123'], ['api', 4000, 'builddoctor/my_app:run123-api']]);
    expect(JSON.stringify(req)).not.toContain(SECRET);
  });

  it('single-service plans are unchanged', () => {
    const run = makeRun({ env: { A: '1' } });
    expect(approvalPlan(run)).toEqual({ actions: plannedActions(run.config, 3000) });
    expect(approvalPlan(run).actions).toContain("Run container 'app' on port 3000");
  });
});

describe('teardown (multi-service)', () => {
  it('deletes every service image tag and every env parameter', async () => {
    const run = deployed();
    run.outputs.created = [{ type: 'ecr', id: 'builddoctor/my_app' }];
    run.config.aws.existingInstanceId = 'i-1';
    ecr.on(BatchDeleteImageCommand).resolves({});
    ecr.on(ListImagesCommand).resolves({ imageIds: [{ imageTag: 'other' }] });
    ssm.on(DeleteParametersCommand).resolves({ DeletedParameters: ['/builddoctor/run123/env/LOG_LEVEL', '/builddoctor/run123/svc/api/env/DATABASE_URL'] });

    const out = await teardown(run);
    expect(ecr).toHaveReceivedCommandWith(BatchDeleteImageCommand, { repositoryName: 'builddoctor/my_app', imageIds: [{ imageTag: 'run123' }, { imageTag: 'run123-api' }] });
    expect(ssm).toHaveReceivedCommandWith(DeleteParametersCommand, { Names: ['/builddoctor/run123/env/LOG_LEVEL', '/builddoctor/run123/svc/api/env/DATABASE_URL'] });
    expect(out).toEqual([
      "Kept pre-existing instance i-1 (the 'app-web', 'app-api' containers keep running)",
      'Kept pre-existing security group sg-1',
      'ECR images builddoctor/my_app:run123, builddoctor/my_app:run123-api deleted; repository builddoctor/my_app kept (still holds images from other runs)',
      '2 SSM env parameter(s) deleted',
    ]);
  });
});

describe('run store', () => {
  it('mirrors service events into the node state', () => {
    const store = new RunStore();
    const run = store.create(monorepoRun().config);
    store.emit(run.id, { type: 'service', node: 'build', service: 'api', status: 'running' });
    store.emit(run.id, { type: 'service', node: 'build', service: 'api', status: 'success', summary: '88 MB' });
    store.emit(run.id, { type: 'service', node: 'build', service: 'web', status: 'failed' });
    expect(run.nodes.build.services).toEqual({ api: { status: 'success', summary: '88 MB' }, web: { status: 'failed' } });
  });
});
