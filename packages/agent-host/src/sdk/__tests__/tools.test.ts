/**
 * The agent-neutral reading of a tool call: what a driver gets for the kind,
 * the title and the input a call travels with, and what happens to a name the
 * driver's own table does not list.
 *
 * Each agent's own names are tested beside it (`drivers/<agent>/__tests__`).
 */
import { describe, expect, it } from 'vitest';
import { readToolCall, ToolKind, toolLocations, todosOf, unknownToolReporter, type ToolDialects } from '../tools';

/** A driver's table, standing in for one of the real ones. */
const TOOLS: ToolDialects = {
  run: { kind: ToolKind.Execute, title: (input) => String(input.command), detail: (input) => String(input.command) },
  look: { kind: ToolKind.Read, title: (input) => String(input.path) },
  stop: { kind: ToolKind.Execute, title: (input) => String(input.task_id) },
  change: { kind: ToolKind.Edit, title: (input) => String(input.path), detail: () => undefined },
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
    expect(read('stop', { task_id: 'task-7', force: true })).toEqual({
      kind: 'execute',
      title: 'task-7',
      input: '{\n  "task_id": "task-7",\n  "force": true\n}',
    });
  });

  it('lets a tool say its input is not worth showing', () => {
    // A file change: its diff entry already carries the content.
    expect(read('change', { path: '/a.ts', oldString: 'a', newString: 'b' })).toEqual({
      kind: 'edit',
      title: '/a.ts',
    });
  });

  it('gives an unknown name its own name and arguments, never a guess', () => {
    // The kind is what the phone picks an icon and a verb from: a wrong guess
    // would read as a confident lie about what the call did.
    expect(read('mystery', { command: 'rm -rf /' })).toEqual({
      kind: 'other',
      title: 'mystery',
      input: '{\n  "command": "rm -rf /"\n}',
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

describe('todosOf', () => {
  it('reads a checklist, counting an unknown status as pending', () => {
    expect(todosOf({ todos: [{ content: 'fix it', status: 'in_progress' }, { content: 'ship it' }] })).toEqual([
      { text: 'fix it', status: 'in_progress' },
      { text: 'ship it', status: 'pending' },
    ]);
    expect(todosOf({ command: 'ls' })).toBeNull();
  });
});
