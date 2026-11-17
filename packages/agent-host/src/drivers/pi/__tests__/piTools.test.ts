/**
 * Pi's built-in tool table, and — against the package this build pins — the
 * names that package declares.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PI_READ_ONLY_TOOLS, PI_TOOLS, piExtraTools, piTool } from '../tools';

describe('piExtraTools', () => {
  const exe = (dir: string, name: string): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, process.platform === 'win32' ? `${name}.exe` : name), '');
  };

  it('turns on ls always, and grep and find only where their binaries are', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'codedeck-pi-tools-'));
    const home = path.join(root, 'home');
    const onPath = path.join(root, 'path');
    mkdirSync(onPath, { recursive: true });
    const env = { PATH: onPath };
    // Neither ripgrep nor fd: searching would only fail.
    expect(piExtraTools(home, env)).toEqual(['ls']);
    // ripgrep in Pi's own bin directory, Debian's `fdfind` on PATH.
    exe(path.join(home, 'bin'), 'rg');
    exe(onPath, 'fdfind');
    expect(piExtraTools(home, env)).toEqual(['ls', 'grep', 'find']);
  });
});

describe('piTool', () => {
  it('reads a shell call by its command', () => {
    expect(piTool('bash', { command: 'npm test', timeout: 30 })).toEqual({ kind: 'execute', title: 'npm test' });
    expect(piTool('powershell', { command: 'Get-ChildItem' }).kind).toBe('execute');
  });

  it('reads the file tools by their path', () => {
    expect(piTool('read', { path: 'src/main.rs' })).toEqual({ kind: 'read', title: 'src/main.rs' });
    expect(piTool('write', { path: 'a.txt', content: 'x' })).toEqual({ kind: 'edit', title: 'a.txt' });
    // An edit's content travels as its diff, not as a second copy of the path.
    expect(piTool('edit', { path: 'a.txt', edits: [{ oldText: 'a', newText: 'b' }] })).toEqual({ kind: 'edit', title: 'a.txt' });
  });

  it('reads the search tools by their pattern', () => {
    expect(piTool('grep', { pattern: 'TODO', path: 'src' })).toMatchObject({ kind: 'search', title: 'TODO' });
    expect(piTool('find', { pattern: '**/*.rs' })).toMatchObject({ kind: 'search', title: '**/*.rs' });
  });

  it('reads ls as the directory it lists', () => {
    expect(piTool('ls', { path: 'src' })).toEqual({ kind: 'read', title: 'src' });
    expect(piTool('ls', {})).toEqual({ kind: 'read', title: '.' });
  });

  it('leaves a tool this table does not know to its own name and arguments', () => {
    const reported: string[] = [];
    expect(piTool('deploy', { target: 'prod' }, (name) => reported.push(name))).toEqual({
      kind: 'other',
      title: 'deploy',
      input: '{\n  "target": "prod"\n}',
    });
    expect(reported).toEqual(['deploy']);
  });

  it('keeps the read-only set to the four tools Pi itself treats as read-only', () => {
    expect([...PI_READ_ONLY_TOOLS].sort()).toEqual(['find', 'grep', 'ls', 'read']);
  });
});

/** `dist/core/tools/index.js`, where the built-in names live, found by
 *  walking up from this file to the installed package (pnpm links it into
 *  the workspace's `node_modules`). */
function toolsIndex(): string {
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'core', 'tools', 'index.js');
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
    if (path.dirname(dir) === dir) throw new Error('@earendil-works/pi-coding-agent is not installed beside the workspace');
  }
}

describe('the built-in tools the installed Pi declares', () => {
  it('has a table entry for every name Pi declares, and no other', () => {
    const match = /allToolNames\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(toolsIndex());
    expect(match, 'the bundle still declares allToolNames').not.toBeNull();
    const declared = [...match![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    // A silent zero would make the comparison below pass for the wrong reason.
    expect(declared.length).toBeGreaterThan(4);
    expect([...declared].sort()).toEqual(Object.keys(PI_TOOLS).sort());
  });
});
