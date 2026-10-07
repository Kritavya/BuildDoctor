// AWS half of the pipeline: ECR -> security group -> EC2 -> deploy (SSM) -> health -> dashboard.
import type { Step } from '../pipeline/step.js';
import type { ApprovalRequest, ApprovalService, RunConfig, RunState } from '../types.js';
import { ecrStep, repoName } from './ecr.js';
import { securityGroupStep } from './network.js';
import { ec2Step } from './ec2.js';
import { deployStep } from './deploy.js';
import { healthStep } from './health.js';
import { dashboardStep, setDashboard } from './dashboard.js';
import { teardown } from './teardown.js';
import { approvalServices, networkName } from './services.js';
import { ROLE_NAME, appPort } from './util.js';

export const awsSteps: Step[] = [ecrStep, securityGroupStep, ec2Step, deployStep, healthStep, dashboardStep];

export { setDashboard, teardown };

// Human-readable plan for the approval gate (ApprovalRequest.actions). `services` (multi-service runs)
// adds one line per container with its image and port, the env wiring, and what may still need setting.
export function plannedActions(config: RunConfig, appPort: number, services?: ApprovalService[], runId?: string): string[] {
  const { region, instanceType, existingInstanceId, existingSecurityGroupId, openPorts } = config.aws;
  const multi = !!services && services.length > 1;
  const appPorts = multi ? [...new Set(services!.map((s) => s.port))] : [appPort];
  const ports = [...new Set([...appPorts, ...(openPorts ?? [])])].filter((p) => p !== 22);
  const tcp = (ps: number[]) => ps.filter((p) => p !== 22).map((p) => `tcp/${p}`).join(', ');
  const actions = [
    multi
      ? `Create ECR repository ${repoName(config.repoUrl)} in ${region} if missing, and push ${services!.length} images (one per service)`
      : `Create ECR repository ${repoName(config.repoUrl)} in ${region} if missing, and push the image`,
    existingSecurityGroupId
      ? `Use security group ${existingSecurityGroupId} (add inbound ${tcp(appPorts)} from 0.0.0.0/0 if missing)`
      : `Create security group with inbound ${tcp(ports)} from 0.0.0.0/0 (no SSH)`,
    existingInstanceId
      ? `Deploy to existing instance ${existingInstanceId} via SSM`
      : `Create EC2 instance ${instanceType} (Amazon Linux 2023 arm64, 16 GB gp3) in ${region}; create IAM role ${ROLE_NAME} if missing`,
  ];
  const perService = Object.values(config.serviceEnv ?? {}).some((e) => Object.keys(e ?? {}).length);
  if (Object.keys(config.env ?? {}).length || perService) actions.push('Store env vars as SSM SecureString parameters');
  if (!multi) {
    actions.push(`Run container 'app' on port ${appPort}`);
  } else {
    actions.push(`Create Docker network ${runId ? networkName(runId) : 'builddoctor-<run>'} on the instance so the ${services!.length} services reach each other by container name`);
    for (const s of services!) {
      const wired = Object.entries(s.injected).map(([k, v]) => `${k}=${v}`);
      actions.push(`Run container '${s.container}' (${s.name}, image ${s.image}) on port ${s.port}${wired.length ? `, with ${wired.join(', ')}` : ''}`);
    }
    for (const s of services!) {
      for (const n of s.notes) actions.push(`Check ${s.name}: ${n}`);
      if (s.unset.length) actions.push(`Env vars ${s.name} reads that were not provided: ${s.unset.join(', ')} (you may need to set ${s.unset.length > 1 ? 'them' : 'it'})`);
    }
  }
  actions.push(existingSecurityGroupId
    ? `If the health check finds the app listening on a different port, the run stops and asks you to open it on ${existingSecurityGroupId} (your group is not changed further)`
    : 'If the health check finds the app listening on a different port, add an inbound rule for that port from 0.0.0.0/0 to the new security group and redeploy');
  return actions;
}

// Approval request for a run: the action list, plus the per-service breakdown on multi-service runs.
export function approvalPlan(run: RunState): ApprovalRequest {
  const services = approvalServices(run);
  return { actions: plannedActions(run.config, appPort(run), services, run.id), ...(services ? { services } : {}) };
}
