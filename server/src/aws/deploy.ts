import { DeleteParametersCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import type { Step, StepContext } from '../pipeline/step.js';
import type { RunState } from '../types.js';
import { serviceStatus } from '../steps/common.js';
import { clients } from './clients.js';
import { runShell } from './ssm.js';
import { ensureAppPort } from './network.js';
import { deployServices, envLinks, networkName, startOrder, type DeployService } from './services.js';
import { errMsg, errName, shellQuote, tags } from './util.js';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Global env lives under env/<NAME>; a service's own env (RunConfig.serviceEnv) under svc/<service>/env/<NAME>.
export function envParamPrefix(runId: string, service?: string): string {
  return service ? `/builddoctor/${runId}/svc/${service}/env/` : `/builddoctor/${runId}/env/`;
}

// Where each env var of a container comes from. Only `value` entries are written into the script,
// and those are inter-service addresses, never user-supplied values.
export type EnvEntry =
  | { name: string; param: string }   // SSM SecureString, fetched on the instance
  | { name: string; empty: true }     // provided as an empty string (SSM rejects empty values)
  | { name: string; value: string };  // another service's address on the Docker network

function serviceEnvOf(run: RunState, service: string): Record<string, string> {
  return run.config.serviceEnv?.[service] ?? {};
}

// The env a service's container gets: global env, then its own env (which wins), then dependency addresses
// for names nobody provided.
export function envEntries(run: RunState, svc: DeployService, injected: Record<string, string> = {}): EnvEntry[] {
  const global = run.config.env ?? {};
  const own = serviceEnvOf(run, svc.name);
  const out: EnvEntry[] = [];
  for (const [name, v] of Object.entries(global)) {
    if (name in own) continue;
    out.push(v === '' ? { name, empty: true } : { name, param: envParamPrefix(run.id) + name });
  }
  for (const [name, v] of Object.entries(own)) {
    out.push(v === '' ? { name, empty: true } : { name, param: envParamPrefix(run.id, svc.name) + name });
  }
  for (const [name, value] of Object.entries(injected)) if (!out.some((e) => e.name === name)) out.push({ name, value });
  return out;
}

// Env values travel as SSM SecureStrings (default aws/ssm key) and are fetched on the
// instance, so they never appear in SendCommand parameters, command history or our logs.
// The instance role may read only parameters under /builddoctor/* (see INSTANCE_ROLE_POLICY).
// Empty values are not stored (SSM rejects them) and are written as NAME= directly.
async function storeEnv(run: RunState, services: DeployService[], log: (l: string) => void): Promise<string[]> {
  const sets: Array<{ label: string; prefix: string; env: Record<string, string> }> = [
    { label: '', prefix: envParamPrefix(run.id), env: run.config.env ?? {} },
  ];
  for (const [service, env] of Object.entries(run.config.serviceEnv ?? {})) {
    if (!services.some((s) => s.name === service)) {
      log(`Ignoring env for unknown service "${service}" (services: ${services.map((s) => s.name).join(', ')})`);
      continue;
    }
    sets.push({ label: `${service}/`, prefix: envParamPrefix(run.id, service), env: env ?? {} });
  }
  const bad = sets.flatMap((s) => Object.keys(s.env).filter((n) => !ENV_NAME.test(n)).map((n) => s.label + n));
  if (bad.length) throw new Error(`Invalid env var name(s): ${bad.join(', ')}`);
  const { ssm } = clients(run.config.aws.region);
  const stored: string[] = [];
  for (const { label, prefix, env } of sets) {
    for (const name of Object.keys(env).filter((n) => env[n] !== '')) {
      const base = { Name: prefix + name, Value: env[name], Type: 'SecureString' as const };
      try {
        await ssm.send(new PutParameterCommand({ ...base, Tags: tags(run.id) }));
      } catch (e) {
        // Tags cannot be combined with Overwrite, so a redeploy overwrites untagged.
        if (errName(e) !== 'ParameterAlreadyExists') throw e;
        await ssm.send(new PutParameterCommand({ ...base, Overwrite: true }));
      }
      stored.push(label + name);
    }
  }
  return stored;
}

export function hasEnvParams(run: RunState): boolean {
  return [run.config.env ?? {}, ...Object.values(run.config.serviceEnv ?? {})].some((e) => Object.values(e ?? {}).some((v) => v !== ''));
}

export async function deleteEnvParams(run: RunState): Promise<string[]> {
  const nonEmpty = (env: Record<string, string> | undefined) => Object.keys(env ?? {}).filter((n) => env![n] !== '');
  const names = [
    ...nonEmpty(run.config.env).map((n) => envParamPrefix(run.id) + n),
    ...Object.entries(run.config.serviceEnv ?? {}).flatMap(([svc, env]) => nonEmpty(env).map((n) => envParamPrefix(run.id, svc) + n)),
  ];
  const deleted: string[] = [];
  const { ssm } = clients(run.config.aws.region);
  for (let i = 0; i < names.length; i += 10) {
    const res = await ssm.send(new DeleteParametersCommand({ Names: names.slice(i, i + 10) }));
    deleted.push(...(res.DeletedParameters ?? []));
  }
  return deleted;
}

export interface ContainerSpec {
  container: string;
  imageUri: string;
  port: number;
  env: EnvEntry[];
}

// One script for all containers. With `network`, every container joins that user-defined bridge network,
// so services reach each other as http://<container>:<port>; without it (single service) the script is
// the original one-container deploy.
export function deployScript(opts: { region: string; containers: ContainerSpec[]; network?: string }): string {
  const { region, containers, network } = opts;
  const registries = [...new Set(containers.map((c) => c.imageUri.split('/')[0]))];
  const images = [...new Set(containers.map((c) => c.imageUri))];
  const lines = [
    'set -euo pipefail',
    'cloud-init status --wait >/dev/null 2>&1 || true',
    'if ! command -v docker >/dev/null 2>&1; then echo "Installing docker"; dnf install -y -q docker; fi',
    'systemctl enable --now docker >/dev/null 2>&1 || true',
    'for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 2; done',
  ];
  for (const registry of registries) {
    lines.push(`echo "Logging in to ${registry}"`, `aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${registry} >/dev/null`);
  }
  for (const image of images) lines.push(`echo "Pulling ${image}"`, `docker pull -q ${image}`);
  if (network) {
    lines.push(`docker network inspect ${network} >/dev/null 2>&1 || docker network create ${network} >/dev/null`, `echo "Network ${network} ready"`);
  }
  for (const c of containers) {
    const envFile = `/opt/builddoctor/${c.container}.env`;
    const fetchEnv = c.env.map((e) =>
      'param' in e
        ? `v=$(aws ssm get-parameter --region ${region} --with-decryption --name ${shellQuote(e.param)} --query Parameter.Value --output text) && printf '%s=%s\\n' ${e.name} "$v" >> ${envFile}`
        : 'value' in e
          ? `printf '%s=%s\\n' ${e.name} ${shellQuote(e.value)} >> ${envFile}`
          : `printf '%s=\\n' ${e.name} >> ${envFile}`);
    const portEnv = c.env.some((e) => e.name === 'PORT') ? '' : ` -e PORT=${c.port}`;
    const net = network ? ` --network ${network}` : '';
    lines.push(
      `mkdir -p /opt/builddoctor && umask 077 && : > ${envFile}`,
      ...fetchEnv,
      network ? `echo "${c.container}: env file written (${c.env.length} vars)"` : `echo "Env file written (${c.env.length} vars)"`,
      `docker rm -f ${c.container} >/dev/null 2>&1 || true`,
      `docker run -d --name ${c.container}${net} --restart unless-stopped -p ${c.port}:${c.port}${portEnv} --env-file ${envFile} ${c.imageUri}`,
    );
  }
  lines.push('sleep 3');
  for (const c of containers) lines.push(`docker ps -a --filter name=^${c.container}$ --format '${c.container} container: {{.Status}}'`);
  return lines.join('\n');
}

export const deployStep: Step = {
  id: 'deploy',
  async run(ctx: StepContext) {
    const { run } = ctx;
    const { instanceId, imageUri } = run.outputs;
    if (!instanceId || !imageUri) return { ok: false, summary: 'Nothing to deploy', error: 'Missing instanceId or imageUri from earlier steps' };
    const services = deployServices(run);
    const multi = services.length > 1;
    const uriOf = (s: DeployService) => (multi ? run.outputs.services?.[s.name]?.imageUri : imageUri);
    const missing = services.filter((s) => !uriOf(s));
    if (missing.length) return { ok: false, summary: 'Nothing to deploy', error: `No pushed image for ${missing.map((s) => s.name).join(', ')}` };
    try {
      // A doctor-loop port remap can change a port after the security group step ran.
      for (const s of services) {
        const blocked = await ensureAppPort(run, s.port, ctx.log);
        if (!blocked) continue;
        const tag = multi ? `${s.name}: ` : '';
        return { ok: false, summary: `${tag}Port ${s.port} not allowed on your security group`, error: blocked, ...(multi ? { service: s.name } : {}),
          diagnosis: { rootCause: blocked, evidence: `No inbound rule for tcp/${s.port}`, attemptedFix: 'none', result: 'not-fixed', nextStep: `Open tcp/${s.port} on your security group, then start a new run.` } };
      }
      const stored = await storeEnv(run, services, ctx.log);
      if (stored.length) ctx.log(`Stored ${stored.length} env var(s) as SSM SecureStrings: ${stored.join(', ')}`);

      const containers: ContainerSpec[] = startOrder(services).map((s) => {
        const { injected, notes } = multi ? envLinks(run, services, s) : { injected: {}, notes: [] };
        for (const [k, v] of Object.entries(injected)) ctx.log(`[${s.name}] ${k}=${v} (address of a service it calls)`);
        for (const n of notes) ctx.log(`[${s.name}] note: ${n}`);
        return { container: s.container, imageUri: uriOf(s)!, port: s.port, env: envEntries(run, s, injected) };
      });
      const script = deployScript({ region: run.config.aws.region, containers, network: multi ? networkName(run.id) : undefined });
      if (multi) {
        for (const s of services) serviceStatus(ctx, 'deploy', true, s.name, 'running');
        ctx.log(`Deploying ${services.length} containers to ${instanceId} on network ${networkName(run.id)}: ${containers.map((c) => `${c.container} :${c.port}`).join(', ')}`);
      } else {
        ctx.log(`Deploying ${imageUri.split('/').pop()} to ${instanceId} on port ${services[0].port}`);
      }
      const res = await runShell(run.config.aws.region, instanceId, script, { comment: `BuildDoctor deploy ${run.id}`, log: ctx.log, signal: ctx.signal });
      if (res.status !== 'Success') {
        const tail = (res.stderr || res.stdout).trim().split('\n').slice(-20).join('\n');
        // The script stops at the first failing container; the ones before it did start.
        for (const s of services) {
          const up = new RegExp(`^${s.container} container: Up`, 'm').test(res.stdout);
          serviceStatus(ctx, 'deploy', multi, s.name, up ? 'success' : 'failed');
        }
        return { ok: false, summary: `Deploy command ${res.status}`, error: `exit ${res.exitCode}: ${tail}` };
      }
      if (!multi) {
        const port = services[0].port;
        return { ok: true, summary: `Container 'app' started on :${port}`, output: { instanceId, imageUri, port } };
      }
      const out: Record<string, { container: string; imageUri: string; port: number }> = {};
      for (const s of services) {
        const uri = uriOf(s)!;
        run.outputs.services = { ...run.outputs.services, [s.name]: { ...run.outputs.services?.[s.name], port: s.port, container: s.container, imageUri: uri } };
        out[s.name] = { container: s.container, imageUri: uri, port: s.port };
        serviceStatus(ctx, 'deploy', true, s.name, 'success', `${s.container} :${s.port}`);
      }
      return {
        ok: true,
        summary: `${services.length} containers started · ${services.map((s) => `${s.name} :${s.port}`).join(', ')}`,
        output: { instanceId, imageUri, port: services[0].port, network: networkName(run.id), services: out },
      };
    } catch (e) {
      return { ok: false, summary: 'Deploy failed', error: errMsg(e) };
    }
  },
};
