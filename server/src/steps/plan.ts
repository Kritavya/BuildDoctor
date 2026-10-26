// Service planning: the model turns the inventory into a list of deployable services; every plan is
// checked against the inventory and the problems are fed back for a bounded number of retries.
import path from 'node:path';
import { chatJson, type ChatMessage } from '../llm/ollama.js';
import type { ServicePlan } from '../types.js';
import { renderInventory, type Inventory, type PackageInfo } from './inventory.js';

export const STATIC_PORT = 8080; // static services are served by our own file server on this port
export const PROVISIONAL_PORT = 8080; // servers whose repo names no port at all

// Shape the model is asked for; everything is optional because the model output is untrusted.
export interface RawService {
  name?: string;
  root?: string;
  context?: string;
  kind?: string;
  runtime?: string;
  framework?: string;
  runtimeImage?: string;
  installCommand?: string | null;
  buildCommand?: string | null;
  startCommand?: string | null;
  outputDir?: string | null;
  port?: number | string;
  portEvidence?: string;
  dockerfile?: string | null;
  dependsOn?: string[];
}
export interface RawPlan {
  services?: RawService[];
  skipped?: Array<{ root?: string; reason?: string }>;
}

const SYSTEM = `You plan how to containerise a repository. You get a factual inventory of it: file tree, packages with their manifests and scripts, raw config files, and port evidence with ids (e1, e2...). Decide which packages are deployable services and how each one is installed, built and started inside a container.

Reply with JSON only:
{"services": [{
  "name": short lowercase slug,
  "root": package directory from the inventory ("." for the repo root),
  "context": docker build context directory: "." when the package depends on other packages of this repo or installs from a root lockfile, otherwise the root,
  "kind": "server" (a long-running process that listens on a port) or "static" (its build produces plain files that only need a static file server),
  "runtime": "node" | "python" | "go" | other,
  "framework": string or null,
  "runtimeImage": official Docker image whose version satisfies the repo (engines, .nvmrc, .python-version, go.mod, framework versions); when nothing pins it, a current LTS release,
  "installCommand": dependency install command, run in the context directory, using the repo's package manager and lockfile,
  "buildCommand": build command run in the root directory, or null if nothing needs building,
  "startCommand": command that starts the server, run in the root directory (null for static),
  "outputDir": static only: build output directory relative to root,
  "port": number the server listens on in the container,
  "portEvidence": the evidence id(s) the port comes from (e.g. "e3"), or how the start command itself sets the port,
  "dockerfile": path of an existing Dockerfile in the repo that builds this service, or null,
  "dependsOn": names of other services it calls
}],
"skipped": [{"root": package directory, "reason": why it is not a service}]}

Reason only from the inventory:
- Every script you run must exist in that package's scripts; every file you reference must exist (or be produced by the build command).
- A container runs the service in production: no file watching, hot reload, or opening a browser, and the start command must stay in the foreground (a process manager that daemonises makes the container exit). When a package offers a way to build and then run the built output, prefer it over a development server. A dev server is acceptable only when nothing else can run the app.
- Packages that other packages depend on and that do not start a server themselves (shared libraries, UI kits, configs, types) are not services; put them in "skipped" with the reason.
- Every package that has server code (listen calls, a port read from the environment) must appear either in "services" or in "skipped".
- If the server reads its port from an environment variable, the container will set that variable to "port".`;

export interface PlanResult {
  services: ServicePlan[];
  skipped: Array<{ root: string; reason: string }>;
  source: 'model' | 'salvaged' | 'fallback';
  attempts: number;
  rejected: string[][]; // validation errors of each rejected attempt
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
const norm = (p: string | undefined) => {
  const n = path.posix.normalize((p ?? '.').trim().replace(/^\.\//, '') || '.').replace(/\/+$/, '');
  return n === '' ? '.' : n;
};
const str = (v: unknown) => (typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null' ? v.trim() : undefined);
const inDir = (f: string, dir: string) => dir === '.' || f === dir || f.startsWith(`${dir}/`);
const join = (dir: string, f: string) => norm(dir === '.' ? f : `${dir}/${f}`);

export function dirExists(inv: Inventory, dir: string): boolean {
  return dir === '.' || inv.files.some((f) => f.startsWith(`${dir}/`));
}
const fileExists = (inv: Inventory, f: string) => inv.files.includes(f) || inv.files.some((x) => x.startsWith(`${f}/`));

// Shell-ish split of one command into segments (split on && ; ||) and tokens.
function segments(cmd: string): string[][] {
  return cmd
    .split(/&&|\|\||;/)
    .map((s) => (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^['"]|['"]$/g, '')))
    .filter((t) => t.length);
}

const PM_BUILTINS: Record<string, Set<string>> = {
  npm: new Set(['install', 'i', 'ci', 'exec', 'x', 'add', 'uninstall', 'prune', 'rebuild', 'link', 'pack', 'publish', 'config', 'cache', 'audit', 'ls', 'list', 'view', 'init', 'version', 'dedupe', 'update']),
  pnpm: new Set(['install', 'i', 'add', 'remove', 'rm', 'update', 'up', 'exec', 'dlx', 'store', 'fetch', 'prune', 'rebuild', 'link', 'list', 'ls', 'why', 'deploy', 'config', 'env', 'setup', 'import', 'create', 'publish', 'pack', 'audit', 'outdated', 'install-test', 'approve-builds']),
  yarn: new Set(['install', 'add', 'remove', 'workspace', 'workspaces', 'dlx', 'exec', 'set', 'plugin', 'node', 'why', 'info', 'up', 'upgrade', 'config', 'cache', 'global', 'link', 'pack', 'npm', 'constraints', 'dedupe']),
  bun: new Set(['install', 'i', 'add', 'remove', 'x', 'build', 'create', 'pm', 'link', 'upgrade']),
};
const NPM_LIFECYCLE = new Set(['start', 'test', 'stop', 'restart']);

function findPackage(inv: Inventory, ref: string, cwd: string): PackageInfo | undefined | 'many' {
  const r = ref.replace(/^\.{3}|\.{3}$/g, '').replace(/^\{|\}$/g, '').replace(/^\.\//, '').replace(/\/+$/, '');
  if (/[*!^]/.test(r)) return 'many';
  return inv.packages.find((p) => p.name === r || p.dir === r || p.dir === join(cwd, r)) ?? inv.packages.find((p) => p.name?.endsWith(`/${r}`));
}

// Script references in a command (npm/pnpm/yarn/bun): the scripts it runs and the ones that do not exist.
export function scriptRefs(inv: Inventory, cmd: string, dir: string): { problems: string[]; refs: Array<{ pkg: string; script: string; text: string }> } {
  const problems: string[] = [];
  const refs: Array<{ pkg: string; script: string; text: string }> = [];
  let cwd = dir;
  for (const t of segments(cmd)) {
    if (t[0] === 'cd' && t[1]) {
      cwd = join(cwd, t[1]);
      if (!dirExists(inv, cwd)) problems.push(`"cd ${t[1]}" goes to ${cwd}, which does not exist`);
      continue;
    }
    let i = 0;
    while (i < t.length && /^[A-Z_][A-Z0-9_]*=/.test(t[i])) i++; // leading VAR=value
    if (['npx', 'corepack'].includes(t[i]) && ['npm', 'pnpm', 'yarn'].includes(t[i + 1])) i++;
    const pm = t[i];
    if (!pm || !(pm in PM_BUILTINS)) continue;
    let target: PackageInfo | undefined | 'many' = inv.packages.find((p) => p.dir === cwd);
    let script: string | undefined;
    let recursive = false;
    const rest = t.slice(i + 1);
    const pos: string[] = [];
    for (let j = 0; j < rest.length; j++) {
      const a = rest[j];
      if (a === '--') break; // arguments for the script itself
      const val = a.includes('=') ? a.split('=').slice(1).join('=') : rest[j + 1];
      if (/^(--filter|-F|--workspace|-w|--prefix|-C|--dir|--cwd)(=|$)/.test(a)) {
        if (!a.includes('=')) j++;
        if (!val) continue;
        target = /^(--prefix|-C|--dir|--cwd)/.test(a) ? inv.packages.find((p) => p.dir === join(cwd, val)) ?? undefined : findPackage(inv, val, cwd);
        if (target === undefined) problems.push(`"${a} ${val}" does not match any package in the repo`);
        continue;
      }
      if (/^(-r|--recursive|--workspaces|-ws|--if-present)$/.test(a)) recursive = true;
      if (!a.startsWith('-')) pos.push(a);
    }
    if (pm === 'yarn' && pos[0] === 'workspace' && pos[1]) {
      target = findPackage(inv, pos[1], cwd);
      if (target === undefined) problems.push(`yarn workspace "${pos[1]}" does not match any package in the repo`);
      pos.splice(0, 2);
    }
    const first = pos[0];
    if (first === 'run' || first === 'run-script') script = pos[1];
    else if (first && !PM_BUILTINS[pm].has(first) && !(pm === 'npm' && !NPM_LIFECYCLE.has(first)) && !(pm === 'bun' && /\.[cm]?[jt]sx?$/.test(first))) script = first;
    if (!script || recursive || target === 'many') continue;
    if (target === undefined) continue;
    if (!target.scripts) {
      if (target.manifests.includes('package.json')) problems.push(`"${t.join(' ')}" runs script "${script}" but ${target.dir}/package.json has no scripts`);
      continue;
    }
    if (!(script in target.scripts)) {
      problems.push(`"${t.join(' ')}" runs script "${script}", which does not exist in ${target.dir === '.' ? '' : `${target.dir}/`}package.json (scripts: ${Object.keys(target.scripts).join(', ') || 'none'}).${staticHint(target)}`);
    } else refs.push({ pkg: target.dir, script, text: target.scripts[script] });
  }
  return { problems, refs };
}

export const scriptProblems = (inv: Inventory, cmd: string, dir: string) => scriptRefs(inv, cmd, dir).problems;

// Everything a command ends up running: its own text plus the scripts it calls (and in which package), a few levels deep.
function expand(inv: Inventory, cmd: string, dir: string, depth = 3): { texts: string[]; pkgs: Set<string> } {
  const out = { texts: [cmd], pkgs: new Set<string>() };
  if (depth <= 0) return out;
  for (const r of scriptRefs(inv, cmd, dir).refs) {
    out.pkgs.add(r.pkg);
    const sub = expand(inv, r.text, r.pkg, depth - 1);
    out.texts.push(...sub.texts);
    for (const p of sub.pkgs) out.pkgs.add(p);
  }
  return out;
}

// Repo packages a service depends on that have their own build must be built before it.
function depBuildProblems(inv: Inventory, pkg: PackageInfo | undefined, build: string | undefined, root: string): string[] {
  const deps = (pkg?.workspaceDeps ?? []).map((n) => inv.packages.find((p) => p.name === n)!).filter((d) => d?.scripts?.build);
  if (!deps.length) return [];
  const reached = build ? expand(inv, build, root) : { texts: [], pkgs: new Set<string>() };
  const text = reached.texts.join('\n');
  if (/(^|\s)(-r|--recursive|--workspaces|-ws)(\s|$)|\.\.\.|\^/.test(text)) return [];
  const missing = deps.filter((d) => !reached.pkgs.has(d.dir) && !text.includes(d.dir) && !(d.name && text.includes(d.name)));
  if (!missing.length) return [];
  const rootScripts = Object.entries(inv.packages.find((p) => p.dir === '.')?.scripts ?? {}).filter(([, v]) => missing.some((d) => v.includes(d.dir) || (d.name && v.includes(d.name)))).map(([k]) => k);
  const pm = inv.lockfiles.includes('pnpm-lock.yaml') ? 'pnpm' : inv.lockfiles.includes('yarn.lock') ? 'yarn' : 'npm';
  const step = (d: PackageInfo) => pm === 'pnpm' ? `pnpm --filter ${d.name ?? `./${d.dir}`} run build` : pm === 'yarn' && d.name ? `yarn workspace ${d.name} run build` : `npm run build --prefix ${path.posix.relative(root === '.' ? '' : root, d.dir)}`;
  // Dependencies before their dependents.
  missing.sort((a, b) => (b.workspaceDeps.includes(a.name ?? '') ? -1 : a.workspaceDeps.includes(b.name ?? '') ? 1 : 0));
  const suggestion = [...missing.map(step), build ?? `${pm} run build`].join(' && ');
  return [`it depends on repo packages with their own build (${missing.map((d) => d.dir).join(', ')}) that the buildCommand does not build first; for example "buildCommand": "${suggestion}"${rootScripts.length ? ` (root scripts that build them: ${rootScripts.join(', ')})` : ''}`];
}

// A dependency's executable (next, vite, nest...) lives in node_modules/.bin, which is not on PATH in a container.
function binProblems(inv: Inventory, cmd: string, dir: string): string[] {
  const pkgs = inv.packages.filter((p) => p.dir === dir || p.dir === '.');
  const deps = new Set(pkgs.flatMap((p) => [...(p.dependencies ?? []), ...(p.devDependencies ?? [])]));
  const scriptBins = new Set(pkgs.flatMap((p) => Object.values(p.scripts ?? {}).map((v) => v.trim().split(/\s+/)[0])));
  const out: string[] = [];
  for (const t of segments(cmd)) {
    let i = 0;
    while (i < t.length && /^[A-Z_][A-Z0-9_]*=/.test(t[i])) i++;
    const bin = t[i];
    if (!bin || bin === 'cd' || bin in PM_BUILTINS || ['npx', 'node', 'exec', 'sh', 'bash', 'corepack'].includes(bin) || bin.includes('/')) continue;
    if (deps.has(bin) || scriptBins.has(bin) && !['node', 'python', 'python3'].includes(bin)) {
      out.push(`"${bin}" is a dependency's executable in node_modules/.bin, which is not on PATH; run it through a package script or "npx ${bin}"`);
    } else if (!['env', 'true', 'echo', 'test', '['].includes(bin)) {
      out.push(`"${bin}" is not installed by this package (not a dependency or script); use a script or file of the package${pkgs.some((p) => p.scripts?.build) ? ', or kind "static" if the build output is plain files' : ''}`);
    }
  }
  return out;
}

// Signs that a command runs a development server: file watching, live reload, opening a browser.
const DEV_MARKERS = /(--watch\b|\bwatch\b|--open\b|\bnodemon\b|--reload\b|--hot\b|\bdev\b(?!:)|-dev\b)/;

function devServerProblem(inv: Inventory, start: string, root: string, build: string | undefined): string | undefined {
  const { refs } = scriptRefs(inv, start, root);
  const texts = [start, ...refs.map((r) => r.text)];
  const marked = texts.find((t) => DEV_MARKERS.test(t));
  if (!marked) return undefined;
  const pkg = inv.packages.find((p) => p.dir === root);
  const buildable = !!build || !!pkg?.scripts && Object.keys(pkg.scripts).some((k) => /build/.test(k));
  if (!buildable) return undefined; // nothing else can run it
  return `"${start}" runs a development server ("${marked}"); this package can be built, so run the built output instead.${staticHint(pkg)}`;
}

// Concrete alternative for a buildable package with nothing that serves its build output.
function staticHint(pkg: PackageInfo | undefined): string {
  const build = pkg?.scripts && Object.keys(pkg.scripts).find((k) => k === 'build') ;
  if (!build) return '';
  const serves = Object.entries(pkg!.scripts!).some(([k, v]) => k !== build && /start|serve|prod/.test(k) && !DEV_MARKERS.test(v));
  return serves ? '' : ` No script serves the built output, so if the build produces plain files set "kind": "static", "buildCommand": "npm run ${build}" (with the repo's package manager) and "outputDir" to the build output directory.`;
}

// Runtime image: the repo's own version pin wins; otherwise unsupported versions move to a current release.
const SUPPORTED: Record<string, { image: string; min: number[]; fallback: string }> = {
  node: { image: 'node', min: [20], fallback: '22' },
  python: { image: 'python', min: [3, 10], fallback: '3.12' },
  go: { image: 'golang', min: [1, 22], fallback: '1.24' },
};
const nums = (v: string) => (v.match(/\d+(\.\d+)?/)?.[0] ?? '').split('.').filter(Boolean).map(Number);
const older = (a: number[], b: number[]) => a[0] < b[0] || (a[0] === b[0] && (a[1] ?? 0) < (b[1] ?? 0));

export function normalizeImage(image: string | undefined, runtime: string, pin: string | undefined): string | undefined {
  const sup = SUPPORTED[runtime];
  if (!sup) return image;
  const [name, tag = ''] = (image ?? `${sup.image}:${sup.fallback}-slim`).split(':');
  if (name !== sup.image && !name.endsWith(`/${sup.image}`)) return image;
  let variant = tag.match(/-(slim|alpine|bookworm|bullseye)[\w.-]*$/)?.[0] ?? (sup.image === 'golang' ? '' : '-slim');
  if (sup.image === 'golang') variant = variant.replace(/^-slim/, ''); // golang publishes no -slim tags
  let version = nums(tag).join('.');
  if (pin) {
    const exact = pin.match(/^\s*[v^~=]?\s*(\d+(?:\.\d+)?)(?:\.x|\.\*|\.\d+)*\s*$/);
    const floor = pin.match(/>=?\s*(\d+(?:\.\d+)?)/);
    if (exact) return `${name}:${exact[1]}${variant}`;
    if (floor && (!version || older(nums(version), nums(floor[1])))) version = older(nums(sup.fallback), nums(floor[1])) ? floor[1] : sup.fallback;
  }
  if (!version || older(nums(version), sup.min)) version = sup.fallback;
  return `${name}:${version}${variant}`;
}

// Files a command references directly (node x.js, python app.py, -r requirements.txt, module:app).
export function fileProblems(inv: Inventory, cmd: string, dir: string, producedByBuild: boolean): string[] {
  const problems: string[] = [];
  let cwd = dir;
  for (const t of segments(cmd)) {
    if (t[0] === 'cd' && t[1]) {
      cwd = join(cwd, t[1]);
      continue;
    }
    const viaPm = t[0] in PM_BUILTINS || ['npx', 'corepack'].includes(t[0]); // script names like "start:prod"
    for (let i = 0; i < t.length; i++) {
      const a = t[i];
      if (a.startsWith('-') && a !== '-r' && a !== '-c') continue;
      if ((a === '-r' || a === '-c') && t[i + 1] && /\.(txt|in|py)$/.test(t[i + 1])) {
        const f = join(cwd, t[i + 1]);
        if (!fileExists(inv, f)) problems.push(`"${a} ${t[i + 1]}" refers to ${f}, which does not exist`);
        i++;
        continue;
      }
      if (/^[\w./@-]+\.(m?js|cjs|ts|mts|py|sh|rb)$/.test(a) && !a.includes('*') && i > 0) {
        const f = join(cwd, a);
        if (!fileExists(inv, f) && !producedByBuild) problems.push(`"${a}" refers to ${f}, which does not exist and no build step produces it`);
      }
      // python module:attr (uvicorn main:app, gunicorn pkg.wsgi:application)
      const m = a.match(/^([A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*):[A-Za-z_]\w*(?:\(\))?$/);
      if (m && i > 0 && !viaPm) {
        const mod = m[1].replace(/\./g, '/');
        const candidates = [join(cwd, `${mod}.py`), join(cwd, `${mod}/__init__.py`), join(cwd, `src/${mod}.py`), join(cwd, `src/${mod}/__init__.py`)];
        if (!candidates.some((c) => inv.files.includes(c))) problems.push(`module "${m[1]}" in "${a}" is not a file under ${cwd} (looked for ${candidates[0]})`);
      }
    }
  }
  return problems;
}

function lockfileProblems(inv: Inventory, cmd: string, context: string): string[] {
  const has = (f: string) => inv.files.includes(join(context, f));
  const out: string[] = [];
  if (/\bnpm ci\b/.test(cmd) && !has('package-lock.json') && !has('npm-shrinkwrap.json')) out.push(`"npm ci" needs package-lock.json in ${context}, which does not exist (use "npm install")`);
  if (/\bpnpm (i|install)\b.*--frozen-lockfile/.test(cmd) && !has('pnpm-lock.yaml')) out.push(`"--frozen-lockfile" needs pnpm-lock.yaml in ${context}, which does not exist`);
  if (/\byarn( install)?\b.*(--frozen-lockfile|--immutable)/.test(cmd) && !has('yarn.lock')) out.push(`yarn lockfile flags need yarn.lock in ${context}, which does not exist`);
  return out;
}

// Server code in a package: a listen call or a port read from the environment, in its own source.
// A URL it calls (http://localhost:3000/api) is client code, not a server.
function serverEvidence(inv: Inventory, dir: string): string[] {
  return inv.ports.filter((e) => e.pkg === dir && e.kind === 'code' && !e.url).map((e) => e.id);
}

// Nearest version pin for a runtime: the service dir first, then its ancestors.
function pinFor(inv: Inventory, root: string, runtime: string): string | undefined {
  let d = root;
  for (;;) {
    const pin = inv.pins.find((p) => p.dir === d && p.runtime === runtime);
    if (pin) return pin.spec;
    if (d === '.') return undefined;
    d = path.posix.dirname(d);
  }
}

function portProblems(inv: Inventory, s: ServicePlan): string[] {
  if (s.kind === 'static') return [];
  const ids: string[] = s.portEvidence.match(/\be\d+\b/g) ?? [];
  const cited = inv.ports.filter((e) => ids.includes(e.id));
  for (const id of ids) if (!inv.ports.some((e) => e.id === id)) return [`portEvidence cites ${id}, which is not in the port evidence list`];
  if (s.startCommand && new RegExp(`(^|[^\\d])${s.port}([^\\d]|$)`).test(s.startCommand)) return []; // the command pins it
  // A port cited from a package script only holds if the start command runs that script.
  if (s.startCommand) {
    const runs = scriptRefs(inv, s.startCommand, s.root).refs.map((r) => `${r.pkg}:${r.script}`);
    for (const e of cited.filter((e) => e.kind === 'script' && e.port === s.port)) {
      const name = e.text.match(/^"([^"]+)"/)?.[1];
      if (name && !runs.includes(`${e.pkg}:${name}`) && !(e.text.includes(s.startCommand))) {
        return [`${e.id} is the port of script "${name}", which the start command "${s.startCommand}" does not run; use the port the start command really listens on, or pass the port in the start command`];
      }
    }
  }
  if (cited.some((e) => e.port === s.port)) return [];
  const local = inv.ports.filter((e) => (inDir(e.file, s.root) || e.pkg === s.root) && e.port === s.port);
  if (local.length) return [];
  // The app takes its port from an env var: the container sets that var to the planned port.
  const reads = inv.ports.filter((e) => e.envVar && (inDir(e.file, s.root) || e.pkg === s.root || (s.root !== '.' && e.pkg === '.' && e.kind !== 'code')));
  if (reads.length && (cited.some((e) => e.envVar) || !ids.length)) return [];
  const known = inv.ports.filter((e) => e.pkg === s.root && e.port).map((e) => `${e.id}=${e.port}`);
  return [`port ${s.port} for "${s.name}" has no evidence${known.length ? ` (evidence for ${s.root}: ${known.join(', ')})` : ''}; cite the evidence id it comes from, or make the start command set the port explicitly`];
}

// Normalises one raw service; returns it with its problems against the inventory.
export function checkService(inv: Inventory, raw: RawService, all: RawService[]): { service?: ServicePlan; problems: string[] } {
  const problems: string[] = [];
  const name = slug(str(raw.name) ?? path.posix.basename(norm(raw.root)) ?? 'app');
  const root = norm(str(raw.root) ?? '.');
  const label = `service "${name}"`;
  if (!dirExists(inv, root)) return { problems: [`${label}: root "${root}" does not exist`] };
  const pkg = inv.packages.find((p) => p.dir === root);
  if (!pkg && inv.packages.length) {
    return { problems: [`${label}: root "${root}" is not a package directory; a root must be one of: ${inv.packages.map((p) => `"${p.dir}"`).join(', ')}`] };
  }
  const kind = raw.kind === 'static' ? 'static' : 'server';
  let context = norm(str(raw.context) ?? root);
  if (!dirExists(inv, context)) problems.push(`${label}: context "${context}" does not exist`);
  else if (!inDir(root, context)) problems.push(`${label}: root "${root}" is not inside context "${context}"`);
  if (pkg && pkg.workspaceDeps.length && context !== '.') {
    problems.push(`${label}: it depends on repo packages (${pkg.workspaceDeps.join(', ')}), so the context must be "." for them to be part of the build`);
    context = '.';
  }
  const install = str(raw.installCommand);
  const build = str(raw.buildCommand);
  const start = kind === 'server' ? str(raw.startCommand) : undefined;
  const outputDir = kind === 'static' ? str(raw.outputDir) : undefined;
  if (kind === 'server' && !start) problems.push(`${label}: a server needs a startCommand`);
  if (kind === 'static' && (!build || !outputDir)) problems.push(`${label}: a static service needs buildCommand and outputDir`);
  const serving = kind === 'static' && Object.entries(pkg?.scripts ?? {}).find(([k, v]) => /^(start|serve)(:prod|:production)?$/.test(k) && !DEV_MARKERS.test(v));
  if (serving) problems.push(`${label}: ${root} has a "${serving[0]}" script ("${serving[1]}") that serves the built app, so it is a "server" that runs it after the build, not "static"`);
  if (install) problems.push(...scriptProblems(inv, install, context).concat(lockfileProblems(inv, install, context), fileProblems(inv, install, context, false)).map((p) => `${label} installCommand: ${p}`));
  if (build) problems.push(...scriptProblems(inv, build, root).concat(fileProblems(inv, build, root, false)).map((p) => `${label} buildCommand: ${p}`));
  if (start) problems.push(...scriptProblems(inv, start, root).concat(fileProblems(inv, start, root, !!build)).map((p) => `${label} startCommand: ${p}`));
  problems.push(...depBuildProblems(inv, pkg, build, root).map((p) => `${label}: ${p}`));
  if (start && (pkg?.runtime === 'node' || raw.runtime === 'node')) problems.push(...binProblems(inv, start, root).map((p) => `${label} startCommand: ${p}`));
  const dev = start && devServerProblem(inv, start, root, build);
  if (dev) problems.push(`${label} startCommand: ${dev}`);
  if (pkg && pkg.dependents.length && !serverEvidence(inv, root).length && kind === 'server') {
    problems.push(`${label}: ${root} is a library used by ${pkg.dependents.join(', ')} and has no server code of its own; list it in "skipped"`);
  }
  let port = Number(raw.port);
  let provisional = false;
  // Nothing in the repo names a port for this package: take the model's guess (or a default) as provisional.
  // The container sets PORT to it, and the smoke test reads the real port from the app's logs if it differs.
  const noEvidence = kind === 'server' && !inv.ports.some((e) => (e.pkg === root || inDir(e.file, root)) && !e.url);
  if (kind === 'static') port = STATIC_PORT;
  else if (noEvidence && (!Number.isInteger(port) || port < 1 || port > 65535 || port === 22)) port = PROVISIONAL_PORT;
  else if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 22) problems.push(`${label}: port "${String(raw.port)}" is not a valid port`);
  if (noEvidence) provisional = true;
  let dockerfile = str(raw.dockerfile);
  if (dockerfile) {
    dockerfile = norm(dockerfile);
    if (!inv.files.includes(dockerfile)) problems.push(`${label}: dockerfile "${dockerfile}" does not exist (use null to generate one)`);
  }
  const names = all.map((s) => slug(str(s.name) ?? path.posix.basename(norm(s.root))));
  if (names.filter((n) => n === name).length > 1) problems.push(`${label}: the name is used by more than one service`);
  const service: ServicePlan = {
    name,
    root,
    context,
    dockerfile: dockerfile ?? '',
    existingDockerfile: !!dockerfile && inv.files.includes(dockerfile),
    kind,
    runtime: (str(raw.runtime) ?? pkg?.runtime ?? 'unknown').toLowerCase(),
    framework: str(raw.framework)?.toLowerCase(),
    runtimeImage: normalizeImage(str(raw.runtimeImage), (str(raw.runtime) ?? pkg?.runtime ?? '').toLowerCase(), pinFor(inv, root, (str(raw.runtime) ?? pkg?.runtime ?? '').toLowerCase())),
    installCommand: install,
    buildCommand: build,
    startCommand: start,
    outputDir,
    port,
    portEvidence: kind === 'static' ? 'static file server' : provisional ? 'provisional: no port in the repo; the container sets PORT and the smoke test reads the real port from the logs' : str(raw.portEvidence) ?? '',
    envVars: [],
    dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.filter((d): d is string => typeof d === 'string').map(slug) : [],
  };
  if (kind === 'server' && !service.existingDockerfile && port < 1024) problems.push(`${label}: port ${port} needs root inside the container, and services run as a non-root user; use a port above 1024 (and pass it in the start command if the app does not read PORT)`);
  if (Number.isInteger(port) && !provisional) problems.push(...portProblems(inv, service).map((p) => `${label}: ${p}`));
  return { service, problems };
}

// Whole-plan validation: per-service checks plus coverage of packages that contain server code.
export function validatePlan(inv: Inventory, raw: RawPlan): { services: ServicePlan[]; problems: string[]; valid: ServicePlan[] } {
  const list = Array.isArray(raw.services) ? raw.services.filter((s) => s && typeof s === 'object') : [];
  const problems: string[] = [];
  const services: ServicePlan[] = [];
  const valid: ServicePlan[] = [];
  if (!list.length) {
    // Every repo is run somehow; point at the packages that can run something.
    const runnable = inv.packages.filter((p) => !p.dependents.length && (Object.keys(p.scripts ?? {}).length || p.sourceFiles.length)).map((p) => `${p.dir}${p.scripts ? ` (scripts: ${Object.keys(p.scripts).join(', ')})` : ''}`);
    problems.push(`the plan has no services, but the repository must be deployed: a frontend whose build output is plain files is a "static" service, and an app with a start script is a "server" (candidates: ${runnable.join('; ') || 'the repo root'})`);
  }
  for (const r of list) {
    const { service, problems: p } = checkService(inv, r, list);
    problems.push(...p);
    if (service) {
      services.push(service);
      if (!p.length) valid.push(service);
    }
  }
  const skipped = new Set((raw.skipped ?? []).map((s) => norm(s?.root)));
  for (const pkg of inv.packages) {
    if (skipped.has(pkg.dir) || services.some((s) => s.root === pkg.dir)) continue;
    const ev = serverEvidence(inv, pkg.dir);
    // An app package (nothing in the repo depends on it) with a start/serve script runs something too.
    const runs = !pkg.dependents.length && pkg.dir !== '.' && Object.keys(pkg.scripts ?? {}).find((k) => /^(start|serve)(:|$)/.test(k));
    if (ev.length) problems.push(`package ${pkg.dir} has server code (${ev.slice(0, 3).join(', ')}) but is neither a service nor in "skipped"`);
    else if (runs) problems.push(`package ${pkg.dir} has a "${runs}" script but is neither a service nor in "skipped"`);
  }
  return { services, problems, valid };
}

// Deterministic post-processing: Dockerfile locations, existing per-app Dockerfiles, env names.
export function finalize(inv: Inventory, services: ServicePlan[]): ServicePlan[] {
  const used = new Set<string>();
  const serviceNames = new Set(services.map((s) => s.name));
  for (const s of services) {
    s.dependsOn = s.dependsOn.filter((d) => serviceNames.has(d) && d !== s.name);
    if (!s.existingDockerfile) {
      const own = join(s.root, 'Dockerfile');
      // An existing Dockerfile in the service's own directory belongs to it (one per app in monorepos).
      if (inv.files.includes(own) && (s.root !== '.' || services.length === 1) && !used.has(own)) {
        s.dockerfile = own;
        s.existingDockerfile = true;
      }
    }
    if (!s.dockerfile || used.has(s.dockerfile)) {
      const own = join(s.root, 'Dockerfile');
      s.dockerfile = !inv.files.includes(own) && !used.has(own) && (s.root !== '.' || services.length === 1) ? own : join(s.context, `.builddoctor/${s.name}.Dockerfile`);
      s.existingDockerfile = false;
    }
    used.add(s.dockerfile);
    const names = new Set<string>();
    for (const e of inv.ports) if (e.envVar && inDir(e.file, s.root)) names.add(e.envVar);
    s.envVars = [...new Set([...names, ...envNamesUnder(inv, s.root)])].sort();
  }
  return services;
}

function envNamesUnder(inv: Inventory, root: string): string[] {
  return Object.entries(inv.envByPackage).filter(([d]) => inDir(d, root) || d === '.').flatMap(([, names]) => names);
}

export async function planServices(inv: Inventory, opts: { signal?: AbortSignal; log?: (l: string) => void; maxAttempts?: number } = {}): Promise<PlanResult> {
  const log = opts.log ?? (() => {});
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Repository inventory:\n\n${renderInventory(inv)}` },
  ];
  const rejected: string[][] = [];
  let best: { valid: ServicePlan[]; skipped: RawPlan['skipped'] } | undefined;
  const max = opts.maxAttempts ?? 4;
  for (let i = 0; i < max; i++) {
    let raw: RawPlan;
    try {
      raw = await chatJson<RawPlan>(messages, { signal: opts.signal, numCtx: 16384, temperature: 0.1, label: i ? `Planning services · attempt ${i + 1}` : 'Planning services' });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      log(`model unavailable for planning: ${err instanceof Error ? err.message : err}`);
      break;
    }
    const v = validatePlan(inv, raw);
    if (!v.problems.length) {
      return { services: finalize(inv, v.services), skipped: cleanSkipped(raw), source: 'model', attempts: i + 1, rejected };
    }
    rejected.push(v.problems);
    log(`plan attempt ${i + 1} rejected: ${v.problems.join('; ')}`);
    if (v.valid.length && (!best || v.valid.length >= best.valid.length)) best = { valid: v.valid, skipped: raw.skipped };
    messages.push({ role: 'assistant', content: JSON.stringify(raw) }, { role: 'user', content: planFeedback(v.problems, rejected) });
  }
  if (best) return { services: finalize(inv, best.valid), skipped: cleanSkipped({ skipped: best.skipped }), source: 'salvaged', attempts: rejected.length, rejected };
  return { services: [], skipped: [], source: 'fallback', attempts: rejected.length, rejected };
}

// Lists the current problems plus every earlier one as standing constraints, so a fix for one
// problem does not bring back another (small models otherwise oscillate between two mistakes).
export function planFeedback(current: string[], history: string[][]): string {
  const earlier = [...new Set(history.slice(0, -1).flat())].filter((p) => !current.includes(p));
  const parts = [`That plan does not match the repository:\n- ${current.join('\n- ')}`];
  if (earlier.length) parts.push(`Earlier attempts were also rejected for these; the new plan must not repeat any of them:\n- ${earlier.join('\n- ')}`);
  parts.push('Fix every problem listed above at once, using only the inventory, and return the complete JSON plan again.');
  return parts.join('\n\n');
}

function cleanSkipped(raw: RawPlan): PlanResult['skipped'] {
  return (raw.skipped ?? []).filter((s) => s && typeof s === 'object').map((s) => ({ root: norm(s.root), reason: str(s.reason) ?? '' }));
}
