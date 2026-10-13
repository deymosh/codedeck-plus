/**
 * OpenCode v2's own tool table: the names it emits, what each one reads as,
 * and the names it does not emit at all.
 */
import { describe, expect, it } from 'vitest';
import { opencodeTool } from '../tools';

describe('opencodeTool', () => {
  it('names a file by the key v2 uses for it', () => {
    // v2 spells the path `path`; a title of the tool's own name — which is
    // what an unknown key fell back to before — left a `read` card reading
    // "read read".
    expect(opencodeTool('read', { path: '/a.ts' })).toEqual({ kind: 'read', title: '/a.ts' });
    expect(opencodeTool('edit', { path: '/a.ts', oldString: 'a', newString: 'b' })).toEqual({
      kind: 'edit',
      title: '/a.ts',
    });
  });

  it('sends a long shell command as the call’s own input', () => {
    const command = `git commit -m "${'x'.repeat(300)}"`;
    expect(opencodeTool('shell', { command })).toEqual({ kind: 'execute', title: `${command.slice(0, 200)}…`, input: command });
  });

  it('names the sub-agent and the agent it runs as', () => {
    expect(opencodeTool('subagent', { description: 'find things', agent: 'explore', prompt: 'look' })).toEqual({
      kind: 'agent',
      title: 'find things (explore)',
      input: 'look',
    });
  });

  it('gives a name v2 no longer emits its own name and arguments', () => {
    // `bash` was v1's shell tool, `task` its sub-agent call, `apply_patch` its
    // patch tool: v2 answers to none of them, so none is a row's label.
    for (const name of ['bash', 'task', 'apply_patch', 'worktree_create']) {
      const reported: string[] = [];
      expect(opencodeTool(name, { command: 'ls' }, (n) => reported.push(n))).toEqual({
        kind: 'other',
        title: name,
        input: '{\n  "command": "ls"\n}',
      });
      expect(reported).toEqual([name]);
    }
  });
});
