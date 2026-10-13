/**
 * Claude Code's own tool table: the names it emits, what each one reads as,
 * and the names it no longer emits.
 */
import { describe, expect, it } from 'vitest';
import { claudeTool } from '../tools';

describe('claudeTool', () => {
  it('reads a file tool by the path it names', () => {
    expect(claudeTool('Read', { file_path: '/a.ts' })).toEqual({ kind: 'read', title: '/a.ts' });
  });

  it('names a sub-agent by its job and its kind, under either spelling', () => {
    // `Task` is the CLI's older name for `Agent`; both arrive.
    expect(claudeTool('Task', { description: 'find things', subagent_type: 'explore', prompt: 'look' })).toEqual({
      kind: 'agent',
      title: 'find things (explore)',
      input: 'look',
    });
    expect(claudeTool('Agent', { description: 'find things', prompt: 'look' }).title).toBe('find things');
  });

  it("reads Claude Code's current name for stopping a task, and its aliases", () => {
    // The CLI's rename map turns KillShell/KillBash into TaskStop and still
    // accepts the old spellings.
    for (const name of ['TaskStop', 'KillShell', 'KillBash']) {
      expect(claudeTool(name, { task_id: 'task-7' })).toEqual({ kind: 'execute', title: 'task-7' });
    }
  });

  it('gives a tool it does not know its own name and arguments', () => {
    const reported: string[] = [];
    expect(claudeTool('SomethingNew', { a: 1 }, (name) => reported.push(name))).toEqual({
      kind: 'other',
      title: 'SomethingNew',
      input: '{\n  "a": 1\n}',
    });
    expect(reported).toEqual(['SomethingNew']);
  });
});
