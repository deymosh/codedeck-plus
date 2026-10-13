/**
 * Tool kinds: each agent's tool names, as the phone groups and labels them.
 */
import { describe, expect, it } from 'vitest';
import { toolInput, toolKindOf, toolTitle, unknownToolReporter } from '../tools';

describe('toolKindOf', () => {
  it("reads every agent's spelling of a tool", () => {
    expect(toolKindOf('Edit')).toBe('edit');
    expect(toolKindOf('patch')).toBe('edit');
    expect(toolKindOf('websearch')).toBe('fetch');
    expect(toolKindOf('something-new')).toBe('other');
  });

  it('reports a name no table lists, and only that', () => {
    // Deduplicating the repeats is the reporter's job (`unknownToolReporter`).
    const reported: string[] = [];
    const report = (name: string): void => void reported.push(name);
    expect(toolKindOf('TaskRenamed', report)).toBe('other');
    expect(toolKindOf('Edit', report)).toBe('edit');
    expect(toolKindOf('something-new', report)).toBe('other');
    expect(reported).toEqual(['TaskRenamed', 'something-new']);
  });

  it("reads Claude Code's current name for stopping a task", () => {
    // The CLI renames KillShell/KillBash to TaskStop and still accepts the
    // old spellings as aliases.
    expect(toolKindOf('TaskStop')).toBe('execute');
    expect(toolKindOf('KillShell')).toBe('execute');
  });

  it("reads OpenCode v2's names for tools the others spell differently", () => {
    // `bash` and `task` became `shell` and `subagent`.
    expect(toolKindOf('shell')).toBe('execute');
    expect(toolKindOf('subagent')).toBe('agent');
  });
});

describe('unknownToolReporter', () => {
  it('logs a name once per session, whatever its spelling', () => {
    const lines: string[] = [];
    const report = unknownToolReporter((message) => lines.push(message));
    report('TaskRenamed');
    report('taskrenamed');
    report('TaskRenamed');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('TaskRenamed');
  });

  it('leaves an MCP server’s own tool names alone', () => {
    // The server names its tools; no table here can list them, so their
    // names are not news.
    const lines: string[] = [];
    const report = unknownToolReporter((message) => lines.push(message));
    report('mcp__github__create_issue');
    report('mcp__filesystem__read_file');
    expect(lines).toEqual([]);
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

  it('names the background task a stop refers to', () => {
    expect(toolTitle('TaskStop', { task_id: 'task-7' })).toBe('task-7');
    expect(toolTitle('TaskStop', { shell_id: 'sh-2' })).toBe('sh-2');
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
