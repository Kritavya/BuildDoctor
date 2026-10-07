import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const replies: unknown[] = [];
const prompts: string[][] = [];
vi.mock('../src/llm/ollama.js', () => ({
  chat: vi.fn(),
  chatJson: vi.fn(async (messages: Array<{ content: string }>) => {
    prompts.push(messages.map((m) => m.content));
    if (!replies.length) throw new Error('no mocked reply');
    return replies.shift();
  }),
}));

const { buildInventory } = await import('../src/steps/inventory.js');
const { fileProblems, normalizeImage, planServices, scriptProblems, validatePlan } = await import('../src/steps/plan.js');

const fx = (name: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name);
const inv = await buildInventory(fx('workspaces-monorepo'));
const evidence = (file: string, port: number) => inv.ports.find((e) => e.file === file && e.port === port)!.id;

const good = () => ({
  services: [
    { name: 'api', root: 'apps/api', context: '.', kind: 'server', runtime: 'node', runtimeImage: 'node:22-slim', installCommand: 'npm ci', startCommand: 'npm start', port: 4000, portEvidence: evidence('apps/api/server.js', 4000), dependsOn: [] },
    { name: 'web', root: 'apps/web', context: '.', kind: 'server', runtime: 'node', runtimeImage: 'node:22-slim', installCommand: 'npm ci', startCommand: 'npm start', port: 5050, portEvidence: evidence('apps/web/config/default.json', 5050), dependsOn: ['api'] },
  ],
  skipped: [{ root: 'packages/shared', reason: 'library used by both apps' }],
});

beforeEach(() => {
  replies.length = 0;
  prompts.length = 0;
});

describe('service plan validation', () => {
  it('accepts a plan that matches the inventory', () => {
    expect(validatePlan(inv, good()).problems).toEqual([]);
  });

  it('rejects scripts that do not exist, unevidenced ports, library services and uncovered servers', () => {
    const plan = good();
    plan.services[0].startCommand = 'npm run serve';
    plan.services[1].port = 3000;
    plan.services[1].portEvidence = 'framework default';
    plan.services.push({ name: 'shared', root: 'packages/shared', context: '.', kind: 'server', runtime: 'node', runtimeImage: 'node:22-slim', installCommand: 'npm ci', startCommand: 'node index.js', port: 8080, portEvidence: '', dependsOn: [] });
    plan.skipped = [];
    const { problems, valid } = validatePlan(inv, plan);
    expect(problems.join('\n')).toMatch(/"npm run serve" runs script "serve", which does not exist in apps\/api\/package.json \(scripts: dev, start\)/);
    expect(problems.join('\n')).toMatch(/port 3000 for "web" has no evidence \(evidence for apps\/web: e\d+=5050/);
    expect(problems.join('\n')).toMatch(/packages\/shared is a library used by @demo\/api, @demo\/web/);
    expect(valid).toEqual([]);
    // shared is not flagged as uncovered: it has no server code
    expect(problems.join('\n')).not.toMatch(/package packages\/shared has server code/);
    const missing = validatePlan(inv, { services: [good().services[0]], skipped: [] }).problems;
    expect(missing).toEqual([expect.stringMatching(/package apps\/web has server code \(e\d+/)]);
  });

  it('workspace members must build from the repo root; dev servers are rejected when a build exists', () => {
    const plan = good();
    plan.services[0].context = 'apps/api';
    expect(validatePlan(inv, plan).problems).toEqual(['service "api": it depends on repo packages (@demo/shared), so the context must be "." for them to be part of the build']);
  });

  it('accepts a port pinned by the start command or read from an env var', () => {
    const plan = good();
    plan.services[1].startCommand = 'npm start -- --port 6000';
    plan.services[1].port = 6000;
    plan.services[1].portEvidence = 'start command';
    expect(validatePlan(inv, plan).problems).toEqual([]);
    const env = good();
    env.services[0].port = 9999; // api reads PORT, so the container sets it
    env.services[0].portEvidence = '';
    expect(validatePlan(inv, env).problems).toEqual([]);
  });

  it('resolves workspace-targeted scripts and lockfile flags', () => {
    expect(scriptProblems(inv, 'npm run start -w apps/api', '.')).toEqual([]);
    expect(scriptProblems(inv, 'npm run start --workspace=@demo/web', '.')).toEqual([]);
    expect(scriptProblems(inv, 'cd apps/api && npm start', '.')).toEqual([]);
    expect(scriptProblems(inv, 'pnpm --filter @demo/api build', '.')).toEqual([expect.stringMatching(/runs script "build", which does not exist in apps\/api/)]);
    expect(scriptProblems(inv, 'yarn workspace @demo/nope start', '.')).toEqual(['yarn workspace "@demo/nope" does not match any package in the repo']);
    expect(scriptProblems(inv, 'npm run dev --workspaces --if-present', '.')).toEqual([]);
    expect(fileProblems(inv, 'node server.js', 'apps/api', false)).toEqual([]);
    expect(fileProblems(inv, 'node dist/server.js', 'apps/api', false)).toEqual([expect.stringMatching(/apps\/api\/dist\/server.js, which does not exist/)]);
    expect(fileProblems(inv, 'node dist/server.js', 'apps/api', true)).toEqual([]);
  });

  it('rejects bare node_modules executables and ports borrowed from a script the start command does not run', async () => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    const os = await import('node:os');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bd-plan-'));
    await mkdir(path.join(dir, 'web'), { recursive: true });
    await writeFile(path.join(dir, 'web/package.json'), JSON.stringify({ name: 'web', scripts: { dev: 'next dev --port 3001', build: 'next build', start: 'next start' }, dependencies: { next: '16' } }, null, 2));
    const i2 = await buildInventory(dir);
    const e = i2.ports.find((p) => p.port === 3001)!.id;
    const raw = { services: [{ name: 'web', root: 'web', context: 'web', kind: 'server', runtime: 'node', installCommand: 'npm install', buildCommand: 'npm run build', startCommand: 'next start', port: 3001, portEvidence: e }] };
    const problems = validatePlan(i2, raw).problems.join('\n');
    expect(problems).toMatch(/"next" is a dependency's executable in node_modules\/.bin/);
    expect(problems).toMatch(new RegExp(`${e} is the port of script "dev", which the start command "next start" does not run`));
  });

  it('takes a provisional port when the repo names none for the package', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const os = await import('node:os');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bd-plan-'));
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'site', scripts: { build: 'x build', start: 'x start' } }));
    const i2 = await buildInventory(dir);
    const v = validatePlan(i2, { services: [{ name: 'site', root: '.', kind: 'server', runtime: 'node', installCommand: 'npm install', buildCommand: 'npm run build', startCommand: 'npm start', port: null as unknown as number }] });
    expect(v.problems).toEqual([]);
    expect(v.services[0]).toMatchObject({ port: 8080, portEvidence: expect.stringMatching(/^provisional/) });
  });

  it('keeps the repo version pin and moves unsupported runtime images forward', () => {
    expect(normalizeImage('node:14', 'node', undefined)).toBe('node:22-slim');
    expect(normalizeImage('node:20-alpine', 'node', '^20')).toBe('node:20-alpine');
    expect(normalizeImage('node:16', 'node', '18.x')).toBe('node:18-slim');
    expect(normalizeImage('python:3.9-slim', 'python', '3.13')).toBe('python:3.13-slim');
    expect(normalizeImage('nginx:alpine', 'node', undefined)).toBe('nginx:alpine');
    expect(normalizeImage('golang:1.20-slim', 'go', '1.25')).toBe('golang:1.25');
  });
});

describe('planServices (mocked model)', () => {
  it('first valid plan wins; Dockerfiles go next to each app, context is the repo root', async () => {
    replies.push(good());
    const p = await planServices(inv);
    expect(p.source).toBe('model');
    expect(p.attempts).toBe(1);
    expect(p.services.map((s) => [s.name, s.root, s.context, s.dockerfile, s.existingDockerfile, s.port])).toEqual([
      ['api', 'apps/api', '.', 'apps/api/Dockerfile', false, 4000],
      ['web', 'apps/web', '.', 'apps/web/Dockerfile', false, 5050],
    ]);
    expect(p.services[1].envVars).toContain('API_URL');
    expect(p.skipped).toEqual([{ root: 'packages/shared', reason: 'library used by both apps' }]);
    // the model sees facts with provenance, not values from env files
    expect(prompts[0][1]).toMatch(/apps\/web\/config\/default.json:2 \[apps\/web\] port=5050/);
    expect(prompts[0][1]).not.toContain('example-token-do-not-use');
  });

  it('feeds validation errors back and retries', async () => {
    const bad = good();
    bad.services[1].startCommand = 'npm run prod';
    replies.push(bad, good());
    const logs: string[] = [];
    const p = await planServices(inv, { log: (l) => logs.push(l) });
    expect(p.source).toBe('model');
    expect(p.attempts).toBe(2);
    expect(p.rejected).toHaveLength(1);
    expect(prompts[1].at(-1)).toMatch(/That plan does not match the repository:\n- service "web" startCommand: "npm run prod" runs script "prod"/);
    expect(logs[0]).toMatch(/plan attempt 1 rejected/);
  });

  it('salvages the valid services after the retry budget, and reports nothing when the model is down', async () => {
    const bad = good();
    bad.services[1].startCommand = 'npm run prod';
    replies.push(bad, bad, bad);
    const p = await planServices(inv);
    expect(p.source).toBe('salvaged');
    expect(p.services.map((s) => s.name)).toEqual(['api']);
    const down = await planServices(inv);
    expect(down).toMatchObject({ source: 'fallback', services: [] });
  });
});
