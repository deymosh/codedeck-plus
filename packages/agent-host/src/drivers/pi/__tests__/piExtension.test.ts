/**
 * The CodeDeck Pi extension: the module the driver writes into Pi's home. It
 * must gate every tool call and register a bound provider profile with the
 * token read from its pipe; and the text the host carries must import
 * nothing Pi does not provide.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundledPiExtension, installPiExtension, PI_PERMISSION_PREFIX, piExtensionPath } from '../extension';
import type { CatalogModel } from '../extension/catalog';
import { installGate } from '../extension/gate';
import { configLiteral, readProviderToken, registerProfile } from '../extension/provider';
import { installShellCheck } from '../extension/shells';
import { subagentTools, taskResult } from '../extension/task';

const read = (file: string): string => readFileSync(file, 'utf8');

describe('the bundled extension', () => {
  it('is carried by the host, and imports only what Pi provides to extensions', () => {
    const source = bundledPiExtension();
    expect(source).toBeDefined();
    expect(source).toMatch(/^export \{/m);
    const imports = [...source!.matchAll(/^import\s.*?from\s+["']([^"']+)["']/gm)].map((match) => match[1]!);
    for (const specifier of imports) {
      expect(specifier).toMatch(/^(node:|@earendil-works\/|typebox(\/|$))/);
    }
    expect(source).not.toMatch(/\brequire\(/);
  });
});

describe('installPiExtension', () => {
  it('writes the file under the state root, and only rewrites a changed one', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'codedeck-pi-ext-'));
    const file = installPiExtension(home, 'export default function () {}\n');
    expect(file).toBe(piExtensionPath(home));
    expect(read(file)).toBe('export default function () {}\n');
    // A rewrite would change nothing; the driver must not touch it then.
    const before = read(file);
    expect(installPiExtension(home, 'export default function () {}\n')).toBe(file);
    expect(read(file)).toBe(before);
    writeFileSync(file, 'stale');
    installPiExtension(home, 'export default function () {}\n');
    expect(read(file)).toBe('export default function () {}\n');
  });

  it('refuses to start Pi without the gate', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'codedeck-pi-ext-'));
    expect(() => installPiExtension(home, undefined)).toThrow(/without the CodeDeck Pi extension/);
  });
});

describe('the provider profile', () => {
  function registered(
    env: Record<string, string | undefined>,
    catalog: () => CatalogModel[] = () => [],
    /** `null`: no token arrived. */
    token: string | null = 'sk-value',
    warnings: string[] = [],
  ): { id: string; config: Record<string, unknown> } | undefined {
    let provider: { id: string; config: Record<string, unknown> } | undefined;
    registerProfile(
      {
        registerProvider: ((id: string, config: unknown) => {
          provider = { id, config: config as Record<string, unknown> };
        }) as never,
      },
      env,
      token ?? undefined,
      catalog,
      (line) => warnings.push(line),
    );
    return provider;
  }

  const FAKE_PROFILE = JSON.stringify({
    id: 'codedeck-fake',
    label: 'Fake',
    baseUrl: 'https://api.example.com/v1',
    models: [{ id: 'fake-model-1', label: 'Fake model', contextWindow: 64_000 }],
  });

  it('registers a bound profile at the endpoint the driver resolved, with the token as its key', () => {
    const provider = registered({ CODEDECK_PI_PROVIDER: FAKE_PROFILE });
    expect(provider?.id).toBe('codedeck-fake');
    expect(provider?.config).toMatchObject({
      name: 'Fake',
      baseUrl: 'https://api.example.com/v1',
      api: 'openai-completions',
      apiKey: 'sk-value',
      models: [expect.objectContaining({ id: 'fake-model-1', name: 'Fake model', contextWindow: 64_000 })],
    });
  });

  it("escapes a token Pi would read as a variable or a command (a real Pi resolves it: piFakeModel)", () => {
    expect(configLiteral('sk-plain')).toBe('sk-plain');
    expect(configLiteral('sk$HOME')).toBe('sk$$HOME');
    expect(configLiteral('$$')).toBe('$$$$');
    expect(configLiteral('!cat x')).toBe('$!cat x');
    expect(configLiteral('!a$b')).toBe('$!a$$b');
  });

  it('registers a profile whose token did not arrive keyless, and says so', () => {
    const warnings: string[] = [];
    const provider = registered({ CODEDECK_PI_PROVIDER: FAKE_PROFILE }, () => [], null, warnings);
    expect(provider?.config).not.toHaveProperty('apiKey');
    expect(warnings).toEqual([expect.stringContaining("no token arrived for the provider profile 'codedeck-fake'")]);
  });

  it("reads the token from its pipe only for a Pi started with a profile, and a pipe that is not there gives none", () => {
    const fds: number[] = [];
    const read = (fd: number): string => {
      fds.push(fd);
      return 'sk-piped';
    };
    expect(readProviderToken({}, read)).toBeUndefined();
    expect(fds).toEqual([]);
    expect(readProviderToken({ CODEDECK_PI_PROVIDER: FAKE_PROFILE }, read)).toBe('sk-piped');
    expect(fds).toEqual([3]);
    const missing = (): string => {
      throw Object.assign(new Error('bad file descriptor'), { code: 'EBADF' });
    };
    expect(readProviderToken({ CODEDECK_PI_PROVIDER: FAKE_PROFILE }, missing)).toBeUndefined();
    expect(readProviderToken({ CODEDECK_PI_PROVIDER: FAKE_PROFILE }, () => '')).toBeUndefined();
  });

  it('takes what Pi knows of a model, through a gateway route or a vendor prefix', () => {
    const catalog: CatalogModel[] = [
      // The same model at two of Pi's providers, with different limits.
      { id: 'deepseek-v4.1-flash', provider: 'opencode-go', api: 'openai-completions', reasoning: true, contextWindow: 1_000_000, maxTokens: 384_000, compat: { supportsStore: false } },
      { id: 'deepseek/deepseek-v4.1-flash', provider: 'openrouter', api: 'openai-completions', reasoning: true, contextWindow: 640_000, maxTokens: 64_000 },
      { id: 'claude-sonnet-5', provider: 'anthropic', api: 'anthropic-messages', reasoning: true, contextWindow: 200_000, maxTokens: 64_000, input: ['text', 'image'], compat: { x: 1 } },
    ];
    const provider = registered(
      {
        CODEDECK_PI_PROVIDER: JSON.stringify({
          id: 'router',
          baseUrl: 'https://gateway.example/v1',
          models: [
            { id: 'OpenCode Go/deepseek-v4.1-flash' }, // the route names Pi's provider
            { id: 'Some Gateway/deepseek-v4.1-flash' }, // it does not: the smallest window
            { id: 'deepseek-v4.1-flash', contextWindow: 131_072 }, // the endpoint said: it wins
            { id: 'anthropic/claude-sonnet-5' }, // another API: no compat borrowed
            { id: 'unknown/model-x' },
          ],
        }),
      },
      () => catalog,
    );
    const models = provider?.config.models as Array<Record<string, unknown>>;
    expect(models[0]).toMatchObject({ reasoning: true, contextWindow: 1_000_000, maxTokens: 384_000, compat: { supportsStore: false } });
    expect(models[1]).toMatchObject({ reasoning: true, contextWindow: 640_000, maxTokens: 64_000 });
    expect(models[2]).toMatchObject({ contextWindow: 131_072, maxTokens: 64_000 });
    expect(models[3]).toMatchObject({ reasoning: true, contextWindow: 200_000, input: ['text', 'image'] });
    expect(models[3]).not.toHaveProperty('compat');
    expect(models[4]).toMatchObject({ reasoning: false, contextWindow: 128_000, maxTokens: 32_768, input: ['text'] });
  });

  it('registers nothing without a profile, and a malformed one does not throw', () => {
    expect(registered({})).toBeUndefined();
    expect(() => registered({ CODEDECK_PI_PROVIDER: '{ not json' })).not.toThrow();
    expect(registered({ CODEDECK_PI_PROVIDER: '{ not json' })).toBeUndefined();
  });
});

describe('a sub-agent’s tools', () => {
  const active = ['read', 'bash', 'edit', 'write', 'ls', 'grep', 'todo', 'ask', 'task', 'web_fetch', 'memory', 'mcp_tool'];

  it('gives an explore sub-agent only the read-only built-ins the session has', () => {
    expect(subagentTools('explore', active)).toEqual(['read', 'ls', 'grep']);
  });

  it('gives a general one the session’s built-ins and web_fetch, never a parent-only tool', () => {
    expect(subagentTools('general', active)).toEqual(['read', 'bash', 'edit', 'write', 'ls', 'grep', 'web_fetch']);
  });
});

describe('a task’s result', () => {
  it('is the sub-agent’s last reply when it finished', () => {
    expect(taskResult({ text: 'Found it in src/a.ts' })).toBe('Found it in src/a.ts');
  });

  it('fails when the sub-agent crashed or was stopped, even after it said something', () => {
    expect(() => taskResult({ text: '', error: 'the sub-agent exited (1)' })).toThrow('the sub-agent exited (1)');
    expect(() => taskResult({ text: 'Looking at src…', error: 'The sub-agent was stopped.' })).toThrow(
      /was stopped[\s\S]*Its last reply before that:\nLooking at src/,
    );
  });
});

describe('the shell check', () => {
  function started(active: string[], bash: boolean): string[] {
    let tools = [...active];
    let onStart: (() => Promise<void>) | undefined;
    installShellCheck(
      {
        on: ((_event: string, handler: () => Promise<void>) => {
          onStart = handler;
        }) as never,
        getActiveTools: () => tools,
        setActiveTools: (next: string[]) => {
          tools = next;
        },
      },
      () => bash,
    );
    void onStart!();
    return tools;
  }

  it('switches bash off where Pi finds none and PowerShell can stand in', () => {
    expect(started(['read', 'bash', 'powershell'], false)).toEqual(['read', 'powershell']);
  });

  it('leaves the tools alone where bash exists, or where it is the only shell', () => {
    expect(started(['read', 'bash', 'powershell'], true)).toEqual(['read', 'bash', 'powershell']);
    expect(started(['read', 'bash'], false)).toEqual(['read', 'bash']);
  });
});

describe('the permission gate', () => {
  it('holds a tool call until the dialog answers, and blocks anything but allow', async () => {
    let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
    installGate({
      on: ((_event: string, h: (event: unknown, ctx: unknown) => Promise<unknown>) => {
        handler = h;
      }) as never,
    });

    let asked: { title: string; options: string[] } | undefined;
    const denying = {
      ui: {
        select: (title: string, options: string[]) => {
          asked = { title, options };
          return Promise.resolve('deny');
        },
      },
    };
    await expect(handler!({ toolCallId: 'call_1', toolName: 'bash', input: {} }, denying)).resolves.toEqual({
      block: true,
      reason: 'Denied by the user',
    });
    expect(asked).toEqual({ title: `${PI_PERMISSION_PREFIX}call_1`, options: ['allow', 'deny', 'plan'] });

    const allowing = { ui: { select: () => Promise.resolve('allow') } };
    await expect(handler!({ toolCallId: 'call_2', toolName: 'bash', input: {} }, allowing)).resolves.toBeUndefined();

    // Plan mode's refusal tells the model what to do instead.
    const planning = { ui: { select: () => Promise.resolve('plan') } };
    await expect(handler!({ toolCallId: 'call_3', toolName: 'bash', input: {} }, planning)).resolves.toEqual({
      block: true,
      reason: expect.stringContaining('exit_plan'),
    });
    // A dialog nobody answered blocks, as a denial does.
    const cancelled = { ui: { select: () => Promise.resolve(undefined) } };
    await expect(handler!({ toolCallId: 'call_4', toolName: 'bash', input: {} }, cancelled)).resolves.toMatchObject({ block: true });
  });
});
