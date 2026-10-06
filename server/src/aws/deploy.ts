import { DeleteParametersCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import type { Step, StepContext } from '../pipeline/step.js';
import type { RunState } from '../types.js';
import { clients } from './clients.js';
import { runShell } from './ssm.js';
import { appPort, errMsg, errName, shellQuote, tags } from './util.js';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function envParamPrefix(runId: string): string {
  return `/builddoctor/${runId}/env/`;
}

// Env values travel as SSM SecureStrings (default aws/ssm key) and are fetched on the
// instance, so they never appear in SendCommand parameters, command history or our logs.
// The instance role may read only parameters under /builddoctor/* (see INSTANCE_ROLE_POLICY).
// Empty values are not stored (SSM rejects them) and are written as NAME= directly.
async function storeEnv(run: RunState): Promise<{ stored: string[]; empty: string[] }> {
  const env = run.config.env ?? {};
  const all = Object.keys(env);
  const bad = all.filter((n) => !ENV_NAME.test(n));
  if (bad.length) throw new Error(`Invalid env var name(s): ${bad.join(', ')}`);
  const names = all.filter((n) => env[n] !== '');
  const { ssm } = clients(run.config.aws.region);
  for (const name of names) {
    const Name = envParamPrefix(run.id) + name;
    const base = { Name, Value: env[name], Type: 'SecureString' as const };
    try {
      await ssm.send(new PutParameterCommand({ ...base, Tags: tags(run.id) }));
    } catch (e) {
      // Tags cannot be combined with Overwrite, so a redeploy overwrites untagged.
      if (errName(e) !== 'ParameterAlreadyExists') throw e;
      await ssm.send(new PutParameterCommand({ ...base, Overwrite: true }));
    }
  }
  return { stored: names, empty: all.filter((n) => env[n] === '') };
}

export async function deleteEnvParams(run: RunState): Promise<string[]> {
  const env = run.config.env ?? {};
  const names = Object.keys(env).filter((n) => env[n] !== '').map((n) => envParamPrefix(run.id) + n);
  const deleted: string[] = [];
  const { ssm } = clients(run.config.aws.region);
  for (let i = 0; i < names.length; i += 10) {
    const res = await ssm.send(new DeleteParametersCommand({ Names: names.slice(i, i + 10) }));
    deleted.push(...(res.DeletedParameters ?? []));
  }
  return deleted;
}

export function deployScript(opts: {
  region: string; imageUri: string; port: number; runId: string; envNames: string[]; emptyEnv?: string[];
}): string {
  const { region, imageUri, port, runId, envNames, emptyEnv = [] } = opts;
  const registry = imageUri.split('/')[0];
  const envFile = '/opt/builddoctor/app.env';
  const fetchEnv = envNames.map((n) =>
    `v=$(aws ssm get-parameter --region ${region} --with-decryption --name ${shellQuote(envParamPrefix(runId) + n)} --query Parameter.Value --output text) && printf '%s=%s\\n' ${n} "$v" >> ${envFile}`);
  fetchEnv.push(...emptyEnv.map((n) => `printf '%s=\\n' ${n} >> ${envFile}`));
  const total = envNames.length + emptyEnv.length;
  const portEnv = envNames.includes('PORT') || emptyEnv.includes('PORT') ? '' : ` -e PORT=${port}`;
  return [
    'set -euo pipefail',
    'cloud-init status --wait >/dev/null 2>&1 || true',
    'if ! command -v docker >/dev/null 2>&1; then echo "Installing docker"; dnf install -y -q docker; fi',
    'systemctl enable --now docker >/dev/null 2>&1 || true',
    'for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 2; done',
    `echo "Logging in to ${registry}"`,
    `aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${registry} >/dev/null`,
    `echo "Pulling ${imageUri}"`,
    `docker pull -q ${imageUri}`,
    `mkdir -p /opt/builddoctor && umask 077 && : > ${envFile}`,
    ...fetchEnv,
    `echo "Env file written (${total} vars)"`,
    'docker rm -f app >/dev/null 2>&1 || true',
    `docker run -d --name app --restart unless-stopped -p ${port}:${port}${portEnv} --env-file ${envFile} ${imageUri}`,
    'sleep 3',
    `docker ps -a --filter name=^app$ --format 'app container: {{.Status}}'`,
  ].join('\n');
}

export const deployStep: Step = {
  id: 'deploy',
  async run(ctx: StepContext) {
    const { run } = ctx;
    const { instanceId, imageUri } = run.outputs;
    if (!instanceId || !imageUri) return { ok: false, summary: 'Nothing to deploy', error: 'Missing instanceId or imageUri from earlier steps' };
    const port = appPort(run);
    try {
      const { stored, empty } = await storeEnv(run);
      if (stored.length) ctx.log(`Stored ${stored.length} env var(s) as SSM SecureStrings: ${stored.join(', ')}`);
      const script = deployScript({ region: run.config.aws.region, imageUri, port, runId: run.id, envNames: stored, emptyEnv: empty });
      ctx.log(`Deploying ${imageUri.split('/').pop()} to ${instanceId} on port ${port}`);
      const res = await runShell(run.config.aws.region, instanceId, script, { comment: `BuildDoctor deploy ${run.id}`, log: ctx.log, signal: ctx.signal });
      if (res.status !== 'Success') {
        const tail = (res.stderr || res.stdout).trim().split('\n').slice(-20).join('\n');
        return { ok: false, summary: `Deploy command ${res.status}`, error: `exit ${res.exitCode}: ${tail}` };
      }
      return { ok: true, summary: `Container 'app' started on :${port}`, output: { instanceId, imageUri, port } };
    } catch (e) {
      return { ok: false, summary: 'Deploy failed', error: errMsg(e) };
    }
  },
};
