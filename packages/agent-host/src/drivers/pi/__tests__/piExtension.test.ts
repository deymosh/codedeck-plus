/**
 * The extension CodeDeck writes into Pi's process: it must be a standalone
 * module (Pi serialises the function and runs it where nothing this host
 * defines exists), it must gate every tool call, and it must register a
 * provider profile with the token read from the environment.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codedeckPiExtensionSource, installPiExtension, PI_PERMISSION_PREFIX, piExtensionPath } from '../extension';

const read = (file: string): string => readFileSync(file, 'utf8');

describe('the generated extension source', () => {
  it('is one standalone module, with no import and no reference to this host', () => {
    const source = codedeckPiExtensionSource();
    expect(source).toMatch(/^export default function/m);
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(/);
    // The literal, not the constant: the constant does not exist inside Pi.
    expect(source).toContain(PI_PERMISSION_PREFIX);
    expect(source).not.toContain('PI_PERMISSION_PREFIX');
  });

  it('reads the profile token from the environment by name', () => {
    expect(codedeckPiExtensionSource()).toContain('$CODEDECK_PI_PROVIDER_TOKEN');
  });
});

describe('installPiExtension', () => {
  it('writes the file under the state root, and only rewrites a changed one', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'codedeck-pi-ext-'));
    const file = installPiExtension(home);
    expect(file).toBe(piExtensionPath(home));
    expect(read(file)).toBe(codedeckPiExtensionSource());
    // A rewrite would change nothing; the driver must not touch it then.
    writeFileSync(file, codedeckPiExtensionSource());
    const before = read(file);
    expect(installPiExtension(home)).toBe(file);
    expect(read(file)).toBe(before);
  });
});

describe('the extension as Pi loads it', () => {
  const env = process.env;
  afterEach(() => {
    process.env = env;
  });

  /** The serialised function, evaluated the way a JavaScript engine reads
   *  the module Pi is handed: the source is `export default <function>`, so
   *  it becomes the body of a function that returns that function. This also
   *  proves the text needs nothing else — an identifier from this host would
   *  throw here. */
  async function evaluate(): Promise<(pi: Record<string, unknown>) => void> {
    const source = codedeckPiExtensionSource().replace(/^export default /m, 'return ');
    // eslint-disable-next-line no-new-func
    return new Function(source)() as (pi: Record<string, unknown>) => void;
  }

  function api(): {
    calls: {
      provider?: { id: string; config: Record<string, unknown> };
      toolCall?: (event: unknown, ctx: unknown) => Promise<unknown>;
    };
    pi: Record<string, unknown>;
  } {
    const calls: {
      provider?: { id: string; config: Record<string, unknown> };
      toolCall?: (event: unknown, ctx: unknown) => Promise<unknown>;
    } = {};
    const pi = {
      registerProvider: (id: string, config: Record<string, unknown>) => {
        calls.provider = { id, config };
      },
      on: (_event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
        calls.toolCall = handler;
      },
    };
    return { calls, pi };
  }

  it('registers a bound profile at the endpoint the driver resolved, with the token reference', async () => {
    process.env = {
      ...env,
      CODEDECK_PI_PROVIDER: JSON.stringify({
        id: 'codedeck-fake',
        label: 'Fake',
        baseUrl: 'https://api.example.com/v1',
        models: [{ id: 'fake-model-1', label: 'Fake model', contextWindow: 64_000 }],
      }),
      CODEDECK_PI_PROVIDER_TOKEN: 'sk-value',
    };
    const { calls, pi } = api();
    (await evaluate())(pi);
    expect(calls.provider?.id).toBe('codedeck-fake');
    expect(calls.provider?.config).toMatchObject({
      name: 'Fake',
      baseUrl: 'https://api.example.com/v1',
      api: 'openai-completions',
      apiKey: '$CODEDECK_PI_PROVIDER_TOKEN',
      models: [expect.objectContaining({ id: 'fake-model-1', contextWindow: 64_000 })],
    });
  });

  it('registers nothing without a profile, and a malformed one does not throw', async () => {
    process.env = { ...env };
    delete process.env.CODEDECK_PI_PROVIDER;
    const first = api();
    (await evaluate())(first.pi);
    expect(first.calls.provider).toBeUndefined();

    process.env.CODEDECK_PI_PROVIDER = '{ not json';
    const second = api();
    const extension = await evaluate();
    expect(() => extension(second.pi)).not.toThrow();
    expect(second.calls.provider).toBeUndefined();
  });

  it('holds a tool call until the dialog answers, and blocks anything but allow', async () => {
    process.env = { ...env };
    delete process.env.CODEDECK_PI_PROVIDER;
    const { calls, pi } = api();
    (await evaluate())(pi);
    const handler = calls.toolCall!;

    let asked: { title: string; options: string[] } | undefined;
    const ctx = {
      ui: {
        select: (title: string, options: string[]) => {
          asked = { title, options };
          return Promise.resolve('deny');
        },
      },
    };
    await expect(handler({ toolCallId: 'call_1', toolName: 'bash', input: {} }, ctx)).resolves.toEqual({
      block: true,
      reason: 'Denied by the user',
    });
    expect(asked).toEqual({ title: `${PI_PERMISSION_PREFIX}call_1`, options: ['allow', 'deny'] });

    const allowing = { ui: { select: () => Promise.resolve('allow') } };
    await expect(handler({ toolCallId: 'call_2', toolName: 'bash', input: {} }, allowing)).resolves.toBeUndefined();
  });
});
