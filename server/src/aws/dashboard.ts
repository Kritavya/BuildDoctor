import type { Step } from '../pipeline/step.js';
import type { DeployOutputs, RunState } from '../types.js';
import { runShell } from './ssm.js';
import { authorizePorts, revokeTagged } from './network.js';
import { DASHBOARD_PORTS, DASHBOARD_RULE_DESC } from './util.js';

// Both manifests list amd64 + arm64 (checked against the registries).
export const CADVISOR_IMAGE = 'gcr.io/cadvisor/cadvisor:v0.55.1';
export const DOZZLE_IMAGE = 'amir20/dozzle:v11.3.0';
const PORTS = [DASHBOARD_PORTS.metrics, DASHBOARD_PORTS.logs];

export const START_SCRIPT = [
  'set -e',
  `docker inspect -f '{{.State.Running}}' bd-cadvisor 2>/dev/null | grep -q true || {`,
  '  docker rm -f bd-cadvisor >/dev/null 2>&1 || true',
  `  docker run -d --name bd-cadvisor --restart unless-stopped -p ${DASHBOARD_PORTS.metrics}:8080 \\`,
  '    -v /:/rootfs:ro -v /var/run:/var/run:ro -v /sys:/sys:ro -v /var/lib/docker/:/var/lib/docker:ro -v /dev/disk/:/dev/disk:ro \\',
  `    --privileged --device=/dev/kmsg ${CADVISOR_IMAGE}`,
  '}',
  `docker inspect -f '{{.State.Running}}' bd-dozzle 2>/dev/null | grep -q true || {`,
  '  docker rm -f bd-dozzle >/dev/null 2>&1 || true',
  `  docker run -d --name bd-dozzle --restart unless-stopped -p ${DASHBOARD_PORTS.logs}:8080 \\`,
  `    -v /var/run/docker.sock:/var/run/docker.sock:ro ${DOZZLE_IMAGE}`,
  '}',
  `docker ps --filter name=bd- --format '{{.Names}}: {{.Status}}'`,
].join('\n');

export const STOP_SCRIPT = 'docker rm -f bd-cadvisor bd-dozzle >/dev/null 2>&1 || true; echo stopped';

async function callerCidr(): Promise<string> {
  const res = await fetch('https://checkip.amazonaws.com', { signal: AbortSignal.timeout(10_000) });
  const ip = (await res.text()).trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error(`Unexpected response from checkip: ${ip.slice(0, 50)}`);
  return `${ip}/32`;
}

// Idempotent: enabling twice keeps one container pair and one rule per port (stale caller IPs are revoked).
export async function setDashboard(run: RunState, enabled: boolean): Promise<DeployOutputs['dashboard']> {
  const region = run.config.aws.region;
  const { instanceId, securityGroupId, publicIp } = run.outputs;
  if (!instanceId || !securityGroupId || !publicIp) throw new Error('Dashboard needs a deployed instance and security group');

  if (enabled) {
    const cidr = await callerCidr();
    const res = await runShell(region, instanceId, START_SCRIPT, { comment: `BuildDoctor dashboard on ${run.id}` });
    if (res.status !== 'Success') throw new Error(`Starting dashboard containers failed: ${(res.stderr || res.stdout).trim().slice(-500)}`);
    await revokeTagged(region, securityGroupId, PORTS, DASHBOARD_RULE_DESC, cidr, run);
    await authorizePorts(region, securityGroupId, PORTS, cidr, DASHBOARD_RULE_DESC, run);
    run.outputs.dashboard = {
      enabled: true,
      metricsUrl: `http://${publicIp}:${DASHBOARD_PORTS.metrics}/`,
      logsUrl: `http://${publicIp}:${DASHBOARD_PORTS.logs}/`,
    };
  } else {
    const res = await runShell(region, instanceId, STOP_SCRIPT, { comment: `BuildDoctor dashboard off ${run.id}` });
    if (res.status !== 'Success') throw new Error(`Stopping dashboard containers failed: ${(res.stderr || res.stdout).trim().slice(-500)}`);
    await revokeTagged(region, securityGroupId, PORTS, DASHBOARD_RULE_DESC, undefined, run);
    run.outputs.dashboard = { enabled: false };
  }
  return run.outputs.dashboard;
}

export const dashboardStep: Step = {
  id: 'dashboard',
  async run(ctx) {
    // Keep a state already set through the API while the pipeline was still running.
    ctx.run.outputs.dashboard ??= { enabled: false };
    ctx.log(`Monitoring dashboard (cAdvisor metrics :${DASHBOARD_PORTS.metrics}, Dozzle logs :${DASHBOARD_PORTS.logs}) is available but off.`);
    ctx.log('Enabling it opens those ports to your current public IP only.');
    return {
      ok: true,
      summary: 'Dashboard available (off)',
      output: { enabled: false, available: true, ports: DASHBOARD_PORTS },
    };
  },
};
