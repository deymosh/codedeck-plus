/**
 * The rows CodeDeck adds to a harness profile on top of its bundles — the
 * question tool, which no automation profile mounts by itself — and how they
 * share the profile's patch layer with the bridge plugin's own block.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HARNESS_PLUGIN, installHarnessPlugin } from '../plugin';
import { ASK_USER_TOOL, installProfileTools } from '../profileTools';

const fresh = (): string => mkdtempSync(path.join(tmpdir(), 'codedeck-dsh-tools-'));
const layerOf = (dir: string): string => readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8');

describe('the tools a profile needs', () => {
  it('mounts the question tool, naming the harness package that provides it', async () => {
    const dir = fresh();
    writeFileSync(path.join(dir, 'cordis.patch.yml'), "# a person's own layer\n[]\n");
    await installProfileTools(dir, () => {});
    const layer = layerOf(dir);
    expect(layer).toMatch(/- id: tool-ask-user/);
    expect(layer).toContain(`name: '${ASK_USER_TOOL}'`);
    // The harness's own package: a row naming it resolves from the harness's
    // installation, so nothing has to be installed into the profile.
    expect(ASK_USER_TOOL).toBe('@deepseek-ai/dsh-tool-ask-user');
    // What the profile already had is untouched.
    expect(layer).toMatch(/a person's own layer/);
  });

  it('leaves the layer alone when its block is already right', async () => {
    const dir = fresh();
    await installProfileTools(dir, () => {});
    const first = layerOf(dir);
    await installProfileTools(dir, () => {});
    expect(layerOf(dir)).toBe(first);
  });

  it('keeps its block and the bridge plugin\'s block apart', async () => {
    const dir = fresh();
    // What a start does: both blocks, every time. The second start must find
    // the layer exactly as the first left it — blocks replaced where they
    // stand, never re-appended, since a file that grows on every start grows
    // without end.
    const start = async (): Promise<string> => {
      await installHarnessPlugin(dir, () => {});
      await installProfileTools(dir, () => {});
      return layerOf(dir);
    };
    const first = await start();
    expect(first).toMatch(/- id: codedeck-bridge/);
    expect(first).toContain(`name: '${HARNESS_PLUGIN}'`);
    expect(first).toMatch(/- id: tool-ask-user/);
    expect(await start()).toBe(first);
    expect(await start()).toBe(first);
  });
});
