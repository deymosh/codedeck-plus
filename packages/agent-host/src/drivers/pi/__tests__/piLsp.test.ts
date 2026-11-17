/**
 * The CodeDeck Pi extension's diagnostics: which server a changed file gets,
 * what the model reads after an `edit` or `write`, and how each kind of
 * server is waited for — against fakeLanguageServer.mjs, whose modes are the
 * real servers' behaviour as observed (its header says which).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mergeDiagnostics, type DiagnosticsResult, type SpawnServer } from '../extension/lsp/client';
import { changedFile, formatDiagnostics, LSP_ENV, MAX_REPORTED, ProjectServers, registerDiagnostics } from '../extension/lsp/diagnostics';
import { serverFor, type Machine } from '../extension/lsp/servers';
import { PROVIDER_TOKEN_ENV } from '../extension/provider';

const FAKE_SERVER = fileURLToPath(new URL('./fakeLanguageServer.mjs', import.meta.url));

/** A path as the lookup spells it on this host (it uses the host's `path`). */
const P = (file: string): string => path.resolve(file);

/** A machine made of the files named, nothing else. `platform` decides only
 *  how PATH is split and searched. */
function fakeMachine(files: Record<string, string>, options: { platform?: NodeJS.Platform; env?: Record<string, string> } = {}): Machine {
  const normal = new Map(Object.entries(files).map(([file, text]) => [P(file), text]));
  return {
    isFile: (file) => normal.has(P(file)),
    readText: (file) => normal.get(P(file)),
    env: options.env ?? {},
    platform: options.platform ?? 'linux',
    execPath: '/usr/bin/node',
  };
}

describe('the server a changed file gets', () => {
  it("runs typescript-language-server for a TypeScript up to 6, from the project's own node_modules, with Pi's Node", () => {
    const m = fakeMachine({
      '/repo/node_modules/typescript/package.json': '{}',
      '/repo/node_modules/typescript/lib/tsserver.js': '',
      '/repo/node_modules/typescript-language-server/package.json': '{"bin":{"typescript-language-server":"./lib/cli.mjs"}}',
      '/repo/node_modules/typescript-language-server/lib/cli.mjs': '',
      '/repo/packages/web/tsconfig.json': '{}',
    });
    expect(serverFor(P('/repo/packages/web/src/a.ts'), m)).toEqual({
      language: 'typescript',
      languageId: 'typescript',
      root: P('/repo/packages/web'),
      server: {
        name: 'typescript-language-server',
        command: '/usr/bin/node',
        args: [P('/repo/node_modules/typescript-language-server/lib/cli.mjs'), '--stdio'],
      },
    });
  });

  it("runs TypeScript 7's own server, which has no tsserver", () => {
    const m = fakeMachine({
      '/p/package.json': '{}',
      '/p/node_modules/typescript/package.json': '{"bin":{"tsc":"./bin/tsc"}}',
      '/p/node_modules/typescript/bin/tsc': '',
      '/usr/local/bin/typescript-language-server': '',
    }, { env: { PATH: '/usr/local/bin' } });
    expect(serverFor(P('/p/a.tsx'), m)?.server).toEqual({ name: 'tsc --lsp', command: '/usr/bin/node', args: [P('/p/node_modules/typescript/bin/tsc'), '--lsp', '--stdio'] });
    expect(serverFor(P('/p/a.tsx'), m)?.languageId).toBe('typescriptreact');
  });

  it("falls back to a typescript-language-server on PATH, an npm .cmd shim on Windows run through a shell", () => {
    const m = fakeMachine(
      // Keys joined as the lookup joins them, so the case holds on a Linux host too.
      { [path.join('C:\\npm', 'typescript-language-server')]: '', [path.join('C:\\npm', 'typescript-language-server.cmd')]: '', 'C:\\w\\package.json': '{}' },
      { platform: 'win32', env: { Path: 'C:\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD' } },
    );
    expect(serverFor('C:\\w\\a.js', m)?.server).toEqual({
      name: 'typescript-language-server',
      command: path.join('C:\\npm', 'typescript-language-server.cmd'),
      args: ['--stdio'],
      shell: true,
    });
  });

  it("prefers the project's virtualenv for Python, basedpyright before Pyright", () => {
    const m = fakeMachine(
      {
        '/py/pyproject.toml': '',
        '/py/.venv/bin/pyright-langserver': '',
        '/py/.venv/bin/basedpyright-langserver': '',
        '/usr/bin/pyright-langserver': '',
      },
      { env: { PATH: '/usr/bin' } },
    );
    expect(serverFor(P('/py/pkg/mod.py'), m)).toMatchObject({ root: P('/py'), server: { name: 'basedpyright-langserver', command: P('/py/.venv/bin/basedpyright-langserver') } });
  });

  it('checks Rust from the crate that holds the file, and gives no server to a language it has none for', () => {
    const m = fakeMachine({ '/r/Cargo.toml': '', '/bin/rust-analyzer': '' }, { env: { PATH: '/bin' } });
    expect(serverFor(P('/r/src/main.rs'), m)).toMatchObject({ root: P('/r'), server: { name: 'rust-analyzer', command: path.join('/bin', 'rust-analyzer') } });
    expect(serverFor(P('/r/README.md'), m)).toBeUndefined();
    // Python here has no server at all: nothing is installed for it.
    expect(serverFor(P('/r/tool.py'), m)).toBeUndefined();
  });
});

describe('what the model reads', () => {
  const result = (diagnostics: DiagnosticsResult['diagnostics'], settled = true): DiagnosticsResult => ({ diagnostics, settled });

  it('lists errors and warnings with one-based positions, and says nothing about a clean file or hints', () => {
    const text = formatDiagnostics(
      'src/a.ts',
      'typescript-language-server',
      result([
        { line: 0, character: 6, severity: 1, message: "Type 'string' is not assignable\n  to type 'number'.", code: '2322' },
        { line: 3, character: 0, severity: 2, message: 'Unused import' },
        { line: 4, character: 0, severity: 4, message: "'x' is declared but never read." },
      ]),
    );
    expect(text).toBe(
      "typescript-language-server reports 1 error, 1 warning in src/a.ts:\n" +
        "src/a.ts:1:7 error 2322: Type 'string' is not assignable; to type 'number'.\n" +
        'src/a.ts:4:1 warning: Unused import',
    );
    expect(formatDiagnostics('a.ts', 'x', result([{ line: 0, character: 0, severity: 4, message: 'hint' }]))).toBeUndefined();
    expect(formatDiagnostics('a.ts', 'x', result([]))).toBeUndefined();
  });

  it('caps a long list, and says when the server had not finished', () => {
    const many = Array.from({ length: MAX_REPORTED + 5 }, (_, i) => ({ line: i, character: 0, severity: 1, message: `e${i}` }));
    const text = formatDiagnostics('a.rs', 'rust-analyzer', result(many, false))!;
    expect(text.split('\n')[0]).toBe(`rust-analyzer reports ${MAX_REPORTED + 5} errors in a.rs (it had not finished checking; there may be more):`);
    expect(text.split('\n')).toHaveLength(1 + MAX_REPORTED + 1);
    expect(text.endsWith('… and 5 more')).toBe(true);
  });

  it("counts one problem once when two checks word it differently, keeping the first's wording", () => {
    const own = { line: 1, character: 17, severity: 1, message: "expected u32, found &'static str", code: 'E0308', source: 'rust-analyzer' };
    const cargo = { ...own, message: 'mismatched types', source: 'rustc' };
    expect(mergeDiagnostics([own], [cargo])).toEqual([own]);
  });

  it('opens the file Pi changed: relative to the session, a leading @ dropped, ~ the home directory', () => {
    const cwd = path.resolve('/work');
    expect(changedFile({ path: 'src/a.ts' }, cwd)).toBe(path.resolve(cwd, 'src/a.ts'));
    expect(changedFile({ path: '@src/a.ts' }, cwd)).toBe(path.resolve(cwd, 'src/a.ts'));
    expect(changedFile({ path: '~/x.py' }, cwd)).toBe(path.join(homedir(), 'x.py'));
    expect(changedFile({}, cwd)).toBeUndefined();
  });
});

describe('diagnostics after a change, per kind of server', () => {
  /** A project whose one language (Rust, by its file name) has a server on
   *  PATH; whatever is started is the fake in `mode`. */
  function project(mode: string, deps: { env?: NodeJS.ProcessEnv; timeoutMs?: number; coldTimeoutMs?: number; kill?: (pid: number) => void } = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'codedeck-pi-lsp-'));
    writeFileSync(path.join(dir, 'Cargo.toml'), '');
    const m = fakeMachine({ [path.join(dir, 'Cargo.toml')]: '', '/bin/rust-analyzer': '' }, { env: { PATH: '/bin' }, platform: 'linux' });
    // The fake machine's paths are POSIX; the real file lives in `dir`.
    m.isFile = (file) => file === path.join(dir, 'Cargo.toml') || file === '/bin/rust-analyzer' || file === path.join('/bin', 'rust-analyzer');
    let spawned = 0;
    let env: NodeJS.ProcessEnv | undefined;
    const spawnFake: SpawnServer = (_server, cwd, childEnv) => {
      spawned++;
      env = childEnv;
      return spawn(process.execPath, [FAKE_SERVER, mode], { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'ignore'] });
    };
    const servers = new ProjectServers({
      machine: m,
      spawn: spawnFake,
      env: deps.env ?? {},
      timeoutMs: deps.timeoutMs ?? 5_000,
      coldTimeoutMs: deps.coldTimeoutMs ?? deps.timeoutMs ?? 5_000,
      ...(deps.kill ? { kill: deps.kill } : {}),
    });
    const file = path.join(dir, 'main.rs');
    return {
      servers,
      spawned: () => spawned,
      env: () => env,
      async change(text: string, signal?: AbortSignal) {
        writeFileSync(file, text);
        return servers.check(file, dir, signal);
      },
    };
  }

  it("reads a server that only pushes, unversioned, under VS Code's spelling of the file's URI (typescript-language-server)", async () => {
    const p = project('push');
    try {
      expect(await p.change('ok\nERROR bad type\n')).toBe('rust-analyzer reports 1 error in main.rs:\nmain.rs:2:1 error E1: bad type');
      // The next change is answered by the same process, about the new text.
      expect(await p.change('ok\n')).toBeUndefined();
      expect(await p.change('WARN careful\n')).toMatch(/1 warning in main\.rs:\nmain\.rs:1:1 warning E1: careful/);
      expect(p.spawned()).toBe(1);
    } finally {
      p.servers.stopAll();
    }
  });

  it('waits out the progress before a versioned push (Pyright)', async () => {
    const p = project('push-versioned');
    try {
      expect(await p.change('x\nERROR first\n')).toMatch(/main\.rs:2:1 error E1: first$/);
      expect(await p.change('x\nx\nERROR second\n')).toMatch(/main\.rs:3:1 error E1: second$/);
    } finally {
      p.servers.stopAll();
    }
  });

  it("pulls from a server that only answers pulls (TypeScript 7's tsc --lsp)", async () => {
    const p = project('pull');
    try {
      expect(await p.change('ERROR pulled\n')).toMatch(/main\.rs:1:1 error E1: pulled$/);
    } finally {
      p.servers.stopAll();
    }
  });

  it("pulls again once a loading workspace and cargo check are done, each problem once (rust-analyzer)", async () => {
    const p = project('ra');
    try {
      // The first pull answers empty while the workspace loads.
      expect(await p.change('fn main() {}\n  ERROR expected u32\n')).toBe('rust-analyzer reports 1 error in main.rs:\nmain.rs:2:3 error E1: expected u32');
    } finally {
      p.servers.stopAll();
    }
  });

  it('gives up on a server that cannot start, without trying it again for the project', async () => {
    const p = project('crash');
    expect(await p.change('ERROR x\n')).toBeUndefined();
    expect(await p.change('ERROR x\n')).toBeUndefined();
    expect(p.spawned()).toBe(1);
  });

  it('answers by the deadline from a server that never reports', async () => {
    const p = project('silent', { timeoutMs: 600 });
    try {
      const started = Date.now();
      expect(await p.change('ERROR x\n')).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      p.servers.stopAll();
    }
  });

  it('reads past a frame whose body is not an object, which must not throw inside Pi', async () => {
    const p = project('null-frame');
    try {
      expect(await p.change('ERROR still read\n')).toMatch(/main\.rs:1:1 error E1: still read$/);
    } finally {
      p.servers.stopAll();
    }
  });

  it("waits for this change's push, not a late one for the change before", async () => {
    // The first push (600 ms) comes after its check gave up (400 ms), while
    // the second check waits for its own (1000 ms): the late one must not
    // end that wait, to be dropped then as an older version.
    const p = project('slow-first', { coldTimeoutMs: 400, timeoutMs: 5_000 });
    try {
      expect(await p.change('ERROR first\n')).toBeUndefined();
      expect(await p.change('x\nERROR second\n')).toMatch(/main\.rs:2:1 error E1: second$/);
    } finally {
      p.servers.stopAll();
    }
  });

  it('stops waiting when the turn is stopped, also for a server still starting', async () => {
    const p = project('mute', { timeoutMs: 20_000 });
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 200);
    const started = Date.now();
    try {
      expect(await p.change('ERROR x\n', stop.signal)).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      p.servers.stopAll();
    }
  });

  it('stops a server that is still starting when Pi exits', async () => {
    const killed: number[] = [];
    const p = project('mute', {
      timeoutMs: 20_000,
      kill: (pid) => {
        killed.push(pid);
        process.kill(pid);
      },
    });
    const stop = new AbortController();
    const checking = p.change('ERROR x\n', stop.signal);
    await new Promise((resolve) => setTimeout(resolve, 300));
    p.servers.stopAll();
    stop.abort();
    await checking;
    expect(killed).toHaveLength(1);
  });

  it("starts the server without the provider profile's token", async () => {
    const p = project('pull', { env: { [PROVIDER_TOKEN_ENV]: 'sk-secret', HOME_MARK: 'kept' } });
    try {
      expect(await p.change(`ENV ${PROVIDER_TOKEN_ENV}\nENV HOME_MARK\n`)).toBe(
        `rust-analyzer reports 2 errors in main.rs:\nmain.rs:1:1 error E1: ${PROVIDER_TOKEN_ENV} is unset\nmain.rs:2:1 error E1: HOME_MARK is set`,
      );
      expect(p.env()?.[PROVIDER_TOKEN_ENV]).toBeUndefined();
    } finally {
      p.servers.stopAll();
    }
  });
});

describe('the tool_result hook', () => {
  type Handler = (event: Record<string, unknown>, ctx: { cwd: string; signal?: AbortSignal }) => Promise<unknown>;
  function hooked(env: NodeJS.ProcessEnv = {}) {
    let handler: Handler | undefined;
    const pi = { on: (event: string, fn: Handler) => (event === 'tool_result' ? (handler = fn) : undefined) };
    const checked: string[] = [];
    const servers = registerDiagnostics(pi as never, { env });
    if (servers) {
      servers.check = async (file) => {
        checked.push(file);
        return 'rust-analyzer reports 1 error in main.rs:\nmain.rs:1:1 error E1: x';
      };
    }
    return { handler, checked };
  }

  it("adds the report after the tool's own result, for a successful edit or write only", async () => {
    const { handler, checked } = hooked();
    const cwd = path.resolve('/w');
    const content = [{ type: 'text', text: 'Successfully replaced 1 block in src/main.rs.' }];
    expect(await handler!({ toolName: 'edit', isError: false, input: { path: 'src/main.rs' }, content }, { cwd })).toEqual({
      content: [...content, { type: 'text', text: 'rust-analyzer reports 1 error in main.rs:\nmain.rs:1:1 error E1: x' }],
    });
    expect(await handler!({ toolName: 'edit', isError: true, input: { path: 'a.rs' }, content }, { cwd })).toBeUndefined();
    expect(await handler!({ toolName: 'bash', isError: false, input: { command: 'x' }, content }, { cwd })).toBeUndefined();
    expect(checked).toEqual([path.resolve(cwd, 'src/main.rs')]);
  });

  it(`registers nothing with ${LSP_ENV}=off`, () => {
    expect(hooked({ [LSP_ENV]: 'off' }).handler).toBeUndefined();
  });
});
