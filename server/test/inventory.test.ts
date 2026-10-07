import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildInventory, globToRegExp, renderInventory } from '../src/steps/inventory.js';

const fx = (name: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name);
const tmp: string[] = [];

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bd-inv-'));
  tmp.push(dir);
  for (const [f, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, f)), { recursive: true });
    await writeFile(path.join(dir, f), content);
  }
  return dir;
}

afterAll(async () => {
  for (const d of tmp) await rm(d, { recursive: true, force: true });
});

describe('inventory', () => {
  it('workspaces monorepo: packages from the workspace globs, dependency edges, port evidence with provenance', async () => {
    const inv = await buildInventory(fx('workspaces-monorepo'));
    expect(inv.packages.map((p) => p.dir)).toEqual(['.', 'apps/api', 'apps/web', 'packages/shared']);
    expect(inv.workspaces).toEqual([{ source: 'package.json workspaces', patterns: ['apps/*', 'packages/*'] }]);
    expect(inv.packages.every((p) => p.inWorkspace)).toBe(true);
    expect(inv.lockfiles).toEqual(['package-lock.json']);
    const shared = inv.packages.find((p) => p.dir === 'packages/shared')!;
    expect(shared.dependents.sort()).toEqual(['@demo/api', '@demo/web']);
    expect(inv.packages.find((p) => p.dir === 'apps/api')!.workspaceDeps).toEqual(['@demo/shared']);

    const api = inv.ports.filter((e) => e.pkg === 'apps/api');
    expect(api).toContainEqual(expect.objectContaining({ file: 'apps/api/server.js', line: 4, port: 4000, envVar: 'PORT', kind: 'code' }));
    expect(api).toContainEqual(expect.objectContaining({ file: 'apps/api/.env.example', port: 4000, kind: 'env-example' }));
    const web = inv.ports.filter((e) => e.pkg === 'apps/web');
    expect(web).toContainEqual(expect.objectContaining({ file: 'apps/web/config/default.json', port: 5050, kind: 'config' }));
    // The api URL the web app calls is evidence, but marked as a URL, not a listen port.
    expect(web).toContainEqual(expect.objectContaining({ file: 'apps/web/server.js', port: 4000, url: true }));
    expect(inv.ports.map((e) => e.id)).toEqual(inv.ports.map((_, i) => `e${i + 1}`));
    expect(inv.envByPackage['apps/web']).toContain('API_URL');
  });

  it('never puts env values in the rendered inventory; only names and example ports', async () => {
    const text = renderInventory(await buildInventory(fx('workspaces-monorepo')));
    expect(text).toContain('API_TOKEN');
    expect(text).not.toContain('example-token-do-not-use');
    const dir = await repo({ 'package.json': '{"name":"x","scripts":{"start":"node a.js"}}', 'a.js': 'require("http").createServer().listen(process.env.PORT)', '.env': 'PORT=7777\nSECRET=hunter2-value' });
    const t = renderInventory(await buildInventory(dir));
    expect(t).not.toContain('hunter2-value');
    expect(t).not.toContain('7777');
  });

  it('pnpm-workspace.yaml, go.work and Cargo workspaces declare packages', async () => {
    const dir = await repo({
      'pnpm-workspace.yaml': "packages:\n  - 'services/*'\n  - \"!services/ignored\"\n",
      'package.json': '{"name":"root","packageManager":"pnpm@9.1.0"}',
      'services/a/package.json': '{"name":"a","scripts":{"start":"node index.js --port 7001"}}',
      'services/a/index.js': '',
      'go.work': 'go 1.22\n\nuse (\n  ./gosvc\n)\n',
      'gosvc/go.mod': 'module example.com/gosvc\n\ngo 1.22\n',
      'gosvc/cmd/api/main.go': 'package main\n\nfunc main() { http.ListenAndServe(":8081", nil) }\n',
      'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
      'examples/demo/package.json': '{"name":"demo"}',
    });
    const inv = await buildInventory(dir);
    expect(inv.workspaces.map((w) => w.source)).toEqual(['pnpm-workspace.yaml', 'go.work', 'Cargo.toml [workspace]']);
    expect(inv.workspaces[0].patterns).toEqual(['services/*', '!services/ignored']);
    expect(inv.packages.map((p) => p.dir)).toEqual(['.', 'gosvc', 'services/a']); // examples/ outside the workspace is left out
    expect(inv.packages.find((p) => p.dir === 'gosvc')!.mainDirs).toEqual(['gosvc/cmd/api']);
    expect(inv.ports).toContainEqual(expect.objectContaining({ file: 'services/a/package.json', port: 7001, kind: 'script' }));
    expect(inv.ports).toContainEqual(expect.objectContaining({ file: 'gosvc/cmd/api/main.go', port: 8081, pkg: 'gosvc' }));
    expect(inv.pins).toContainEqual(expect.objectContaining({ runtime: 'go', spec: '1.22', dir: 'gosvc' }));
  });

  it('port evidence from Dockerfiles, compose, Procfiles and env-only reads', async () => {
    const dir = await repo({
      'requirements.txt': 'flask\ngunicorn\n',
      'app.py': 'from flask import Flask\napp = Flask(__name__)\n',
      'Procfile': 'web: gunicorn app:app --bind 0.0.0.0:$PORT\n',
      'Dockerfile': 'FROM python:3.12-slim\nEXPOSE 9000\n',
      'docker-compose.yml': 'services:\n  web:\n    ports:\n      - "8080:9000"\n',
      'main.go': 'package main\nfunc main() { port := os.Getenv("PORT") }\n',
    });
    const inv = await buildInventory(dir);
    const by = (f: string) => inv.ports.filter((e) => e.file === f);
    expect(by('Procfile')).toEqual([expect.objectContaining({ envVar: 'PORT', port: undefined, kind: 'procfile' })]);
    expect(by('Dockerfile')).toEqual([expect.objectContaining({ port: 9000, kind: 'dockerfile' })]);
    expect(by('docker-compose.yml')).toEqual([expect.objectContaining({ port: 9000, kind: 'compose' })]); // container side
    expect(by('main.go')).toEqual([expect.objectContaining({ envVar: 'PORT', kind: 'code' })]);
  });

  it('globToRegExp', () => {
    expect(globToRegExp('apps/*').test('apps/web')).toBe(true);
    expect(globToRegExp('apps/*').test('apps/web/x')).toBe(false);
    expect(globToRegExp('packages/**').test('packages/a/b')).toBe(true);
    expect(globToRegExp('./svc/').test('svc')).toBe(true);
  });
});
