// Framework-agnostic repo inventory: facts with provenance, gathered without guessing.
// Packages come from the manifests (workspace globs, go.work, Cargo workspaces) plus any manifest found
// in the tree; ports come with the file and line they were seen on. The planner reasons over this.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { readText } from './common.js';

export interface PortEvidence {
  id: string;            // e1, e2, ... cited by the service plan
  file: string;          // repo-relative path
  line: number;
  text: string;          // the source line, trimmed (never taken from real .env files)
  kind: 'code' | 'script' | 'config' | 'dockerfile' | 'compose' | 'env-example' | 'procfile' | 'readme';
  port?: number;         // literal port on that line, if any
  envVar?: string;       // env var the port is read from, if any (PORT, API_PORT, ...)
  pkg: string;           // owning package dir
  url?: boolean;         // the port is part of a URL the code calls, not one it listens on
}

export interface PackageInfo {
  dir: string;                       // '.' or e.g. 'apps/api'
  manifests: string[];               // manifest files in this dir
  runtime: string;                   // from the manifest type: node, python, go, rust, java, ruby, php
  inWorkspace: boolean;              // root, or matched by a workspace declaration
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: string[];           // names only
  devDependencies?: string[];
  engines?: Record<string, string>;
  packageManager?: string;
  main?: string;
  moduleType?: string;
  workspaceDeps: string[];           // other packages of this repo it depends on (by name or dir)
  dependents: string[];              // packages of this repo that depend on it
  sourceFiles: string[];             // top-level source files of the package and its src/ (no tests)
  mainDirs?: string[];               // go: dirs holding `package main`
  dockerfiles: string[];
}

export interface Inventory {
  tree: string[];
  files: string[];                   // every file path (validation only, not sent to the model)
  packages: PackageInfo[];
  workspaces: Array<{ source: string; patterns: string[] }>;
  lockfiles: string[];
  configs: Array<{ path: string; content: string }>;
  ports: PortEvidence[];
  envVars: string[];                 // names only
  envByPackage: Record<string, string[]>; // env var names by the package dir whose files read them
  pins: Array<{ dir: string; runtime: string; spec: string; source: string }>; // runtime version pins
  readme: string[];                  // run instructions quoted from READMEs
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'venv', '.venv', 'env', '__pycache__', 'dist', 'build', '.next', '.nuxt', '.turbo', '.cache', 'vendor', 'target', 'coverage', '.idea', '.vscode', '.github', 'out', '.svelte-kit', '.output']);
const MANIFESTS: Record<string, string> = {
  'package.json': 'node', 'requirements.txt': 'python', 'pyproject.toml': 'python', 'Pipfile': 'python', 'setup.py': 'python',
  'go.mod': 'go', 'Cargo.toml': 'rust', 'pom.xml': 'java', 'build.gradle': 'java', 'build.gradle.kts': 'java', 'Gemfile': 'ruby', 'composer.json': 'php',
};
const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'go.sum', 'Cargo.lock', 'Gemfile.lock', 'composer.lock']);
const SOURCE_EXT = /\.(m?[jt]sx?|cjs|cts|py|go|rb|rs|java|kt|php|ex|exs|cs)$/;
const TEST_PATH = /(^|\/)(test|tests|__tests__|e2e|spec|fixtures|__mocks__)\/|\.(test|spec|e2e-spec)\.[a-z]+$|(^|\/)(test|tests|conftest)(_[\w]+)?\.[a-z]+$/;
// Tooling config that never affects how a service runs; left out to keep the prompt small.
const NOISE_CONFIG = /(eslint|prettier|stylelint|lint|tsconfig|jest|vitest|babel|postcss|tailwind|renovate|dependabot|biome|cspell|changie|commitlint|codecov|editorconfig|components\.json|jsconfig|\.vscode|lock)/i;
const ENV_FILE = /(^|\/)\.env(\.|$)/;
const ENV_EXAMPLE = /(^|\/)\.env\.(example|sample|template|dist|defaults)$/;

// Every file under dir with its depth (skips dependency/build output dirs), capped.
async function listFiles(dir: string, limit = 5000): Promise<string[]> {
  const out: string[] = [];
  async function go(rel: string): Promise<void> {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = await readdir(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= limit) return;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await go(p);
      } else if (e.isFile()) out.push(p);
    }
  }
  await go('');
  return out;
}

const dirOf = (f: string) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.');
const depth = (f: string) => f.split('/').length;
const within = (f: string, dir: string) => dir === '.' || f === dir || f.startsWith(`${dir}/`);

// Workspace glob ('apps/*', 'packages/**', './svc') -> matcher on directory paths.
export function globToRegExp(glob: string): RegExp {
  const g = glob.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  const re = g.split('/').map((seg) => (seg === '**' ? '.*' : seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))).join('/');
  return new RegExp(`^${re.replace(/\/\.\*$/, '(/.*)?')}$`);
}

function parseJson<T>(text: string | undefined): T | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

// Workspace declarations from the manifests themselves.
async function workspaceDecls(dir: string, files: Set<string>): Promise<Inventory['workspaces']> {
  const out: Inventory['workspaces'] = [];
  const pkg = parseJson<{ workspaces?: string[] | { packages?: string[] } }>(await readText(path.join(dir, 'package.json')));
  const ws = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages;
  if (ws?.length) out.push({ source: 'package.json workspaces', patterns: ws.filter((p) => typeof p === 'string') });
  if (files.has('pnpm-workspace.yaml')) {
    const text = (await readText(path.join(dir, 'pnpm-workspace.yaml'))) ?? '';
    const block = text.split(/^packages:\s*$/m)[1]?.split(/^\S/m)[0] ?? '';
    const patterns = [...block.matchAll(/^\s*-\s*['"]?([^'"#\n]+?)['"]?\s*$/gm)].map((m) => m[1]);
    if (patterns.length) out.push({ source: 'pnpm-workspace.yaml', patterns });
  }
  const lerna = parseJson<{ packages?: string[] }>(await readText(path.join(dir, 'lerna.json')));
  if (lerna?.packages?.length) out.push({ source: 'lerna.json', patterns: lerna.packages });
  if (files.has('go.work')) {
    const text = (await readText(path.join(dir, 'go.work'))) ?? '';
    const uses = [...text.matchAll(/^\s*use\s+(\S+)\s*$/gm)].map((m) => m[1]);
    const block = text.match(/use\s*\(([\s\S]*?)\)/)?.[1] ?? '';
    uses.push(...block.split('\n').map((l) => l.replace(/\/\/.*$/, '').trim()).filter(Boolean));
    if (uses.length) out.push({ source: 'go.work', patterns: uses });
  }
  if (files.has('Cargo.toml')) {
    const text = (await readText(path.join(dir, 'Cargo.toml'))) ?? '';
    const members = text.match(/\[workspace\][\s\S]*?members\s*=\s*\[([\s\S]*?)\]/)?.[1];
    if (members) out.push({ source: 'Cargo.toml [workspace]', patterns: [...members.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]) });
  }
  return out;
}

// Port evidence on one line; returns undefined when the line says nothing about a port.
const PORT_ENV = /\b((?:[A-Z][A-Z0-9_]*_)?PORT)\b/;
const PORT_LITERALS: RegExp[] = [
  /\.listen\(\s*['"]?(\d{2,5})\b/,                                                            // listen(3000)
  /\b[A-Z_]*PORT\b['"\])]*\s*(?:\|\||\?\?|\bor\b|,|:-|:=)\s*(?:int\()?\s*['"]?(\d{2,5})\b/,      // PORT || 3000, getenv("PORT", "8000"), ${PORT:-3000}
  /\bport['"]?\s*[:=]\s*(?:int\()?\s*['"]?(\d{2,5})\b/i,                                         // port: 3000, port=5000
  /(?:^|\s)(?:--port|-p|--listen|-l|--bind|-b|--http-port)[ =](?:['"]?[\w.[\]-]*:)?['"]?(\d{2,5})\b/, // --port 8000, -b 0.0.0.0:8000
  /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]|\*)?:(\d{4,5})\b/,                                  // localhost:3000, ":8080"
  /^\s*EXPOSE\s+(\d{2,5})/i,
];

// Port facts on one line. `code` lines also count a bare listen/serve call as server evidence.
function portOnLine(line: string, code = false): { port?: number; envVar?: string } | undefined {
  let port: number | undefined;
  for (const re of PORT_LITERALS) {
    const m = line.match(re);
    if (m) {
      const n = Number(m[1]);
      if (n >= 80 && n <= 65535 && n !== 22) {
        port = n;
        break;
      }
    }
  }
  const env = line.match(PORT_ENV)?.[1];
  // In code, `${PORT}` is string interpolation of a variable; elsewhere (shell, compose) it reads the env.
  const readsEnv = env && (/(process\.env|environ|getenv|Getenv|env\(|ENV\[|System\.getenv|std::env|import\.meta\.env)/.test(line) || (!code && /\$\{?[A-Z_]*PORT/.test(line)));
  if (port === undefined && !readsEnv && !(code && /\blisten(AndServe)?\s*\(/i.test(line))) return undefined;
  return { port, envVar: readsEnv ? env : undefined };
}

function kindOf(f: string): PortEvidence['kind'] {
  const base = f.split('/').pop()!;
  if (/^Dockerfile|\.Dockerfile$/i.test(base)) return 'dockerfile';
  if (/^(docker-)?compose.*\.ya?ml$/i.test(base)) return 'compose';
  if (ENV_EXAMPLE.test(f)) return 'env-example';
  if (/^Procfile/.test(base)) return 'procfile';
  if (/^readme/i.test(base)) return 'readme';
  if (SOURCE_EXT.test(base) && !/\.config\.[a-z]+$/.test(base)) return 'code';
  return 'config';
}

export async function buildInventory(dir: string): Promise<Inventory> {
  const files = await listFiles(dir);
  const fileSet = new Set(files);
  const read = (f: string) => readText(path.join(dir, f), 300_000);

  // Packages: every dir with a manifest (depth-limited), marked when a workspace declaration covers it.
  const workspaces = await workspaceDecls(dir, fileSet);
  const matchers = workspaces.flatMap((w) => w.patterns.filter((p) => !p.startsWith('!')).map(globToRegExp));
  const pkgDirs = new Map<string, string[]>();
  for (const f of files) {
    const base = f.split('/').pop()!;
    if (!(base in MANIFESTS) || depth(f) > 5 || TEST_PATH.test(f) || /(^|\/)(examples?|templates?|docs?)\//.test(f) && !matchers.some((m) => m.test(dirOf(f)))) continue;
    const d = dirOf(f);
    pkgDirs.set(d, [...(pkgDirs.get(d) ?? []), base]);
  }
  // A Django-style project with only manage.py and no manifest still counts as a python package.
  for (const f of files) if (f.endsWith('manage.py') && depth(f) <= 3 && !pkgDirs.has(dirOf(f))) pkgDirs.set(dirOf(f), []);

  const packages: PackageInfo[] = [];
  const byName = new Map<string, PackageInfo>();
  for (const [d, manifests] of [...pkgDirs].sort(([a], [b]) => (a === '.' ? -1 : b === '.' ? 1 : a.localeCompare(b))).slice(0, 30)) {
    const runtime = manifests.map((m) => MANIFESTS[m])[0] ?? (fileSet.has(d === '.' ? 'manage.py' : `${d}/manage.py`) ? 'python' : 'unknown');
    const p: PackageInfo = {
      dir: d,
      manifests,
      runtime: manifests.includes('package.json') ? 'node' : runtime,
      inWorkspace: d === '.' || matchers.some((m) => m.test(d)),
      workspaceDeps: [],
      dependents: [],
      sourceFiles: [],
      dockerfiles: files.filter((f) => dirOf(f) === d && /^Dockerfile|\.Dockerfile$/i.test(f.split('/').pop()!)),
    };
    if (manifests.includes('package.json')) {
      const pj = parseJson<Record<string, unknown>>(await read(d === '.' ? 'package.json' : `${d}/package.json`)) ?? {};
      if (typeof pj.name === 'string') p.name = pj.name;
      if (pj.scripts && typeof pj.scripts === 'object') p.scripts = pj.scripts as Record<string, string>;
      if (pj.dependencies && typeof pj.dependencies === 'object') p.dependencies = Object.keys(pj.dependencies);
      if (pj.devDependencies && typeof pj.devDependencies === 'object') p.devDependencies = Object.keys(pj.devDependencies);
      if (pj.engines && typeof pj.engines === 'object') p.engines = pj.engines as Record<string, string>;
      if (typeof pj.packageManager === 'string') p.packageManager = pj.packageManager;
      if (typeof pj.main === 'string') p.main = pj.main;
      if (typeof pj.type === 'string') p.moduleType = pj.type;
    }
    const prefix = d === '.' ? '' : `${d}/`;
    p.sourceFiles = files
      .filter((f) => f.startsWith(prefix) && SOURCE_EXT.test(f) && !TEST_PATH.test(f))
      .map((f) => f.slice(prefix.length))
      .filter((f) => !f.includes('/') || /^(src|app|cmd|server|bin)\/[^/]+$/.test(f) || /^cmd\/[^/]+\/[^/]+$/.test(f))
      .slice(0, 14);
    if (p.runtime === 'go') {
      const mains = new Set<string>();
      for (const f of files.filter((f) => f.startsWith(prefix) && f.endsWith('.go') && !f.endsWith('_test.go')).slice(0, 200)) {
        if (/^package main\b/m.test((await read(f)) ?? '')) mains.add(dirOf(f));
      }
      p.mainDirs = [...mains].slice(0, 10);
    }
    packages.push(p);
    if (p.name) byName.set(p.name, p);
  }
  // Intra-repo dependency edges: by package name, or by file:/link:/workspace: paths.
  for (const p of packages) {
    for (const dep of [...(p.dependencies ?? []), ...(p.devDependencies ?? [])]) {
      const target = byName.get(dep);
      if (target && target !== p) {
        p.workspaceDeps.push(target.name!);
        target.dependents.push(p.name ?? p.dir);
      }
    }
  }

  // Runtime version pins declared by the repo.
  const pins: Inventory['pins'] = [];
  for (const p of packages) if (p.engines?.node) pins.push({ dir: p.dir, runtime: 'node', spec: p.engines.node, source: `${p.dir}/package.json engines.node` });
  for (const f of files.filter((f) => depth(f) <= 4)) {
    const base = f.split('/').pop()!;
    const pin = (runtime: string, spec: string | undefined) => spec && pins.push({ dir: dirOf(f), runtime, spec: spec.trim(), source: f });
    if (base === '.nvmrc' || base === '.node-version') pin('node', (await read(f))?.split('\n').find((l) => /\d/.test(l) && !l.startsWith('#')));
    else if (base === '.python-version') pin('python', (await read(f))?.split('\n').find((l) => /^\s*\d/.test(l)));
    else if (base === 'runtime.txt') pin('python', (await read(f))?.match(/python-(\d+\.\d+)/)?.[1]);
    else if (base === 'go.mod') pin('go', (await read(f))?.match(/^go\s+(\d+\.\d+)/m)?.[1]);
    else if (base === 'pyproject.toml') pin('python', (await read(f))?.match(/requires-python\s*=\s*["']([^"']+)["']/)?.[1]);
    else if (/^Dockerfile/.test(base)) {
      // The image versions an existing Dockerfile builds with are a pin too.
      for (const m of ((await read(f)) ?? '').matchAll(/^\s*FROM\s+(?:--\S+\s+)?(?:\S+\/)?(node|python|golang):(\d+(?:\.\d+)?)/gim)) {
        pin(m[1] === 'golang' ? 'go' : m[1], m[2]);
      }
    }
  }

  // Raw run/build config: small non-source files that say how things are built, run or deployed.
  const configs: Inventory['configs'] = [];
  let budget = 9000;
  const configCandidates = files.filter((f) => {
    const base = f.split('/').pop()!;
    if (ENV_FILE.test(f) || LOCKFILES.has(base) || base === 'package.json' || NOISE_CONFIG.test(base) || TEST_PATH.test(f)) return false;
    const inPkg = packages.some((p) => dirOf(f) === p.dir);
    if (!inPkg && depth(f) > 1) return false;
    return /^(Dockerfile.*|.*\.Dockerfile|Procfile.*|\.nvmrc|\.node-version|\.python-version|\.tool-versions|runtime\.txt|go\.work|requirements.*\.txt|Pipfile|pyproject\.toml|setup\.cfg|Cargo\.toml|go\.mod|.*compose.*\.ya?ml|.*\.config\.[cm]?[jt]s|.*\.(json|ya?ml|toml|ini|cfg|conf)|gunicorn\.conf\.py|manage\.py)$/i.test(base);
  });
  // Deploy/run descriptors first, then the rest; smaller files win ties.
  const rank = (f: string) => (/(docker|compose|procfile|\.nvmrc|version|runtime|workspace|turbo|nx\.json|render|fly|app\.json|ecosystem|gunicorn|\.config\.|requirements|pyproject|go\.mod)/i.test(f) ? 0 : 1);
  for (const f of configCandidates.sort((a, b) => rank(a) - rank(b) || depth(a) - depth(b))) {
    if (budget <= 0) break;
    const text = await read(f);
    if (text === undefined || text.length > 4000 && rank(f) > 0) continue;
    const content = text.length > 1800 ? `${text.slice(0, 1800)}\n... (truncated)` : text;
    configs.push({ path: f, content: content.trimEnd() });
    budget -= content.length;
  }

  // Port evidence and env var names, from source, scripts, configs and docs. Real .env files are never read.
  const ports: PortEvidence[] = [];
  const envVars = new Set<string>();
  const envByPackage: Record<string, string[]> = {};
  const addEnv = (name: string, f: string) => {
    envVars.add(name);
    const o = owner(f);
    if (!(envByPackage[o] ??= []).includes(name)) envByPackage[o].push(name);
  };
  const owner = (f: string) => [...packages].sort((a, b) => b.dir.length - a.dir.length).find((p) => within(f, p.dir))?.dir ?? '.';
  const seen = new Set<string>();
  const add = (e: Omit<PortEvidence, 'id' | 'pkg'>) => {
    const key = `${e.file}:${e.line}`;
    if (seen.has(key)) return;
    seen.add(key);
    const url = /[a-z]+:\/\/[^\s'"`]*:\d{2,5}/i.test(e.text) && !/listen|bind|serve/i.test(e.text);
    ports.push({ id: '', pkg: owner(e.file), ...e, text: e.text.trim().slice(0, 140), ...(url ? { url } : {}) });
  };
  const scanFiles = files.filter((f) => {
    if (ENV_FILE.test(f) && !ENV_EXAMPLE.test(f)) return false;
    if (TEST_PATH.test(f)) return false;
    const base = f.split('/').pop()!;
    return SOURCE_EXT.test(base) || /^(Dockerfile.*|.*\.Dockerfile|Procfile.*|.*compose.*\.ya?ml|.*\.(json|ya?ml|toml|ini|cfg|conf)|readme(\.md)?)$/i.test(base) || ENV_EXAMPLE.test(f);
  }).filter((f) => !LOCKFILES.has(f.split('/').pop()!)).slice(0, 600);
  const envPatterns = [
    /process\.env\.([A-Z_][A-Z0-9_]*)/g,
    /process\.env\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
    /\benviron(?:\.get)?\(?\[?\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
    /\bgetenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
    /os\.Getenv\(\s*"([A-Z_][A-Z0-9_]*)"/g,
    /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g,
  ];
  for (const f of scanFiles) {
    const text = await read(f);
    if (text === undefined) continue;
    const kind = kindOf(f);
    if (kind === 'code') for (const re of envPatterns) for (const m of text.matchAll(re)) addEnv(m[1], f);
    if (kind === 'env-example') {
      text.split('\n').forEach((l, i) => {
        const m = l.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*['"]?([^'"\s#]*)/);
        if (!m) return;
        addEnv(m[1], f);
        // Only a port number is taken from example files; no other values are read.
        if (/PORT$/.test(m[1]) && /^\d{2,5}$/.test(m[2])) add({ file: f, line: i + 1, text: `${m[1]}=${m[2]}`, kind, port: Number(m[2]), envVar: m[1] });
      });
      continue;
    }
    if (kind === 'readme') continue; // run instructions are quoted separately
    if (f.split('/').pop() === 'package.json') {
      // Only scripts carry run-time ports in package.json; each script is checked on its own.
      const scripts = parseJson<{ scripts?: Record<string, string> }>(text)?.scripts ?? {};
      for (const [name, cmd] of Object.entries(scripts)) {
        if (typeof cmd !== 'string') continue;
        const hit = portOnLine(cmd);
        const at = text.indexOf(`"${name}"`);
        if (hit) add({ file: f, line: at < 0 ? 1 : text.slice(0, at).split('\n').length, text: `"${name}": "${cmd}"`, kind: 'script', ...hit });
      }
      continue;
    }
    const lines = text.split('\n');
    lines.forEach((l, i) => {
      if (l.length > 400) return;
      const hit = portOnLine(l, kind === 'code');
      if (!hit) return;
      if (kind === 'compose') {
        const m = l.match(/['"]?(?:[\d.]+:)?(\d{2,5}):(\d{2,5})(?:\/\w+)?['"]?/);
        if (m) hit.port = Number(m[2]);
      }
      add({ file: f, line: i + 1, text: l, kind, ...hit });
    });
  }
  // Keep the prompt small: per package, literal ports first, then env reads.
  const capped: PortEvidence[] = [];
  for (const p of packages.length ? packages : [{ dir: '.' } as PackageInfo]) {
    const mine = ports.filter((e) => e.pkg === p.dir);
    const score = (e: PortEvidence) => (e.kind === 'code' ? 0 : e.kind === 'script' ? 1 : 2) + (e.port === undefined ? 3 : 0);
    capped.push(...mine.sort((a, b) => score(a) - score(b)).slice(0, 10));
  }
  capped.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line).forEach((e, i) => (e.id = `e${i + 1}`));

  // README run instructions: shell lines from code blocks and anything mentioning a local URL.
  const readme: string[] = [];
  for (const f of files.filter((f) => /(^|\/)readme(\.md)?$/i.test(f) && packages.some((p) => dirOf(f) === p.dir)).slice(0, 6)) {
    const text = (await read(f)) ?? '';
    let inBlock = false;
    for (const l of text.split('\n')) {
      if (/^\s*```/.test(l)) {
        inBlock = !inBlock;
        continue;
      }
      const t = l.trim();
      if (!t || t.length > 160) continue;
      if ((inBlock && /^[$>]?\s*[a-z][\w.-]*(\s|$)/.test(t) && !/^[{}<]/.test(t)) || /(localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}/.test(t)) {
        readme.push(`${f}: ${t}`);
        if (readme.length >= 30) break;
      }
    }
  }

  // Tree: dirs to depth 3, files to depth 2, plus every manifest and Dockerfile anywhere.
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length && i <= 3; i++) dirs.add(`${parts.slice(0, i).join('/')}/`);
  }
  const keep = files.filter((f) => depth(f) <= 2 || f.split('/').pop()! in MANIFESTS || /Dockerfile/i.test(f));
  const tree = [...new Set([...dirs, ...keep])].sort().slice(0, 160);

  return {
    tree,
    files,
    packages,
    workspaces,
    lockfiles: files.filter((f) => LOCKFILES.has(f.split('/').pop()!) && depth(f) <= 4),
    configs,
    ports: capped,
    envVars: [...envVars].sort(),
    envByPackage,
    pins,
    readme,
  };
}

// Compact text rendering of the inventory for the model.
export function renderInventory(inv: Inventory): string {
  const out: string[] = [];
  out.push(`FILE TREE (depth-limited):\n${inv.tree.join('\n')}`);
  if (inv.workspaces.length) out.push(`WORKSPACE DECLARATIONS:\n${inv.workspaces.map((w) => `${w.source}: ${JSON.stringify(w.patterns)}`).join('\n')}`);
  out.push(`LOCKFILES: ${inv.lockfiles.join(', ') || 'none'}`);
  const pk: string[] = [];
  for (const p of inv.packages) {
    const lines = [`[${p.dir}] ${p.manifests.join(', ') || '(no manifest)'} · runtime ${p.runtime}${p.name ? ` · name ${p.name}` : ''}${p.inWorkspace ? '' : ' · NOT in any workspace declaration'}`];
    if (p.packageManager) lines.push(`  packageManager: ${p.packageManager}`);
    if (p.engines) lines.push(`  engines: ${JSON.stringify(p.engines)}`);
    if (p.main) lines.push(`  main: ${p.main}`);
    if (p.moduleType) lines.push(`  type: ${p.moduleType}`);
    if (p.scripts) lines.push(`  scripts: ${JSON.stringify(p.scripts)}`);
    if (p.dependencies?.length) lines.push(`  dependencies: ${p.dependencies.slice(0, 40).join(', ')}`);
    if (p.devDependencies?.length) lines.push(`  devDependencies: ${p.devDependencies.slice(0, 30).join(', ')}`);
    if (p.workspaceDeps.length) lines.push(`  depends on repo packages: ${p.workspaceDeps.join(', ')}`);
    if (p.dependents.length) lines.push(`  used by repo packages: ${p.dependents.join(', ')}`);
    if (p.sourceFiles.length) lines.push(`  source files: ${p.sourceFiles.join(', ')}`);
    if (p.mainDirs?.length) lines.push(`  go main packages: ${p.mainDirs.join(', ')}`);
    if (p.dockerfiles.length) lines.push(`  existing Dockerfiles: ${p.dockerfiles.join(', ')}`);
    pk.push(lines.join('\n'));
  }
  out.push(`PACKAGES:\n${pk.join('\n') || '(none found)'}`);
  out.push(`PORT EVIDENCE (id file:line [package] text):\n${inv.ports.map((e) => `${e.id} ${e.file}:${e.line} [${e.pkg}]${e.port ? ` port=${e.port}` : ''}${e.envVar ? ` env=${e.envVar}` : ''}${e.url ? ' (URL it calls)' : ''} | ${e.text}`).join('\n') || 'none found'}`);
  if (inv.configs.length) out.push(`CONFIG FILES (raw):\n${inv.configs.map((c) => `--- ${c.path}\n${c.content}`).join('\n')}`);
  if (inv.pins.length) out.push(`RUNTIME VERSION PINS:\n${inv.pins.map((p) => `${p.runtime} ${p.spec} (${p.source})`).join('\n')}`);
  if (inv.readme.length) out.push(`README RUN NOTES:\n${inv.readme.join('\n')}`);
  out.push(`ENV VAR NAMES (values never shown): ${inv.envVars.join(', ') || 'none'}`);
  return out.join('\n\n');
}
