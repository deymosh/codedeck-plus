/**
 * Background shells: the session's own shell is the default, a real command
 * runs to its end in it with its output kept, and a shell the machine does
 * not have says which one to use instead. The command runs for real, in
 * PowerShell on Windows and in sh elsewhere — the two syntaxes a session's
 * shell tool speaks.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { backgroundShell, registerBackground, type ShellConfig, type TaskEvent } from '../extension/background';

type Execute = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: undefined,
  ctx: { cwd: string },
) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;

function harness(shells: Record<'bash' | 'powershell', () => ShellConfig>, active: string[]) {
  const tools = new Map<string, Execute>();
  const events: TaskEvent[] = [];
  registerBackground(
    { registerTool: ((tool: { name: string; execute: Execute }) => tools.set(tool.name, tool.execute)) as never },
    { shells, active: () => active, report: (event) => events.push(event) },
  );
  const cwd = mkdtempSync(path.join(tmpdir(), 'codedeck-pi-bg-'));
  const run = (name: string, params: Record<string, unknown>) => tools.get(name)!('call_1', params, undefined, undefined, { cwd });
  return { run, events };
}

const missing = (): ShellConfig => {
  throw new Error('not on this machine');
};

describe('backgroundShell', () => {
  it("defaults to the session's own shell, and takes the one asked for", () => {
    expect(backgroundShell(undefined, ['read', 'bash', 'powershell'])).toBe('bash');
    expect(backgroundShell(undefined, ['read', 'powershell'])).toBe('powershell');
    expect(backgroundShell(undefined, ['read'])).toBe('bash');
    expect(backgroundShell('powershell', ['bash'])).toBe('powershell');
    expect(backgroundShell('zsh', ['powershell'])).toBe('powershell');
  });
});

describe('a background shell', () => {
  const windows = process.platform === 'win32';
  // The shell this machine runs a session's commands in, as Pi resolves it.
  const real: ShellConfig = windows
    ? { shell: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'] }
    : { shell: '/bin/sh', args: ['-c'] };
  const command = windows ? 'Write-Output codedeck-bg; Write-Output done' : 'echo codedeck-bg; echo done';

  it(`runs to its end in ${windows ? 'PowerShell' : 'sh'}, reporting its start and end and keeping its output`, async () => {
    const shells = windows ? { bash: missing, powershell: () => real } : { bash: () => real, powershell: missing };
    const { run, events } = harness(shells, windows ? ['read', 'powershell'] : ['read', 'bash']);
    const started = await run('bash_background', { command, description: 'Print twice' });
    const taskId = String(started.details.taskId);
    expect(events[0]).toMatchObject({ kind: 'task', taskId, status: 'running', title: 'Print twice', callId: 'call_1' });

    const output = await run('task_output', { id: taskId, wait: 60 });
    expect(output.content[0]!.text).toContain('codedeck-bg');
    expect(output.content[0]!.text).toContain('exited with code 0');
    expect(events.at(-1)).toMatchObject({ taskId, status: 'completed', summary: 'Exited with code 0' });
  }, 60_000);

  it('says which shell to use when the one it would use is not there', async () => {
    const { run, events } = harness({ bash: missing, powershell: () => real }, ['read', 'bash']);
    await expect(run('bash_background', { command })).rejects.toThrow(/bash is not available here.*shell: "powershell"/);
    expect(events).toHaveLength(0);
  });
});
