/**
 * The agent-neutral reading of a tool call: what a driver gets for the kind,
 * the title and the input a call travels with, and what happens to a name the
 * driver's own table does not list.
 *
 * Each agent's own names are tested beside it (`drivers/<agent>/__tests__`).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readToolCall, shapeKindOf, str, ToolKind, toolLocations, todosOf, unknownToolReporter, type ToolDialects } from '../tools';

/** A driver's table, standing in for one of the real ones. */
const TOOLS: ToolDialects = {
  run: { kind: ToolKind.Execute, title: (input) => str(input.command), detail: (input) => String(input.command) },
  look: { kind: ToolKind.Read, title: (input) => str(input.path) },
  stop: { kind: ToolKind.Execute, title: (input) => str(input.task_id) },
  change: { kind: ToolKind.Edit, title: (input) => str(input.path), detail: () => undefined },
  ask: { kind: ToolKind.Think },
};

const read = (name: string, input: Record<string, unknown>, report?: (name: string) => void) =>
  readToolCall(TOOLS, name, input, report);

describe('readToolCall', () => {
  it("reads a name the table lists, case-insensitively, as the agent spells it", () => {
    // The command is the title in full, so no second copy travels as input.
    expect(read('Run', { command: 'npm test' })).toEqual({ kind: 'execute', title: 'npm test' });
    const script = "python3 - <<'EOF'\nprint(1)\nEOF";
    expect(read('Run', { command: script })).toEqual({ kind: 'execute', title: "python3 - <<'EOF'…", input: script });
  });

  it('falls back to the tool’s own name when the call has nothing to title it with', () => {
    expect(read('ask', { questions: [] })).toEqual({ kind: 'think', title: 'ask' });
  });

  it('shows a call’s arguments as JSON when they say more than the title', () => {
    // `stop` names no kind of argument of its own, so its entry answers and
    // its title comes from there too.
    expect(read('stop', { task_id: 'task-7', force: true })).toEqual({
      kind: 'execute',
      title: 'task-7',
      input: '{\n  "task_id": "task-7",\n  "force": true\n}',
    });
  });

  it('reads the kind from the arguments even when the table knows the name', () => {
    // `change` is this table's edit tool, and a call whose arguments name a
    // pattern is a search — the arguments are what a rename leaves intact.
    expect(read('change', { pattern: 'TODO' })).toEqual({ kind: 'search', title: 'TODO' });
  });

  it('lets a tool say its input is not worth showing', () => {
    // A file change: its diff entry already carries the content.
    expect(read('change', { path: '/a.ts', oldString: 'a', newString: 'b' })).toEqual({
      kind: 'edit',
      title: '/a.ts',
    });
  });

  it('reads an unknown name by its arguments, which is what a rename leaves intact', () => {
    // A tool the agent renamed away still runs the same way: the call's
    // arguments are read even though its name means nothing here.
    expect(read('mystery', { command: 'rm -rf /' })).toEqual({ kind: 'execute', title: 'rm -rf /' });
  });

  it('gives an unknown name and arguments that say nothing the call itself, never a guess', () => {
    // The kind is what the phone picks an icon and a verb from: a wrong guess
    // would read as a confident lie about what the call did.
    expect(read('mystery', { opaque: true })).toEqual({
      kind: 'other',
      title: 'mystery',
      input: '{\n  "opaque": true\n}',
    });
    // Even one argument travels: the title is the tool's name, not the value.
    expect(read('mcp__gh__issue', { n: 1 }).input).toBe('{\n  "n": 1\n}');
    expect(read('mystery', {}).input).toBeUndefined();
  });

  it('reports an unknown name, which is how a rename stops being silent', () => {
    const reported: string[] = [];
    read('mystery', {}, (name) => reported.push(name));
    read('look', {}, (name) => reported.push(name));
    expect(reported).toEqual(['mystery']);
  });

  it('caps the input it hands over', () => {
    const call = read('mystery', { blob: 'x'.repeat(5000) });
    expect(call.input).toHaveLength(4001);
    expect(call.input?.endsWith('…')).toBe(true);
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

describe('toolLocations', () => {
  it('names the file under whichever key the agent uses for it', () => {
    // Claude Code and the DeepSeek Harness say `file_path`; OpenCode v2 says
    // `path`, and a notebook has a path of its own.
    expect(toolLocations({ file_path: '/a.ts' })).toEqual(['/a.ts']);
    expect(toolLocations({ filePath: '/b.ts' })).toEqual(['/b.ts']);
    expect(toolLocations({ path: '/c.ts' })).toEqual(['/c.ts']);
    expect(toolLocations({ notebook_path: '/d.ipynb' })).toEqual(['/d.ipynb']);
    expect(toolLocations({ command: 'ls' })).toEqual([]);
  });
});

describe('ToolKind', () => {
  it('names every kind the wire has, and no other', () => {
    // The generated protocol is the wire's own word on it: a kind added there
    // fails here until it is named above, and a name that is not a kind fails
    // the `satisfies` in tools.ts.
    const generated = readFileSync(new URL('../../generated/protocol.ts', import.meta.url), 'utf8');
    const at = generated.indexOf('export type ToolKind =');
    expect(at).toBeGreaterThan(-1);
    const union = generated.slice(at, generated.indexOf(';', at));
    const kinds = [...union.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]!);
    expect(kinds.length).toBeGreaterThan(5);
    expect([...Object.values(ToolKind)].sort()).toEqual([...kinds].sort());
  });
});

describe('shapeKindOf', () => {
  it('reads what a call does from the arguments every agent shares', () => {
    expect(shapeKindOf({ command: 'npm test' })).toBe('execute');
    expect(shapeKindOf({ code: 'await tools.read({path: "/a"})' })).toBe('execute');
    expect(shapeKindOf({ url: 'https://example.com' })).toBe('fetch');
    expect(shapeKindOf({ query: 'nostr relays' })).toBe('fetch');
    expect(shapeKindOf({ queries: ['nostr relays'] })).toBe('fetch');
    expect(shapeKindOf({ pattern: 'src/**/*.ts' })).toBe('search');
    expect(shapeKindOf({ file_path: '/a.ts', old_string: 'a', new_string: 'b' })).toBe('edit');
    expect(shapeKindOf({ path: '/a.ts', content: 'x' })).toBe('edit');
    expect(shapeKindOf({ path: '/a.ts' })).toBe('read');
    expect(shapeKindOf({ notebook_path: '/a.ipynb', new_source: 'x' })).toBe('edit');
    expect(shapeKindOf({ todos: [{ content: 'x' }] })).toBe('think');
  });

  it('reads a sub-agent hand-off from its instructions', () => {
    expect(shapeKindOf({ description: 'find things', prompt: 'look' })).toBe('agent');
    expect(shapeKindOf({ agent: 'explore', description: 'find things', prompt: 'look' })).toBe('agent');
    expect(shapeKindOf({ subagent_type: 'explore', description: 'find things', prompt: 'look' })).toBe('agent');
    // A prompt alone is a prompt: WebFetch carries one too.
    expect(shapeKindOf({ url: 'https://example.com', prompt: 'summarize' })).toBe('fetch');
  });

  it('reads a file before it reads a bare key, so an operation word is not a command', () => {
    // The harness's editor spells its operation `command`, and takes a path:
    // `view` reads, and putting text in the file edits.
    expect(shapeKindOf({ command: 'view', path: '/a.ts' })).toBe('read');
    expect(shapeKindOf({ command: 'str_replace', path: '/a.ts', old_str: 'a', new_str: 'b' })).toBe('edit');
    // A search names its pattern and the tree to search.
    expect(shapeKindOf({ pattern: 'TODO', path: '/src' })).toBe('search');
  });

  it('says nothing when the arguments do not', () => {
    // An empty call, an argument nobody reads, and the shapes that are a
    // tool's own business: the agent's table answers for these.
    expect(shapeKindOf({})).toBeUndefined();
    expect(shapeKindOf({ task_id: 'task-7' })).toBeUndefined();
    expect(shapeKindOf({ questions: [{ question: 'which?' }] })).toBeUndefined();
    expect(shapeKindOf({ todos: 'not an array' })).toBeUndefined();
    expect(shapeKindOf({ command: '' })).toBeUndefined();
  });
});

describe('todosOf', () => {
  it('reads a checklist, counting an unknown status as pending', () => {
    expect(todosOf({ todos: [{ content: 'fix it', status: 'in_progress' }, { content: 'ship it' }] })).toEqual([
      { text: 'fix it', status: 'in_progress' },
      { text: 'ship it', status: 'pending' },
    ]);
    expect(todosOf({ command: 'ls' })).toBeNull();
  });
});
