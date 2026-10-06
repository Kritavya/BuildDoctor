// Shared contract between the pipeline engine, the steps, the HTTP API and the web UI.
// The web app imports this file directly (see web/src/api.ts) — keep it free of Node imports.

export type NodeId =
  | 'clone'
  | 'analyze'
  | 'dockerfile'
  | 'lint'
  | 'build'
  | 'smoke'
  | 'approve'
  | 'ecr'
  | 'securityGroup'
  | 'ec2'
  | 'deploy'
  | 'health'
  | 'dashboard';

export const PIPELINE: NodeId[] = [
  'clone', 'analyze', 'dockerfile', 'lint', 'build', 'smoke',
  'approve', 'ecr', 'securityGroup', 'ec2', 'deploy', 'health', 'dashboard',
];

// Edges the doctor loop can send execution back along (drawn as dashed retry edges in the UI).
export const RETRY_EDGES: Array<[from: NodeId, to: NodeId]> = [
  ['lint', 'dockerfile'],
  ['build', 'dockerfile'],
  ['smoke', 'dockerfile'],
  ['health', 'deploy'],
];

export type NodeStatus = 'idle' | 'running' | 'success' | 'failed' | 'waiting' | 'skipped';

// Graviton (arm64): images built natively on Apple Silicon run as-is, no cross-compile.
export type InstanceSize = 't4g.micro' | 't4g.small' | 't4g.medium';

export interface RunConfig {
  repoUrl: string;
  branch?: string;              // default: repo default branch
  appPort?: number;             // override detected port
  env?: Record<string, string>; // passed to container; values never logged or sent to the LLM
  aws: {
    region: string;             // e.g. ap-south-1
    instanceType: InstanceSize;
    openPorts: number[];        // inbound ports opened to 0.0.0.0/0 (app port is always added)
    existingInstanceId?: string;
    existingSecurityGroupId?: string;
  };
  maxFixAttempts?: number;      // doctor loop retries, default 3
}

// Runtime-config change the doctor loop may apply before a retry. Whitelisted: only the container
// port can be remapped. Env values are never patched; a missing env var fails with "please provide X".
export interface ConfigPatch {
  appPort?: number;
}

export interface AnalysisResult {
  runtime: 'node' | 'python' | 'go' | 'unknown';
  framework?: string;           // express, next, fastapi, django, flask...
  entryCommand?: string;        // npm start, uvicorn main:app ...
  port?: number;
  envVars: string[];            // names only
  dependencyFiles: string[];
  dockerfile: 'missing' | 'present';
}

// Root-cause report format from the concept doc (§11).
export interface Diagnosis {
  rootCause: string;
  evidence: string;
  attemptedFix: string;
  result: 'fixed' | 'not-fixed';
  nextStep?: string;
}

export interface ApprovalRequest {
  actions: string[]; // human readable: "Create EC2 instance t3.micro in ap-south-1"
}

export interface DeployOutputs {
  ecrRepoUri?: string;
  imageUri?: string;
  securityGroupId?: string;
  instanceId?: string;
  publicIp?: string;
  appUrl?: string;
  dashboard?: { enabled: boolean; metricsUrl?: string; logsUrl?: string };
  // sg-rule id: <groupId>:<port>:<cidr>, an ingress rule we added to a pre-existing security group.
  created: Array<{ type: 'ecr' | 'sg' | 'sg-rule' | 'ec2' | 'iam-role' | 'instance-profile'; id: string }>; // for teardown
}

// Server -> UI over SSE at GET /api/runs/:id/events
export type RunEvent =
  | { type: 'node'; node: NodeId; status: NodeStatus; summary?: string; attempt?: number }
  | { type: 'log'; node: NodeId; line: string; ts: number }
  | { type: 'output'; node: NodeId; data: unknown }          // shown in the node's side panel
  | { type: 'retry'; from: NodeId; to: NodeId; attempt: number; diagnosis: Diagnosis; patch?: ConfigPatch }
  | { type: 'approval'; request: ApprovalRequest }           // pipeline pauses at 'approve'
  | { type: 'done'; status: 'live' | 'failed'; appUrl?: string; diagnosis?: Diagnosis };

export interface RunState {
  id: string;
  config: RunConfig;
  nodes: Record<NodeId, { status: NodeStatus; summary?: string; attempt?: number; output?: unknown; logs: string[] }>;
  analysis?: AnalysisResult;
  dockerfile?: string;
  outputs: DeployOutputs;
  status: 'running' | 'awaiting-approval' | 'live' | 'failed' | 'torn-down';
  createdAt: number;
}

// HTTP API (server on :4000, web proxies /api):
//   POST /api/runs                      body RunConfig        -> { id }
//   GET  /api/runs/:id                                         -> RunState
//   GET  /api/runs/:id/events           SSE of RunEvent (replays history first)
//   POST /api/runs/:id/approve          body { approved: boolean }
//   POST /api/runs/:id/dashboard        body { enabled: boolean } -> DeployOutputs['dashboard']
//   POST /api/runs/:id/teardown                                -> { deleted: string[] }
//   GET  /api/health/local                                     -> { docker, ollama, model, awsAccount?, awsPermissions?: { ok, missing[] } }
