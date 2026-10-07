// Multi-service deploys: which containers run on the instance, with which image, port and env wiring.
// A single-service run is one container named 'app' (the pre-monorepo behaviour, unchanged).
import type { ApprovalService, RunState } from '../types.js';
import { envFor, imageTag, serviceImageTag } from '../steps/common.js';
import { appPort, repoSlug } from './util.js';

export interface DeployService {
  name: string;
  primary: boolean;
  container: string;            // 'app' for single-service runs, app-<service> otherwise
  port: number;                 // container port, published on the same host port
  kind: 'server' | 'static';
  localImage: string;           // local tag from the build step
  tag: string;                  // ECR tag: <runId> for the primary (unchanged scheme), <runId>-<service> for the rest
  envVars: string[];            // names the service reads
  dependsOn: string[];          // services it calls
}

export function isMulti(run: RunState): boolean {
  return (run.analysis?.services?.length ?? 0) > 1;
}

// User-defined bridge network: containers on it resolve each other by container name.
export function networkName(runId: string): string {
  return `builddoctor-${runId}`;
}

export function deployServices(run: RunState): DeployService[] {
  const plans = run.analysis?.services ?? [];
  if (plans.length <= 1) {
    const p = plans[0];
    return [{
      name: p?.name ?? 'app', primary: true, container: 'app', port: appPort(run), kind: p?.kind ?? 'server',
      localImage: imageTag(run.id), tag: run.id, envVars: p?.envVars ?? run.analysis?.envVars ?? [], dependsOn: [],
    }];
  }
  return plans.map((p, i) => ({
    name: p.name,
    primary: i === 0,
    container: `app-${p.name}`,
    port: i === 0 ? appPort(run) : p.port,
    kind: p.kind,
    localImage: serviceImageTag(run.id, p, i === 0),
    tag: i === 0 ? run.id : `${run.id}-${p.name}`,
    envVars: p.envVars,
    dependsOn: p.dependsOn,
  }));
}

// Dependencies start first so a service's upstream is already up; cycles fall back to plan order.
export function startOrder(services: DeployService[]): DeployService[] {
  const out: DeployService[] = [];
  const visiting = new Set<string>();
  const visit = (s: DeployService) => {
    if (out.includes(s) || visiting.has(s.name)) return;
    visiting.add(s.name);
    for (const d of s.dependsOn) {
      const dep = services.find((x) => x.name === d);
      if (dep) visit(dep);
    }
    out.push(s);
  };
  services.forEach(visit);
  return out;
}

const URL_WORDS = new Set(['URL', 'URI', 'ENDPOINT', 'ORIGIN', 'BASE', 'ADDR', 'ADDRESS']);

// What an env var name says about a dependency: API_URL, VITE_API_URL, API_BASE_URL -> 'url';
// API_HOST -> 'host'; API_PORT -> 'port'. The dependency's name must appear as whole words.
export function addressRef(envName: string, dep: string): 'url' | 'host' | 'port' | undefined {
  const tokens = envName.toUpperCase().split('_').filter(Boolean);
  const want = dep.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  if (!want.length) return undefined;
  for (let i = 0; i + want.length <= tokens.length; i++) {
    if (!want.every((w, j) => tokens[i + j] === w)) continue;
    const rest = tokens.slice(i + want.length);
    if (rest.includes('HOST') || rest.includes('HOSTNAME')) return 'host';
    if (rest.includes('PORT')) return 'port';
    if (rest.some((t) => URL_WORDS.has(t))) return 'url';
  }
  return undefined;
}

const IGNORED_ENV = /^(PORT|HOST|HOSTNAME|NODE_ENV)$/;

export interface EnvLinks {
  injected: Record<string, string>; // name -> another service's address (not secret)
  unset: string[];                  // read by the service, provided by nobody
  notes: string[];                  // "you may need to set X" for addresses we cannot wire up
}

// Wires dependency addresses into env, using only what the plan says: the service depends on D and
// reads an env var whose name refers to D's address. A value the user provided always wins. Anything
// we cannot map is reported, never guessed.
export function envLinks(run: RunState, services: DeployService[], svc: DeployService): EnvLinks {
  const provided = envFor(run, svc.name);
  const injected: Record<string, string> = {};
  const notes: string[] = [];
  const noted = new Set<string>();
  for (const depName of svc.dependsOn) {
    const dep = services.find((s) => s.name === depName);
    if (!dep) continue;
    const refs = svc.envVars
      .map((n) => [n, addressRef(n, dep.name)] as const)
      .filter((r): r is readonly [string, 'url' | 'host' | 'port'] => !!r[1]);
    if (!refs.length) {
      if (svc.kind === 'server') {
        notes.push(`${svc.name} calls ${dep.name}, but none of the env vars it reads names ${dep.name}'s address; you may need to set one (inside the instance ${dep.name} is at http://${dep.container}:${dep.port})`);
      } else {
        notes.push(`${svc.name} calls ${dep.name}; its static build must already contain ${dep.name}'s public address (port ${dep.port}), you may need to set it at build time`);
      }
      continue;
    }
    for (const [name, ref] of refs) {
      if (name in provided || name in injected) continue;
      if (svc.kind === 'static') {
        // A static bundle has its env baked in at build time, and the browser cannot resolve container names.
        notes.push(`you may need to set ${name} for ${svc.name}: it is a static build, so the value is fixed at build time and must be ${dep.name}'s public address (port ${dep.port})`);
        noted.add(name);
        continue;
      }
      injected[name] = ref === 'host' ? dep.container : ref === 'port' ? String(dep.port) : `http://${dep.container}:${dep.port}`;
    }
  }
  const unset = svc.envVars.filter((n) => !IGNORED_ENV.test(n) && !(n in provided) && !(n in injected) && !noted.has(n)).sort();
  return { injected, unset, notes };
}

// The URL people open: a static frontend if there is one, else a web-looking service, else the primary.
export function frontService(services: DeployService[]): DeployService {
  return services.find((s) => s.kind === 'static')
    ?? services.find((s) => /^(web|www|frontend|front|ui|client|site|app)$/.test(s.name))
    ?? services.find((s) => s.primary)!;
}

export function approvalServices(run: RunState): ApprovalService[] | undefined {
  if (!isMulti(run)) return undefined;
  const services = deployServices(run);
  const repo = `builddoctor/${repoSlug(run.config.repoUrl)}`; // repoName() in ecr.ts
  return services.map((s) => {
    const { injected, unset, notes } = envLinks(run, services, s);
    return { name: s.name, container: s.container, image: `${repo}:${s.tag}`, port: s.port, kind: s.kind, injected, unset, notes };
  });
}
