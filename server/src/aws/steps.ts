// AWS half of the pipeline: ECR -> security group -> EC2 -> deploy (SSM) -> health -> dashboard.
import type { Step } from '../pipeline/step.js';
import type { RunConfig } from '../types.js';
import { ecrStep, repoName } from './ecr.js';
import { securityGroupStep } from './network.js';
import { ec2Step } from './ec2.js';
import { deployStep } from './deploy.js';
import { healthStep } from './health.js';
import { dashboardStep, setDashboard } from './dashboard.js';
import { teardown } from './teardown.js';
import { ROLE_NAME } from './util.js';

export const awsSteps: Step[] = [ecrStep, securityGroupStep, ec2Step, deployStep, healthStep, dashboardStep];

export { setDashboard, teardown };

// Human-readable plan for the approval gate (ApprovalRequest.actions).
export function plannedActions(config: RunConfig, appPort: number): string[] {
  const { region, instanceType, existingInstanceId, existingSecurityGroupId, openPorts } = config.aws;
  const ports = [...new Set([appPort, ...(openPorts ?? [])])].filter((p) => p !== 22);
  const actions = [
    `Create ECR repository ${repoName(config.repoUrl)} in ${region} if missing, and push the image`,
    existingSecurityGroupId
      ? `Use security group ${existingSecurityGroupId} (add inbound tcp/${appPort} from 0.0.0.0/0 if missing)`
      : `Create security group with inbound ${ports.map((p) => `tcp/${p}`).join(', ')} from 0.0.0.0/0 (no SSH)`,
    existingInstanceId
      ? `Deploy to existing instance ${existingInstanceId} via SSM`
      : `Create EC2 instance ${instanceType} (Amazon Linux 2023 arm64, 16 GB gp3) in ${region}; create IAM role ${ROLE_NAME} if missing`,
  ];
  if (Object.keys(config.env ?? {}).length) actions.push('Store env vars as SSM SecureString parameters');
  actions.push(`Run container 'app' on port ${appPort}`);
  actions.push(existingSecurityGroupId
    ? `If the health check finds the app listening on a different port, the run stops and asks you to open it on ${existingSecurityGroupId} (your group is not changed further)`
    : 'If the health check finds the app listening on a different port, add an inbound rule for that port from 0.0.0.0/0 to the new security group and redeploy');
  return actions;
}
