import { GetCommandInvocationCommand, SendCommandCommand } from '@aws-sdk/client-ssm';
import { clients } from './clients.js';
import { errName, poll, timing } from './util.js';

export interface CommandResult {
  status: string;     // Success | Failed | TimedOut | Cancelled ...
  exitCode: number;
  stdout: string;
  stderr: string;
}

const DONE = new Set(['Success', 'Failed', 'TimedOut', 'Cancelled', 'Cancelling']);

// Runs a shell script on the instance via AWS-RunShellScript and streams new output lines.
// Note: SSM keeps command parameters in its history, so scripts must never embed secret values.
export async function runShell(
  region: string,
  instanceId: string,
  script: string,
  opts: { comment?: string; log?: (l: string) => void; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<CommandResult> {
  const { ssm } = clients(region);
  const timeoutMs = opts.timeoutMs ?? timing.commandMs;
  const sent = await ssm.send(new SendCommandCommand({
    InstanceIds: [instanceId],
    DocumentName: 'AWS-RunShellScript',
    Comment: (opts.comment ?? 'BuildDoctor').slice(0, 100),
    TimeoutSeconds: Math.max(30, Math.ceil(timeoutMs / 1000)),
    Parameters: { commands: [script], executionTimeout: [String(Math.max(60, Math.ceil(timeoutMs / 1000)))] },
  }));
  const commandId = sent.Command!.CommandId!;
  const seen = { out: 0, err: 0 };
  const stream = (text: string, key: 'out' | 'err', prefix: string) => {
    if (!opts.log || text.length <= seen[key]) return;
    const fresh = text.slice(seen[key]);
    const lastNl = fresh.lastIndexOf('\n');
    if (lastNl < 0) return; // wait for a complete line
    for (const l of fresh.slice(0, lastNl).split('\n')) if (l.trim()) opts.log(prefix + l);
    seen[key] += lastNl + 1;
  };

  const inv = await poll(async () => {
    let res;
    try {
      res = await ssm.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }));
    } catch (e) {
      if (errName(e) === 'InvocationDoesNotExist') return undefined; // not registered yet
      throw e;
    }
    stream(res.StandardOutputContent ?? '', 'out', '');
    stream(res.StandardErrorContent ?? '', 'err', '[stderr] ');
    return DONE.has(res.Status ?? '') ? res : undefined;
  }, { timeoutMs: timeoutMs + 60_000, what: `SSM command ${commandId}`, signal: opts.signal });

  const stdout = inv.StandardOutputContent ?? '';
  const stderr = inv.StandardErrorContent ?? '';
  // Flush trailing partial lines.
  if (opts.log) {
    for (const [text, key, prefix] of [[stdout, 'out', ''], [stderr, 'err', '[stderr] ']] as const) {
      const rest = text.slice(seen[key]).trim();
      if (rest) for (const l of rest.split('\n')) opts.log(prefix + l);
    }
  }
  return { status: inv.Status ?? 'Unknown', exitCode: inv.ResponseCode ?? -1, stdout, stderr };
}
