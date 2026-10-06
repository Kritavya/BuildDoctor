import {
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  DescribeSecurityGroupsCommand,
  DescribeVpcsCommand,
  RevokeSecurityGroupIngressCommand,
  type IpPermission,
  type SecurityGroup,
} from '@aws-sdk/client-ec2';
import type { Step } from '../pipeline/step.js';
import type { RunState } from '../types.js';
import { clients } from './clients.js';
import { appPort, errMsg, errName, forgetCreated, recordCreated, sgRuleId, tags, wasCreated } from './util.js';

export async function describeSg(region: string, groupId: string): Promise<SecurityGroup> {
  const res = await clients(region).ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: [groupId] }));
  const sg = res.SecurityGroups?.[0];
  if (!sg) throw new Error(`Security group ${groupId} not found`);
  return sg;
}

function covers(p: IpPermission, port: number): boolean {
  if (p.IpProtocol === '-1') return true;
  return p.IpProtocol === 'tcp' && (p.FromPort ?? 0) <= port && port <= (p.ToPort ?? -1);
}

// True when the port is reachable from anywhere (0.0.0.0/0) per the SG rules.
export function portOpenToWorld(sg: SecurityGroup, port: number): boolean {
  return (sg.IpPermissions ?? []).some((p) => covers(p, port) && (p.IpRanges ?? []).some((r) => r.CidrIp === '0.0.0.0/0'));
}

// Adds tcp ingress per port. With `run`, rules newly added to a security group this run
// did not create are recorded as 'sg-rule' so teardown can revoke them.
export async function authorizePorts(
  region: string, groupId: string, ports: number[], cidr: string, description: string, run?: RunState,
): Promise<number[]> {
  const { ec2 } = clients(region);
  const added: number[] = [];
  for (const port of ports) {
    try {
      await ec2.send(new AuthorizeSecurityGroupIngressCommand({
        GroupId: groupId,
        IpPermissions: [{ IpProtocol: 'tcp', FromPort: port, ToPort: port, IpRanges: [{ CidrIp: cidr, Description: description }] }],
      }));
      added.push(port);
      if (run && !wasCreated(run, 'sg', groupId)) recordCreated(run, 'sg-rule', sgRuleId(groupId, port, cidr));
    } catch (e) {
      if (errName(e) !== 'InvalidPermission.Duplicate') throw e;
    }
  }
  return added;
}

// Revokes rules on `ports` carrying our description, optionally keeping one CIDR.
export async function revokeTagged(
  region: string, groupId: string, ports: number[], description: string, keepCidr?: string, run?: RunState,
): Promise<number> {
  const sg = await describeSg(region, groupId);
  const perms: IpPermission[] = [];
  for (const p of sg.IpPermissions ?? []) {
    if (p.IpProtocol !== 'tcp' || p.FromPort !== p.ToPort || !ports.includes(p.FromPort ?? -1)) continue;
    const ranges = (p.IpRanges ?? []).filter((r) => r.Description === description && r.CidrIp !== keepCidr);
    if (ranges.length) perms.push({ IpProtocol: 'tcp', FromPort: p.FromPort, ToPort: p.ToPort, IpRanges: ranges });
  }
  if (perms.length) await clients(region).ec2.send(new RevokeSecurityGroupIngressCommand({ GroupId: groupId, IpPermissions: perms }));
  if (run) for (const p of perms) for (const r of p.IpRanges ?? []) forgetCreated(run, 'sg-rule', sgRuleId(groupId, p.FromPort!, r.CidrIp!));
  return perms.reduce((n, p) => n + (p.IpRanges?.length ?? 0), 0);
}

export function inboundPorts(run: RunState): { ports: number[]; dropped: number[] } {
  const all = [appPort(run), ...(run.config.aws.openPorts ?? [])];
  // SSH is never opened: the instance is managed through SSM.
  const dropped = all.filter((p) => p === 22);
  const ports = [...new Set(all.filter((p) => p !== 22 && Number.isInteger(p) && p > 0 && p < 65536))];
  return { ports, dropped };
}

export const securityGroupStep: Step = {
  id: 'securityGroup',
  async run(ctx) {
    const { run } = ctx;
    const region = run.config.aws.region;
    const { ec2 } = clients(region);
    const port = appPort(run);
    try {
      const existing = run.config.aws.existingSecurityGroupId;
      if (existing) {
        const sg = await describeSg(region, existing);
        if (!sg.Tags?.some((t) => t.Key === 'Project' && t.Value === 'BuildDoctor')) {
          return { ok: false, summary: 'Security group not opted in', error: `Security group ${existing} is not tagged Project=BuildDoctor. Add that tag to let BuildDoctor manage its rules.` };
        }
        ctx.log(`Using existing security group ${existing} (${sg.GroupName})`);
        if (portOpenToWorld(sg, port)) {
          ctx.log(`Port ${port} is already open`);
        } else {
          ctx.log(`Adding inbound rule tcp/${port} from 0.0.0.0/0 to your security group ${existing}`);
          await authorizePorts(region, existing, [port], '0.0.0.0/0', 'BuildDoctor app port', run);
          ctx.log('This rule is removed again on teardown');
        }
        run.outputs.securityGroupId = existing;
        return { ok: true, summary: `Using ${existing}`, output: { securityGroupId: existing, reused: true } };
      }

      const vpc = (await ec2.send(new DescribeVpcsCommand({ Filters: [{ Name: 'is-default', Values: ['true'] }] }))).Vpcs?.[0];
      if (!vpc?.VpcId) {
        return { ok: false, summary: 'No default VPC', error: `No default VPC in ${region}; provide existingSecurityGroupId or create a default VPC.` };
      }
      const name = `builddoctor-${run.id}`;
      const res = await ec2.send(new CreateSecurityGroupCommand({
        GroupName: name,
        Description: `BuildDoctor run ${run.id}`,
        VpcId: vpc.VpcId,
        TagSpecifications: [{ ResourceType: 'security-group', Tags: tags(run.id, name) }],
      }));
      const groupId = res.GroupId!;
      recordCreated(run, 'sg', groupId);
      run.outputs.securityGroupId = groupId;
      ctx.log(`Created security group ${groupId} in ${vpc.VpcId}`);

      const { ports, dropped } = inboundPorts(run);
      if (dropped.length) ctx.log('Skipping port 22: SSH is not opened, the instance is managed via SSM');
      await authorizePorts(region, groupId, ports, '0.0.0.0/0', 'BuildDoctor');
      ctx.log(`Inbound open: ${ports.map((p) => `tcp/${p}`).join(', ')} from 0.0.0.0/0`);
      return { ok: true, summary: `Created ${groupId}`, output: { securityGroupId: groupId, ports } };
    } catch (e) {
      return { ok: false, summary: 'Security group setup failed', error: errMsg(e) };
    }
  },
};
