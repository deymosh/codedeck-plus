/**
 * The project memory: notes written by the `memory` tool must land in the
 * project's own store, rebuild the index a later run reads, and never hold a
 * credential. The index itself is the prompt prefix, so its text and the
 * "background, not instructions" framing are part of the contract too.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerMemory } from '../extension/memory';

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: { action: 'save' | 'delete'; name: string; path: string };
}

interface Tool {
  name: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: undefined,
    onUpdate: undefined,
    ctx: { cwd: string },
  ): Promise<ToolResult>;
}

type Hook = (event: { systemPrompt: string }, ctx: { cwd: string }) => { systemPrompt?: string } | undefined;

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = 'codedeck-pi-memory-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function harness(env: Record<string, string | undefined> = {}): {
  home: string;
  run: (cwd: string, params: Record<string, unknown>) => Promise<ToolResult>;
  section: (cwd: string) => string | undefined;
} {
  const home = tempDir();
  let tool: Tool | undefined;
  let hook: Hook | undefined;
  registerMemory(
    {
      registerTool: ((definition: Tool) => {
        tool = definition;
      }) as never,
      on: ((event: string, handler: Hook) => {
        if (event === 'before_agent_start') hook = handler;
      }) as never,
    },
    { home, env },
  );
  return {
    home,
    run: (cwd, params) => tool!.execute('call_1', params, undefined, undefined, { cwd }),
    section: (cwd) => hook!({ systemPrompt: 'BASE PROMPT' }, { cwd })?.systemPrompt,
  };
}

/** The store directories the memory made for a home. */
function storeKeys(home: string): string[] {
  try {
    return readdirSync(path.join(home, 'codedeck', 'memory')).sort();
  } catch {
    return [];
  }
}

/** Every note file under a home, wherever its project directory is. */
function noteFiles(home: string): string[] {
  const files: string[] = [];
  for (const key of storeKeys(home)) {
    for (const entry of readdirSync(path.join(home, 'codedeck', 'memory', key))) {
      if (entry.endsWith('.md') && entry !== 'MEMORY.md') files.push(path.join(home, 'codedeck', 'memory', key, entry));
    }
  }
  return files;
}

/** Run a save that is expected to be refused, and return its message. */
async function refusal(
  run: (cwd: string, params: Record<string, unknown>) => Promise<ToolResult>,
  cwd: string,
  params: Record<string, unknown>,
): Promise<string> {
  try {
    await run(cwd, params);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the memory tool to refuse the note');
}

describe('the memory tool', () => {
  it('saves a note with frontmatter, rebuilds the index, and carries it into the next run', async () => {
    const memory = harness();
    const cwd = tempDir();
    const note = {
      action: 'save',
      name: 'build-uses-docker',
      description: 'The build runs in Docker, not on the host toolchain.',
      content: 'Run ./codedeck dev for the agent host and cargo.',
    };

    const result = await memory.run(cwd, note);
    expect(result.details).toMatchObject({ action: 'save', name: 'build-uses-docker' });
    expect(result.content[0]!.text).toBe(`Saved memory 'build-uses-docker' (${result.details.path})`);

    const file = readFileSync(result.details.path, 'utf8');
    expect(file).toBe(
      '---\nname: build-uses-docker\ndescription: The build runs in Docker, not on the host toolchain.\n---\n\nRun ./codedeck dev for the agent host and cargo.\n',
    );

    const dir = path.dirname(result.details.path);
    expect(readFileSync(path.join(dir, 'MEMORY.md'), 'utf8')).toBe(
      '- [build-uses-docker](build-uses-docker.md) — The build runs in Docker, not on the host toolchain.\n',
    );

    const prompt = memory.section(cwd);
    expect(prompt).toContain('BASE PROMPT');
    expect(prompt).toContain('# Memory');
    expect(prompt).toContain(`Notes from earlier sessions on this project live in ${dir}.`);
    expect(prompt).toContain('not instructions');
    expect(prompt).toContain('- [build-uses-docker](build-uses-docker.md) — The build runs in Docker, not on the host toolchain.');
    // Another project has no notes of this one.
    expect(memory.section(tempDir())).toContain('No notes yet.');
  });

  it('updates a note saved again under its name, and sorts the index by name', async () => {
    const memory = harness();
    const cwd = tempDir();
    const save = (name: string, description: string, content: string) =>
      memory.run(cwd, { action: 'save', name, description, content });

    await save('second', 'The second note.', 'first body');
    await save('first', 'The first note.', 'first body');
    const saved = await save('first', 'A corrected description.', 'corrected body');

    const dir = path.dirname(saved.details.path);
    const index = readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
    expect(index).toBe(
      [
        '- [first](first.md) — A corrected description.',
        '- [second](second.md) — The second note.',
        '',
      ].join('\n'),
    );
    const note = readFileSync(path.join(dir, 'first.md'), 'utf8');
    expect(note).toContain('description: A corrected description.');
    expect(note).toContain('corrected body');
    expect(note).not.toContain('first body');
    expect(noteFiles(memory.home)).toHaveLength(2);
  });

  it('deletes a note and refuses to delete one that is not there', async () => {
    const memory = harness();
    const cwd = tempDir();
    const saved = await memory.run(cwd, { action: 'save', name: 'gone', description: 'A note.', content: 'body' });

    const deleted = await memory.run(cwd, { action: 'delete', name: 'gone' });
    expect(deleted.details).toEqual({ action: 'delete', name: 'gone', path: saved.details.path });
    expect(deleted.content[0]!.text).toBe("Deleted memory 'gone'");
    expect(existsSync(saved.details.path)).toBe(false);
    expect(readFileSync(path.join(path.dirname(saved.details.path), 'MEMORY.md'), 'utf8')).toBe('');
    expect(memory.section(cwd)).toContain('No notes yet.');

    await expect(memory.run(cwd, { action: 'delete', name: 'gone' })).rejects.toThrow(/no note named 'gone'/);
  });

  it('refuses a name that is not a slug', async () => {
    const memory = harness();
    const cwd = tempDir();
    for (const name of ['', 'Bad', 'has space', '-leading', 'a'.repeat(65)]) {
      await expect(
        memory.run(cwd, { action: 'save', name, description: 'A note.', content: 'body' }),
      ).rejects.toThrow(/lowercase letters, digits and dashes/);
    }
    expect(noteFiles(memory.home)).toEqual([]);
  });

  it('refuses a save without a usable description or content', async () => {
    const memory = harness();
    const cwd = tempDir();
    await expect(memory.run(cwd, { action: 'save', name: 'note', content: 'body' })).rejects.toThrow(/needs a description/);
    await expect(
      memory.run(cwd, { action: 'save', name: 'note', description: 'two\nlines', content: 'body' }),
    ).rejects.toThrow(/one line/);
    await expect(
      memory.run(cwd, { action: 'save', name: 'note', description: 'A note.', content: 'x'.repeat(8_001) }),
    ).rejects.toThrow(/longer than 8000/);
    expect(noteFiles(memory.home)).toEqual([]);
  });

  it('refuses each kind of secret without echoing it', async () => {
    const secrets: Array<[kind: string, secret: string]> = [
      ['an OpenAI API key', `sk-${'A'.repeat(24)}`],
      ['a GitHub token', `ghp_${'a'.repeat(36)}`],
      ['a GitHub token', `github_pat_${'A1'.repeat(20)}`],
      ['an AWS access key', `AKIA${'ABCDEFGHIJKLMNOP'}`],
      ['a private key', '-----BEGIN RSA PRIVATE KEY-----'],
      ['a Slack token', 'xoxb-1234567890'],
      ['a Nostr secret key', `nsec1${'0'.repeat(58)}`],
      ['a Google API key', `AIza${'A'.repeat(35)}`],
      ['a JWT', `eyJ${'a'.repeat(10)}.eyJ${'b'.repeat(10)}.${'c'.repeat(10)}`],
    ];
    const memory = harness();
    const cwd = tempDir();

    for (const [kind, secret] of secrets) {
      const message = await refusal(memory.run, cwd, {
        action: 'save',
        name: 'leak',
        description: 'A note that should never be written.',
        content: `The value is ${secret}.`,
      });
      expect(message).toBe(
        `memory refused: the note looks like it contains a secret (${kind}). Save where the secret lives, never the secret itself.`,
      );
      expect(message).not.toContain(secret);
    }
    // A secret in the description is caught too.
    const inDescription = await refusal(memory.run, cwd, {
      action: 'save',
      name: 'leak',
      description: `token ${'ghp_' + 'a'.repeat(36)}`,
      content: 'body',
    });
    expect(inDescription).toContain('a GitHub token');
    expect(noteFiles(memory.home)).toEqual([]);
  });

  it('refuses the value of a secret-named environment variable, but not a short one', async () => {
    const value = 'deploy-token-value';
    const memory = harness({ DEPLOY_TOKEN: value, SHORT_KEY: 'short' });
    const cwd = tempDir();

    const message = await refusal(memory.run, cwd, {
      action: 'save',
      name: 'leak',
      description: 'A note mentioning a token.',
      content: `The token is ${value}.`,
    });
    expect(message).toBe(
      'memory refused: the note looks like it contains a secret (the value of $DEPLOY_TOKEN). Save where the secret lives, never the secret itself.',
    );
    expect(message).not.toContain(value);

    // Below the length floor a value is ordinary prose, not a credential.
    const saved = await memory.run(cwd, {
      action: 'save',
      name: 'ordinary',
      description: 'A short value is not a secret.',
      content: 'The short value is short.',
    });
    expect(saved.content[0]!.text).toContain("Saved memory 'ordinary'");
  });

  it('keeps two working directories apart, even with the same basename', async () => {
    const memory = harness();
    const root = tempDir();
    const one = path.join(root, 'one', 'project');
    const two = path.join(root, 'two', 'project');
    mkdirSync(one, { recursive: true });
    mkdirSync(two, { recursive: true });

    await memory.run(one, { action: 'save', name: 'first-note', description: 'Made in one.', content: 'body' });
    await memory.run(two, { action: 'save', name: 'second-note', description: 'Made in two.', content: 'body' });

    const keys = storeKeys(memory.home);
    expect(keys).toHaveLength(2);
    expect(keys.every((key) => key.startsWith('project-'))).toBe(true);
    expect(new Set(keys).size).toBe(2);

    expect(memory.section(one)).toContain('- [first-note](first-note.md) — Made in one.');
    expect(memory.section(one)).not.toContain('second-note');
    expect(memory.section(two)).toContain('- [second-note](second-note.md) — Made in two.');
    expect(memory.section(two)).not.toContain('first-note');
  });

  it.skipIf(process.platform === 'win32')('creates the store and its files readable only by the owner', async () => {
    const memory = harness();
    const cwd = tempDir();
    const saved = await memory.run(cwd, { action: 'save', name: 'modes', description: 'A note.', content: 'body' });

    const dir = path.dirname(saved.details.path);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(saved.details.path).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(dir, 'MEMORY.md')).mode & 0o777).toBe(0o600);
  });

  it('never throws from the system-prompt hook', () => {
    // A home that is a file cannot hold a store; the run still gets a prompt.
    const home = path.join(tempDir(), 'not-a-directory');
    writeFileSync(home, 'x');
    let hook: Hook | undefined;
    registerMemory(
      {
        registerTool: (() => undefined) as never,
        on: ((event: string, handler: Hook) => {
          if (event === 'before_agent_start') hook = handler;
        }) as never,
      },
      { home, env: {} },
    );
    const result = hook!({ systemPrompt: 'BASE PROMPT' }, { cwd: tempDir() });
    expect(result?.systemPrompt).toContain('BASE PROMPT');
    expect(result?.systemPrompt).toContain('# Memory');
    expect(result?.systemPrompt).toContain('No notes yet.');
  });
});
