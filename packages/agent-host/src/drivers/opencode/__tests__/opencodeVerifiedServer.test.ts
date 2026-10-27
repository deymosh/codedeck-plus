/**
 * Behaviours the probes against OpenCode 2.1.4 established that the driver
 * did not follow: a package plugin named by its source rather than by an
 * `id`. (What the probes found about MCP servers, the manager now follows
 * through the config file; see `opencodeMcp.test.ts`.)
 *
 * These go through the driver's public managers, over the verified fake, so
 * breaking the driver here is what a real server would show.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OpenCodePlugins } from '../plugins';
import { fakeOpenCode } from './fakeServer';

describe('plugins as 2.1.4 reports them', () => {
  it('matches a failed package by its source target, because a package entry has no id', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-plugins-'));
    const file = path.join(dir, 'opencode.json');
    await writeFile(file, JSON.stringify({ plugins: ['@acme/oc-plugin'] }));
    const server = fakeOpenCode({
      plugins: [
        {
          source: { type: 'package', target: '@acme/oc-plugin' },
          state: { status: 'failed', error: 'Plugin failed to load', ref: 'err_1' },
        },
      ],
    });
    const manager = new OpenCodePlugins(async () => server.client, () => [file]);
    const state = await manager.list();
    expect(state.installed).toEqual([
      { id: '@acme/oc-plugin', name: '@acme/oc-plugin', enabled: false, error: 'Plugin failed to load' },
    ]);
  });
});
