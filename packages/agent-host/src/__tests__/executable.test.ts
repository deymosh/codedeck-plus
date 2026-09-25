import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exeName, findInDirs, findOnPath } from '../executable';

describe('executable lookup', () => {
  let a: string;
  let b: string;

  beforeEach(() => {
    a = fs.mkdtempSync(path.join(os.tmpdir(), 'exe-a-'));
    b = fs.mkdtempSync(path.join(os.tmpdir(), 'exe-b-'));
  });

  afterEach(() => {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  });

  it('names the binary per platform', () => {
    expect(exeName('claude', 'linux')).toBe('claude');
    expect(exeName('claude', 'win32')).toBe('claude.exe');
  });

  it('takes the first directory that holds the binary', () => {
    fs.writeFileSync(path.join(b, 'claude'), '');
    expect(findInDirs([a, b], 'claude', 'linux')).toBe(path.join(b, 'claude'));
    expect(findInDirs([a], 'claude', 'linux')).toBeNull();
  });

  // A Windows temp dir (`C:\...`) holds a colon itself.
  it.skipIf(process.platform === 'win32')('walks a colon-separated PATH off Windows', () => {
    fs.writeFileSync(path.join(b, 'opencode'), '');
    expect(findOnPath('opencode', { PATH: `${a}:${b}` }, 'linux')).toBe(path.join(b, 'opencode'));
  });

  it('on Windows reads Path case-insensitively and finds only the .exe', () => {
    fs.writeFileSync(path.join(a, 'opencode.cmd'), '');
    expect(findOnPath('opencode', { Path: `${a};${b}` }, 'win32')).toBeNull();
    fs.writeFileSync(path.join(b, 'opencode.exe'), '');
    expect(findOnPath('opencode', { Path: `${a};${b}` }, 'win32')).toBe(path.join(b, 'opencode.exe'));
  });

  it('returns null without a PATH', () => {
    expect(findOnPath('claude', {}, 'linux')).toBeNull();
  });
});
