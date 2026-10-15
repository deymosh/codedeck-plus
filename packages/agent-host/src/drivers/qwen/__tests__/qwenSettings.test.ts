import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProviderBinding } from '../../../sdk/types';
import {
  mergeQwenSettings,
  qwenDefaultModel,
  qwenKeyEnvName,
  qwenProviderEntries,
  qwenProviderEnv,
  qwenSettingsKey,
  writeQwenSettings,
} from '../settings';

const profile = (over: Partial<ProviderBinding> = {}): ProviderBinding => ({
  id: 'p1',
  label: 'Gateway',
  baseUrl: 'https://gateway.example',
  authToken: 'sk-secret',
  models: [{ id: 'glm-5.3', label: 'GLM 5.3' }],
  defaultModel: 'glm-5.3',
  ...over,
});

describe('qwenProviderEntries', () => {
  it('makes one entry per model, its base URL versioned and its envKey the profile’s own', () => {
    const providers = [
      profile({ models: [{ id: 'a' }, { id: 'b', label: 'Bee' }] }),
      profile({ id: 'p2', label: 'Second', baseUrl: 'https://second.example/v1', models: [{ id: 'c' }] }),
    ];
    expect(qwenProviderEntries(providers)).toEqual([
      { id: 'a', name: 'a', envKey: qwenKeyEnvName(0), baseUrl: 'https://gateway.example/v1' },
      { id: 'b', name: 'Bee', envKey: qwenKeyEnvName(0), baseUrl: 'https://gateway.example/v1' },
      // A base URL that already ends in /v1 is not given a second one.
      { id: 'c', name: 'c', envKey: qwenKeyEnvName(1), baseUrl: 'https://second.example/v1' },
    ]);
  });

  it('skips a profile whose base URL is not a URL', () => {
    expect(qwenProviderEntries([profile({ baseUrl: 'not a url' })])).toEqual([]);
  });
});

describe('mergeQwenSettings', () => {
  it('writes the providers, the auth type and the three switches, keeping everything else', () => {
    const existing = { theme: 'dark', modelProviders: { anthropic: [{ id: 'x' }] } };
    const merged = mergeQwenSettings(existing, [profile()]);
    expect(merged.theme).toBe('dark');
    expect((merged.modelProviders as Record<string, unknown>).anthropic).toEqual([{ id: 'x' }]);
    expect((merged.modelProviders as Record<string, unknown>).openai).toEqual([
      { id: 'glm-5.3', name: 'GLM 5.3', envKey: qwenKeyEnvName(0), baseUrl: 'https://gateway.example/v1' },
    ]);
    expect(merged.security).toEqual({ auth: { selectedType: 'openai' } });
    expect(merged.model).toEqual({ name: 'glm-5.3' });
    expect(merged.general).toEqual({ enableAutoUpdate: false });
    expect(merged.privacy).toEqual({ usageStatisticsEnabled: false });
  });

  it('keeps an operator’s own openai providers and replaces only its own entries', () => {
    const existing = {
      modelProviders: { openai: [{ id: 'mine', envKey: 'MY_KEY' }, { id: 'old', envKey: qwenKeyEnvName(0) }] },
    };
    const merged = mergeQwenSettings(existing, [profile()]);
    expect((merged.modelProviders as { openai: unknown[] }).openai).toEqual([
      { id: 'mine', envKey: 'MY_KEY' },
      { id: 'glm-5.3', name: 'GLM 5.3', envKey: qwenKeyEnvName(0), baseUrl: 'https://gateway.example/v1' },
    ]);
  });

  it('leaves the default model alone when no profile offers one', () => {
    const merged = mergeQwenSettings({ model: { name: 'operator-choice' } }, [profile({ models: [] })]);
    expect(merged.model).toEqual({ name: 'operator-choice' });
  });
});

describe('qwenDefaultModel', () => {
  it('is the first profile’s default, else its first model', () => {
    expect(qwenDefaultModel([profile()])).toBe('glm-5.3');
    expect(qwenDefaultModel([profile({ defaultModel: 'gone' })])).toBe('glm-5.3');
    expect(qwenDefaultModel([profile({ models: [] }), profile({ id: 'p2', models: [{ id: 'z' }] })])).toBe('z');
    expect(qwenDefaultModel([])).toBeUndefined();
  });
});

describe('qwenProviderEnv', () => {
  it('carries each profile’s token under the name its settings entry refers to', () => {
    expect(qwenProviderEnv([profile(), profile({ id: 'p2', authToken: 'sk-two' })])).toEqual({
      [qwenKeyEnvName(0)]: 'sk-secret',
      [qwenKeyEnvName(1)]: 'sk-two',
    });
  });
});

describe('qwenSettingsKey', () => {
  it('changes with the provider list and carries no token', () => {
    const key = qwenSettingsKey([profile()]);
    expect(key).not.toContain('sk-secret');
    expect(qwenSettingsKey([profile({ models: [{ id: 'other' }], defaultModel: 'other' })])).not.toBe(key);
    expect(qwenSettingsKey([profile()])).toBe(key);
  });
});

describe('writeQwenSettings', () => {
  it('writes the merged settings and preserves an operator’s own keys', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'codedeck-qwen-home-'));
    try {
      writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ theme: 'dark' }));
      await writeQwenSettings(home, [profile()], () => {});
      const written = JSON.parse(readFileSync(path.join(home, 'settings.json'), 'utf8')) as Record<string, unknown>;
      expect(written.theme).toBe('dark');
      expect(written.security).toEqual({ auth: { selectedType: 'openai' } });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('starts fresh when the file is missing or not JSON', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'codedeck-qwen-home-'));
    try {
      writeFileSync(path.join(home, 'settings.json'), '{ not json');
      const logs: string[] = [];
      await writeQwenSettings(home, [profile()], (line) => logs.push(line));
      const written = JSON.parse(readFileSync(path.join(home, 'settings.json'), 'utf8')) as Record<string, unknown>;
      expect((written.modelProviders as { openai: unknown[] }).openai).toHaveLength(1);
      expect(logs.some((line) => line.includes('could not be read'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
