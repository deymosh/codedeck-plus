/**
 * Pi's built-in tool table, and — against the package this build pins — the
 * names that package declares.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PI_READ_ONLY_TOOLS, PI_TOOLS, isReadOnlyCommand, isReadOnlyPowerShell, piExtraTools, piTool } from '../tools';

describe('piExtraTools', () => {
  const exe = (dir: string, name: string, platform: NodeJS.Platform): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, platform === 'win32' ? `${name}.exe` : name), '');
  };
  const scratch = (): { home: string; onPath: string; root: string } => {
    const root = mkdtempSync(path.join(tmpdir(), 'codedeck-pi-tools-'));
    const onPath = path.join(root, 'path');
    mkdirSync(onPath, { recursive: true });
    return { root, home: path.join(root, 'home'), onPath };
  };

  it('turns on ls always, and grep and find only where their binaries are', () => {
    // The host's own platform: PATH is split by its rules, which a Windows
    // path (`D:\…`) read with another platform's would not survive.
    const platform = process.platform;
    const { home, onPath } = scratch();
    const env = { PATH: onPath };
    // PowerShell is Windows' own business (the next test).
    const tools = (): string[] => piExtraTools(home, env, platform).filter((entry) => entry !== '+powershell');
    // Neither ripgrep nor fd: searching would only fail.
    expect(tools()).toEqual(['+ls']);
    // ripgrep in Pi's own bin directory, Debian's `fdfind` on PATH.
    exe(path.join(home, 'bin'), 'rg', platform);
    exe(onPath, 'fdfind', platform);
    expect(tools()).toEqual(['+ls', '+grep', '+find']);
  });

  it('on Windows turns on PowerShell beside bash', () => {
    const { home, onPath } = scratch();
    expect(piExtraTools(home, { Path: onPath }, 'win32')).toEqual(['+ls', '+powershell']);
  });
});

describe('isReadOnlyPowerShell (plan mode)', () => {
  it('lets PowerShell commands that only read through', () => {
    for (const command of [
      'Get-ChildItem -Recurse src',
      'Get-Content package.json | Select-Object -First 20',
      'gci; pwd',
      'Select-String -Path README.md -Pattern TODO | Measure-Object',
      'git status',
      'git diff HEAD~1 -- src',
    ]) {
      expect(isReadOnlyPowerShell(command), command).toBe(true);
    }
  });

  it('refuses writes, script blocks, subexpressions and anything unknown', () => {
    for (const command of [
      'Set-Content a.txt x',
      'Get-Content a.txt > b.txt',
      'Get-ChildItem | Where-Object { Remove-Item $_ }',
      'Get-ChildItem | ForEach-Object Delete',
      'Remove-Item -Recurse build',
      'Get-Content $(Invoke-WebRequest x)',
      'Get-Content @(1)',
      '& ./run.ps1',
      'Get-Content a`; rm b',
      'Get-ChildItem | Out-File list.txt',
      'Get-ChildItem | Tee-Object list.txt',
      'git commit -m x',
      // These read, but what they read is the environment: secrets.
      'Get-ChildItem env:',
      'Get-Content Env:GITHUB_TOKEN',
      'Write-Output $env:GITHUB_TOKEN',
      'Get-Content $HOME/.ssh/id_ed25519',
      'Get-Content /proc/self/environ',
      'Get-Content /proc/self/env*',
      'git grep -Osh TODO',
      '',
    ]) {
      expect(isReadOnlyPowerShell(command), command).toBe(false);
    }
  });
});

describe('isReadOnlyCommand (plan mode)', () => {
  it('lets commands that only read through, alone and in pipelines', () => {
    for (const command of [
      'git status',
      'git log --oneline -5',
      'git diff HEAD~1 -- src',
      'cat package.json | head -20',
      'grep -rn TODO src && wc -l src/main.ts',
      'rg --files | sort',
      'find . -name "*.ts" -type f',
      'ls -la; pwd',
    ]) {
      expect(isReadOnlyCommand(command), command).toBe(true);
    }
  });

  it('refuses anything that writes, runs another program, or is not known', () => {
    for (const command of [
      'echo x > file.txt',
      'cat a >> b',
      'npm install',
      'rm -rf build',
      'git commit -m x',
      'git checkout main',
      'git log --output=log.txt',
      'git -c core.pager=sh log',
      'find . -name x -delete',
      'find . -exec rm {} ;',
      'sort -o out.txt in.txt',
      'rg --pre ./run.sh x',
      'fd -x rm',
      'cat $(which node)',
      'cat `which node`',
      'grep x file & rm y',
      'env',
      'printenv TOKEN',
      'echo $GITHUB_TOKEN',
      'echo ${GITHUB_TOKEN}',
      'cat /proc/self/environ',
      'cat /proc/self/env*',
      'cat /pr?c/self/en*',
      // git grep's -O runs a program on the matches.
      'git grep -Osh TODO',
      'git grep -nO TODO',
      'git grep --open-files-in-pager=sh TODO',
      'python -c "print(1)"',
      'uniq in.txt out.txt',
      '',
    ]) {
      expect(isReadOnlyCommand(command), command).toBe(false);
    }
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
