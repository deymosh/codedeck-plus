/**
 * OpenCode v2's own tool table: the names it emits, what each one reads as,
 * and — against what the installed version publishes — the names it must
 * have.
 */
import { describe, expect, it } from 'vitest';
import { shapeKindOf } from '../../../sdk/tools';
import { OPENCODE_TOOLS, opencodeTool } from '../tools';

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

  it('reports a name v2 no longer emits, and still reads the call by its arguments', () => {
    // `bash` was v1's shell tool, `task` its sub-agent call, `apply_patch` its
    // patch tool: v2 answers to none of them. The name is what the log is for
    // — the call itself still reads as the shell command it is.
    for (const name of ['bash', 'task', 'apply_patch', 'worktree_create']) {
      const reported: string[] = [];
      expect(opencodeTool(name, { command: 'ls' }, (n) => reported.push(n))).toEqual({
        kind: 'execute',
        title: 'ls',
      });
      expect(reported).toEqual([name]);
    }
  });

  it('leaves a name with nothing to read it by as the tool’s own name and arguments', () => {
    const reported: string[] = [];
    expect(opencodeTool('worktree_create', { name: 'feature' }, (n) => reported.push(n))).toEqual({
      kind: 'other',
      title: 'worktree_create',
      input: '{\n  "name": "feature"\n}',
    });
    expect(reported).toEqual(['worktree_create']);
  });
});

/**
 * The tools a session can call by name, recorded from the sources of the
 * version the lockfile pins (2.1.4), with the arguments each one requires:
 * `export const name` and `export const Input` in
 * `packages/core/src/tool/plugin/*.ts` at tag v2.1.4, plus the `execute`
 * tool out of `packages/codemode`.
 *
 * Every tool there is `codemode: false`, which is what puts it on the
 * provider's own tool list; everything else is reached from inside `execute`
 * and never arrives as a call of its own, so it is not a name this agent
 * emits (see this driver's tools.ts).
 *
 * The list is recorded rather than read because the sources are not in
 * `node_modules`: they compile into the `opencode` binary the installer
 * fetches on demand.
 */
const PUBLISHED: Record<string, readonly string[]> = {
  shell: ['command'],
  execute: ['code'],
  read: ['path'],
  write: ['path', 'content'],
  edit: ['path', 'oldString', 'newString'],
  patch: ['patchText'],
  glob: ['pattern'],
  grep: ['pattern'],
  webfetch: ['url'],
  websearch: ['query'],
  subagent: ['agent', 'description', 'prompt'],
  skill: ['id'],
  question: ['questions'],
  // Only while the config sets `experimental.todo`.
  todowrite: ['todos'],
};

/** The call a tool must at least be able to carry. The rest of its arguments
 *  are optional, which says what a call may have, not what it is. */
function requiredArguments(keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, 'x']));
}

/** What this agent's table says a name is, asked with no arguments at all: no
 *  pattern reads an empty call, so the name is what answers. */
const kindByTable = (name: string): string => opencodeTool(name, {}).kind;

describe('the tools the installed v2 publishes', () => {
  it('has a table entry for every one, and no name the version does not register', () => {
    expect(Object.keys(OPENCODE_TOOLS).sort()).toEqual(Object.keys(PUBLISHED).sort());
  });

  it('reads a published tool by its arguments the same way the table reads it by name', () => {
    // The classifier reads the arguments first, so where the two disagree the
    // arguments win at run time.
    const disagreements: Record<string, string> = {};
    for (const [name, required] of Object.entries(PUBLISHED)) {
      const byArguments = shapeKindOf(requiredArguments(required));
      if (byArguments !== undefined && byArguments !== kindByTable(name)) {
        disagreements[name] = `${kindByTable(name)} by name, ${byArguments} by its arguments`;
      }
    }
    expect(disagreements).toEqual({});
  });
});
