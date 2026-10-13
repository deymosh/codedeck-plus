/**
 * The DeepSeek Harness's own tool table: the names its `acp` profile mounts,
 * what each one reads as, and the names it has no tool for.
 */
import { describe, expect, it } from 'vitest';
import { deepseekTool } from '../tools';

describe('deepseekTool', () => {
  it('reads the shell tool of whichever host this is', () => {
    // `bash` everywhere but Windows, `pwsh` there.
    expect(deepseekTool('bash', { command: 'npm test' })).toEqual({ kind: 'execute', title: 'npm test' });
    // A run shows the command itself, whole: its other arguments (the working
    // directory, a timeout) are not what the row is about.
    const command = `node -e "${'x'.repeat(300)}"`;
    expect(deepseekTool('pwsh', { command, workdir: '/w' })).toEqual({
      kind: 'execute',
      title: `${command.slice(0, 200)}…`,
      input: command,
    });
  });

  it("reads the harness's editor by the operation it was given", () => {
    expect(deepseekTool('str_replace_editor', { command: 'view', path: '/a.ts' })).toEqual({
      kind: 'edit',
      title: 'view /a.ts',
    });
  });

  it('names a sub-agent by what it was asked to do', () => {
    // The sub-agent call's own name comes from the profile's configuration
    // (`toolName: subagent`), not from the plugin.
    expect(deepseekTool('subagent', { description: 'find things', prompt: 'look' })).toEqual({
      kind: 'agent',
      title: 'find things',
      input: 'look',
    });
    expect(deepseekTool('subagent_fork', { description: 'find things', prompt: 'look' }).kind).toBe('agent');
  });

  it('gives a tool this profile mounts no longer its own name and arguments', () => {
    // `agent` and `list` were never dsh tools; the harness's own names are
    // `subagent` and the job tools.
    const reported: string[] = [];
    expect(deepseekTool('agent', {}, (name) => reported.push(name))).toEqual({ kind: 'other', title: 'agent' });
    expect(reported).toEqual(['agent']);
  });
});
