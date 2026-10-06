// HTTP API for the web UI (routes listed at the bottom of types.ts).
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import cors from 'cors';
import express, { type Request, type Response } from 'express';
import { awsSteps, plannedActions, setDashboard, teardown } from './aws/steps.js';
import { appPort } from './aws/util.js';
import { MODEL, ollamaReady } from './llm/ollama.js';
import { Engine } from './pipeline/engine.js';
import { RunStore } from './pipeline/store.js';
import { docker, imageTag } from './steps/common.js';
import { localSteps } from './steps/index.js';
import type { InstanceSize, RunConfig, RunState } from './types.js';

const INSTANCE_SIZES: InstanceSize[] = ['t4g.micro', 't4g.small', 't4g.medium'];

export function createApp(
  store = new RunStore(),
  engine = new Engine(store, [...localSteps, ...awsSteps], {
    planApproval: (run) => ({ actions: plannedActions(run.config, appPort(run)) }),
    cleanup: removeLocalImages,
  }),
) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  const getRun = (req: Request, res: Response) => {
    const run = store.get(String(req.params.id));
    if (!run) res.status(404).json({ error: 'run not found' });
    return run;
  };

  app.post('/api/runs', (req, res) => {
    const problem = validateConfig(req.body);
    if (problem) return void res.status(400).json({ error: problem });
    const body = req.body as RunConfig;
    const config: RunConfig = { ...body, aws: { ...body.aws, openPorts: body.aws.openPorts ?? [] } };
    const run = store.create(config);
    void engine.start(run);
    res.status(201).json({ id: run.id });
  });

  app.get('/api/runs', (_req, res) => {
    res.json(store.list().map((r) => ({ id: r.id, repoUrl: redactUrl(r.config.repoUrl), status: r.status, createdAt: r.createdAt })));
  });

  app.get('/api/runs/:id', (req, res) => {
    const run = getRun(req, res);
    if (run) res.json(redactRun(run));
  });

  app.get('/api/runs/:id/events', (req, res) => {
    const run = getRun(req, res);
    if (!run) return;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.flushHeaders();
    const unsubscribe = store.subscribe(run.id, (e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  app.post('/api/runs/:id/approve', (req, res) => {
    const run = getRun(req, res);
    if (!run) return;
    if (typeof req.body?.approved !== 'boolean') return void res.status(400).json({ error: 'body must be { approved: boolean }' });
    if (!engine.approve(run.id, req.body.approved)) return void res.status(409).json({ error: `run is not awaiting approval (status: ${run.status})` });
    res.json({ ok: true });
  });

  app.post('/api/runs/:id/dashboard', async (req, res) => {
    const run = getRun(req, res);
    if (!run) return;
    if (typeof req.body?.enabled !== 'boolean') return void res.status(400).json({ error: 'body must be { enabled: boolean }' });
    if (run.status !== 'live') return void res.status(409).json({ error: `dashboard needs a live run (status: ${run.status})` });
    try {
      const dashboard = await setDashboard(run, req.body.enabled);
      // Mirror into the event stream so other tabs and replays see the new state.
      store.emit(run.id, { type: 'output', node: 'dashboard', data: dashboard });
      store.nodeLog(run.id, 'dashboard', `Dashboard turned ${req.body.enabled ? 'on' : 'off'}`);
      res.json(dashboard);
    } catch (err) {
      res.status(500).json({ error: message(err) });
    }
  });

  app.post('/api/runs/:id/teardown', async (req, res) => {
    const run = getRun(req, res);
    if (!run) return;
    // Wait for the pipeline to stop so a step mid-way through creating a resource has recorded it.
    await engine.cancel(run.id);
    try {
      const deleted = await teardown(run);
      run.status = 'torn-down';
      for (const line of deleted) store.nodeLog(run.id, 'dashboard', `teardown: ${line}`);
      res.json({ deleted });
    } catch (err) {
      res.status(500).json({ error: message(err) });
    }
  });

  app.get('/api/health/local', async (_req, res) => {
    const [dockerOk, ollama, awsAccount] = await Promise.all([
      docker.ping().then(() => true, () => false),
      ollamaReady(),
      callerAccount(),
    ]);
    res.json({ docker: dockerOk, ollama, model: MODEL, awsAccount });
  });

  return app;
}

async function callerAccount(): Promise<string | undefined> {
  try {
    const sts = new STSClient({ region: process.env.AWS_REGION ?? 'us-east-1', profile: process.env.AWS_PROFILE });
    const id = await sts.send(new GetCallerIdentityCommand({}), { abortSignal: AbortSignal.timeout(5000) });
    return id.Account;
  } catch {
    return undefined;
  }
}

function validateConfig(b: unknown): string | undefined {
  const c = b as Partial<RunConfig> | undefined;
  if (!c || typeof c.repoUrl !== 'string' || !/^(https:\/\/|git@)/.test(c.repoUrl)) return 'repoUrl must be an https:// or git@ URL';
  if (c.branch !== undefined && (typeof c.branch !== 'string' || !/^[\w./-]+$/.test(c.branch))) return 'invalid branch';
  if (c.appPort !== undefined && !(Number.isInteger(c.appPort) && c.appPort > 0 && c.appPort < 65536)) return 'invalid appPort';
  if (c.env !== undefined && (typeof c.env !== 'object' || Object.values(c.env).some((v) => typeof v !== 'string'))) return 'env must be a string map';
  if (!c.aws || typeof c.aws.region !== 'string' || !/^[a-z]{2}-[a-z]+-\d$/.test(c.aws.region)) return 'aws.region is required';
  if (!INSTANCE_SIZES.includes(c.aws.instanceType)) return `aws.instanceType must be one of ${INSTANCE_SIZES.join(', ')}`;
  if (c.aws.openPorts !== undefined && (!Array.isArray(c.aws.openPorts) || c.aws.openPorts.some((p) => !Number.isInteger(p) || p < 1 || p > 65535))) return 'invalid aws.openPorts';
  if (c.maxFixAttempts !== undefined && !(Number.isInteger(c.maxFixAttempts) && c.maxFixAttempts >= 0 && c.maxFixAttempts <= 10)) return 'maxFixAttempts must be 0-10';
  return undefined;
}

// Env values never leave the server; the UI only needs the names.
function redactRun<T extends { config: RunConfig }>(run: T): T {
  const env = run.config.env && Object.fromEntries(Object.keys(run.config.env).map((k) => [k, '***']));
  return { ...run, config: { ...run.config, env, repoUrl: redactUrl(run.config.repoUrl) } };
}

// Credentials embedded in an https clone URL.
function redactUrl(url: string): string {
  return url.replace(/(https?:\/\/)[^@\s/]+@/, '$1***@');
}

async function removeLocalImages(run: RunState): Promise<void> {
  const tags = [imageTag(run.id), ...(run.outputs.ecrRepoUri ? [`${run.outputs.ecrRepoUri}:${run.id}`] : [])];
  for (const t of tags) await docker.getImage(t).remove({ force: true }).catch(() => {});
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

if (!process.env.VITEST) {
  const port = Number(process.env.PORT ?? 4000);
  createApp().listen(port, () => console.log(`BuildDoctor server on :${port}`));
}
