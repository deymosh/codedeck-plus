/**
 * Tool kinds: each agent's tool names, as the phone groups and labels them.
 */
import { describe, expect, it } from 'vitest';
import { toolInput, toolKindOf, toolTitle } from '../tools';

describe('toolKindOf', () => {
  it("reads every agent's spelling of a tool", () => {
    expect(toolKindOf('Edit')).toBe('edit');
    expect(toolKindOf('patch')).toBe('edit');
    expect(toolKindOf('websearch')).toBe('fetch');
    expect(toolKindOf('something-new')).toBe('other');
  });

  it("reads OpenCode v2's names for tools the others spell differently", () => {
    // `bash` and `task` became `shell` and `subagent`.
    expect(toolKindOf('shell')).toBe('execute');
    expect(toolKindOf('subagent')).toBe('agent');
  });
});

describe('toolTitle', () => {
  it('names the sub-agent and what it was asked to do, under either spelling', () => {
    // Claude Code and OpenCode v1 name the sub-agent `subagent_type`;
    // OpenCode v2 names it `agent`.
    expect(toolTitle('task', { description: 'find things', subagent_type: 'explore' })).toBe('find things (explore)');
    expect(toolTitle('subagent', { description: 'find things', agent: 'explore' })).toBe('find things (explore)');
    expect(toolTitle('subagent', { description: 'find things' })).toBe('find things');
  });

  it('names a file by whichever key the agent uses for it', () => {
    expect(toolTitle('edit', { filePath: '/a.ts' })).toBe('/a.ts');
    expect(toolTitle('edit', { path: '/b.ts' })).toBe('/b.ts');
  });

  it('shows a shell command under either spelling', () => {
    expect(toolTitle('bash', { command: 'ls -la' })).toBe('ls -la');
    expect(toolTitle('shell', { command: 'ls -la' })).toBe('ls -la');
  });
});

describe('toolInput', () => {
  it('gives the whole command, under either spelling, never the one-line title', () => {
    // The title is cut to 200 chars, so a long command has to come from here.
    const command = `git commit -m "${'x'.repeat(300)}"`;
    expect(toolInput('bash', { command })).toBe(command);
    expect(toolInput('shell', { command })).toBe(command);
  });

  it('gives a sub-agent its instructions, under either spelling', () => {
    expect(toolInput('task', { prompt: 'find the bug', description: 'look' })).toBe('find the bug');
    expect(toolInput('subagent', { prompt: 'find the bug', description: 'look', agent: 'explore' })).toBe('find the bug');
  });

  it('gives the program a Code Mode call runs', () => {
    // Long enough that the one-line title cannot be the whole answer.
    const code = 'const hits = await tools.grep({ pattern: "x" }); return hits.slice(0, 10); '
      + 'work(); '.repeat(40);
    expect(toolInput('execute', { code })).toBe(code);
  });

  it('says nothing extra when the title already is the whole input', () => {
    // A short command is its own title, so the sheet needs no second copy.
    expect(toolInput('shell', { command: 'ls' })).toBeUndefined();
  });

  it('leaves a tool whose title already says it all without an input', () => {
    // A lone argument is the title: a path, a pattern, a URL.
    expect(toolInput('read', { path: '/a.ts' })).toBeUndefined();
    expect(toolInput('webfetch', { url: 'https://x' })).toBeUndefined();
    // A file-changing call shows its diff instead.
    expect(toolInput('edit', { path: '/a.ts', oldString: 'a', newString: 'b' })).toBeUndefined();
  });
});
