/**
 * The CodeDeck Pi extension: the module the driver writes into Pi's home. It
 * must gate every tool call and register a bound provider profile with the
 * token read from the environment; and the text the host carries must import
 * nothing Pi does not provide.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundledPiExtension, installPiExtension, PI_PERMISSION_PREFIX, piExtensionPath } from '../extension';
import { installGate } from '../extension/gate';
import { registerProfile } from '../extension/provider';

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
  function registered(env: Record<string, string | undefined>): { id: string; config: Record<string, unknown> } | undefined {
    let provider: { id: string; config: Record<string, unknown> } | undefined;
    registerProfile(
      {
        registerProvider: ((id: string, config: unknown) => {
          provider = { id, config: config as Record<string, unknown> };
        }) as never,
      },
      env,
    );
    return provider;
  }

  it('registers a bound profile at the endpoint the driver resolved, with the token reference', () => {
    const provider = registered({
      CODEDECK_PI_PROVIDER: JSON.stringify({
        id: 'codedeck-fake',
        label: 'Fake',
        baseUrl: 'https://api.example.com/v1',
        models: [{ id: 'fake-model-1', label: 'Fake model', contextWindow: 64_000 }],
      }),
      CODEDECK_PI_PROVIDER_TOKEN: 'sk-value',
    });
    expect(provider?.id).toBe('codedeck-fake');
    expect(provider?.config).toMatchObject({
      name: 'Fake',
      baseUrl: 'https://api.example.com/v1',
      api: 'openai-completions',
      apiKey: '$CODEDECK_PI_PROVIDER_TOKEN',
      models: [expect.objectContaining({ id: 'fake-model-1', name: 'Fake model', contextWindow: 64_000 })],
    });
    // The secret itself never reaches the registration.
    expect(JSON.stringify(provider)).not.toContain('sk-value');
  });

  it('registers nothing without a profile, and a malformed one does not throw', () => {
    expect(registered({})).toBeUndefined();
    expect(() => registered({ CODEDECK_PI_PROVIDER: '{ not json' })).not.toThrow();
    expect(registered({ CODEDECK_PI_PROVIDER: '{ not json' })).toBeUndefined();
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
    expect(asked).toEqual({ title: `${PI_PERMISSION_PREFIX}call_1`, options: ['allow', 'deny'] });

    const allowing = { ui: { select: () => Promise.resolve('allow') } };
    await expect(handler!({ toolCallId: 'call_2', toolName: 'bash', input: {} }, allowing)).resolves.toBeUndefined();
  });
});
