import 'aws-sdk-client-mock-vitest/extend';
import { PIPELINE, type RunConfig, type RunState } from '../../src/types.js';
import type { StepContext } from '../../src/pipeline/step.js';
import { timing } from '../../src/aws/util.js';
import { resetClients } from '../../src/aws/clients.js';

export function fastTiming(): void {
  Object.assign(timing, {
    pollMs: 0, instanceRunningMs: 50, ssmOnlineMs: 50, commandMs: 50, healthMs: 0,
    healthRequestMs: 50, terminateMs: 50, sgDeleteMs: 50, profileRetries: 4,
  });
  resetClients();
}

export function makeRun(over: Partial<RunConfig> = {}, aws: Partial<RunConfig['aws']> = {}): RunState {
  return {
    id: 'run123',
    config: {
      repoUrl: 'https://github.com/acme/My_App.git',
      appPort: 3000,
      ...over,
      aws: { region: 'ap-south-1', instanceType: 't4g.micro', openPorts: [], ...aws },
    },
    nodes: Object.fromEntries(PIPELINE.map((n) => [n, { status: 'idle', logs: [] }])) as unknown as RunState['nodes'],
    outputs: { created: [] },
    status: 'running',
    createdAt: 0,
  };
}

export function makeCtx(run: RunState): StepContext & { lines: string[] } {
  const lines: string[] = [];
  return { run, workdir: '/tmp/x', log: (l) => lines.push(l), emit: () => {}, signal: new AbortController().signal, lines };
}

export function awsErr(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}
