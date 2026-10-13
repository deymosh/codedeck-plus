/**
 * Tool kinds: each agent's tool names, as the phone groups and labels them.
 */
import { describe, expect, it } from 'vitest';
import { toolKindOf, toolTitle } from '../tools';

describe('toolKindOf', () => {
  it("reads every agent's spelling of a tool", () => {
    expect(toolKindOf('Edit')).toBe('edit');
    expect(toolKindOf('apply_patch')).toBe('edit');
    expect(toolKindOf('patch')).toBe('edit');
    expect(toolKindOf('lsp')).toBe('read');
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
