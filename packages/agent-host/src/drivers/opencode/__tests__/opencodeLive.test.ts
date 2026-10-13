/**
 * The OpenCode driver against a REAL OpenCode v2 server running a free
 * model â€” the check that every feature the driver offers is still served by
 * the server, which no fixture can answer.
 *
 * Skipped unless CODEDECK_OPENCODE_LIVE=1, and needs a binary: point
 * CODEDECK_OPENCODE_PATH at the v2 `opencode`, or have one on PATH. The
 * free OpenCode Zen models need no credential, so nothing here spends
 * anything.
 *
 * Run with:  CODEDECK_OPENCODE_LIVE=1 CODEDECK_OPENCODE_PATH=<bin> vitest run src/drivers/opencode/__tests__/opencodeLive.test.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SessionContext } from '../../../sdk/driver';
import type { OutputEntry, PermissionRequest, QuestionSpec } from '../../../sdk/types';
import { OpenCodeDriver } from '../driver';

const LIVE = process.env.CODEDECK_OPENCODE_LIVE === '1';

/** A SessionContext that records everything the driver reports and answers
 *  every ask the way the bridge would. */
function recorder() {
  const entries: OutputEntry[] = [];
  const permissions: PermissionRequest[] = [];
  const questions: Array<{ toolUseId: string; specs: QuestionSpec[] }> = [];
  const states: string[] = [];
  const logs: string[] = [];
  /** What a permission ask is answered with: the bridge's own option id —
   *  the driver maps `allow` onto OpenCode's `once`. */
  let answer = 'allow';
  const ctx: SessionContext = {
    sessionId: 'live-session',
    emit: (event) => {
      if (event.type === 'entries') entries.push(...event.entries);
      if (event.type === 'turn') states.push(event.state);
    },
    log: (message) => logs.push(message),
    requestPermission: async (request) => {
      permissions.push(request as PermissionRequest);
      return { outcome: 'selected', optionId: answer };
    },
    askQuestion: async (toolUseId, specs) => {
      questions.push({ toolUseId, specs });
      // Choose the first option offered, the way a user tapping the card
      // would; an empty answer would prove nothing.
      return {
        outcome: 'answered',
        answers: specs.map((spec) => {
          const first = spec.options?.[0];
          return { type: 'selected' as const, labels: [first ? first.label : 'ok'] };
        }),
      };
    },
    requestPlanApproval: async () => ({ outcome: 'cancelled' as const, reason: 'unused' }),
  };
  return {
    ctx,
    entries,
    permissions,
    questions,
    states,
    logs,
    setAnswer: (option: string) => {
      answer = option;
    },
    text: () => entries.filter((e) => e.entryType === 'text').map((e) => (e as { text: string }).text).join('\n'),
    tools: () => entries.filter((e) => e.entryType === 'tool_call').map((e) => (e as { toolName: string }).toolName),
    results: () => entries.filter((e) => e.entryType === 'tool_result'),
    errors: () => entries.filter((e) => e.entryType === 'error').map((e) => (e as { text: string }).text),
    diffs: () => entries.filter((e) => e.entryType === 'diff').map((e) => (e as { path: string }).path),
    ready: () => new Promise<void>((resolve) => {
      const tick = setInterval(() => {
        if (states.includes('idle') && entries.length > 0) {
          clearInterval(tick);
          resolve();
        }
      }, 250);
      setTimeout(() => {
        clearInterval(tick);
        resolve();
      }, 90_000);
    }),
  };
}

const cwd = mkdtempSync(path.join(tmpdir(), 'cdx-live-'));

describe.skipIf(!LIVE)('OpenCode driver against a live v2 server', () => {
  const driver = LIVE
    ? OpenCodeDriver.create({
        autoStart: true,
        installOpenCode: async () => {
          throw new Error('no binary found: set CODEDECK_OPENCODE_PATH');
        },
        log: () => {},
      })
    : null;

  afterAll(async () => {
    await driver?.then((d) => d.shutdown());
  });

  it('reports the catalog, modes and supports the phone relies on', async () => {
    const d = await driver!;
    const info = d.info();
    expect(info.id).toBe('opencode');
    expect(info.supports).toMatchObject({ models: true, usage: true, commands: true, plugins: true, mcp: true, tasks: true });

    const catalog = await d.listModels();
    expect(catalog.models.length).toBeGreaterThan(0);
    // A free model is what the live checks run on; the account pays nothing.
    expect(catalog.defaultModel).toBeTruthy();
    expect(Object.keys(catalog.contextLimits ?? {}).length).toBeGreaterThan(0);
  }, 120_000);

  it('runs a prompt end to end: text, turn states, usage, and no errors', async () => {
    const d = await driver!;
    const rec = recorder();
    const session = d.startSession({ sessionId: 'live', agent: 'opencode', cwd, mode: 'default' }, rec.ctx);
    session.prompt('Reply with exactly: codedeck-live-ok');
    await rec.ready();

    expect(rec.errors()).toEqual([]);
    expect(rec.text().toLowerCase()).toContain('codedeck-live-ok');
    expect(rec.states).toContain('running');
    expect(rec.states).toContain('idle');

    const usage = await session.getUsage();
    expect(usage?.available).toBe(true);
    await session.end();
  }, 180_000);

  it('asks the phone for permission and runs the tool when allowed', async () => {
    const d = await driver!;
    const rec = recorder();
    // Ask mode, so a shell command has to be approved; this is the path the
    // phone's permission card rides on.
    const session = d.startSession({ sessionId: 'live', agent: 'opencode', cwd, mode: 'ask' }, rec.ctx);
    session.prompt('Use the shell tool to run exactly: echo codedeck-permission-ok');
    await rec.ready();

    expect(rec.tools()).toContain('shell');
    expect(rec.results().length).toBeGreaterThan(0);
    // The card itself, not just the tool: if OpenCode never asks, Ask mode
    // silently runs everything and the phone has nothing to approve.
    expect(rec.permissions.length).toBeGreaterThan(0);
    expect(rec.errors()).toEqual([]);
    await session.end();
  }, 180_000);

  it('answers a question the model asks through a form', async () => {
    const d = await driver!;
    const rec = recorder();
    const session = d.startSession({ sessionId: 'live', agent: 'opencode', cwd, mode: 'default' }, rec.ctx);
    session.prompt(
      'You must call the question tool now. Ask exactly one question: "Which colour do you prefer?" with options "Red" and "Blue". Do not answer it yourself and do not use any other tool first.',
    );
    await rec.ready();

    expect(rec.questions.length).toBeGreaterThan(0);
    expect(rec.questions[0]?.specs[0]?.options?.length ?? 0).toBeGreaterThan(0);
    expect(rec.errors()).toEqual([]);
    await session.end();
  }, 180_000);

  it('lists commands, MCP servers and plugins without failing', async () => {
    const d = await driver!;
    const rec = recorder();
    const session = d.startSession({ sessionId: 'live', agent: 'opencode', cwd, mode: 'default' }, rec.ctx);

    const commands = await session.listCommands!();
    expect(commands.map((c) => c.name)).toEqual(expect.arrayContaining(['compact', 'undo', 'redo']));
    // V2 does not share a conversation, so those built-ins are gone.
    expect(commands.map((c) => c.name)).not.toContain('share');

    const mcp = await session.mcpStatus!();
    expect(mcp.projectWide).toBe(true);
    expect(Array.isArray(mcp.servers)).toBe(true);

    const plugins = await d.plugins.list(true);
    expect(Array.isArray(plugins.installed)).toBe(true);

    const servers = await d.mcp.list();
    expect(Array.isArray(servers.servers)).toBe(true);
    await session.end();
  }, 120_000);

  it('interrupts a running turn and deletes the conversation', async () => {
    const d = await driver!;
    const rec = recorder();
    const session = d.startSession({ sessionId: 'live', agent: 'opencode', cwd, mode: 'default' }, rec.ctx);
    session.prompt('Count from 1 to 400 slowly, one number per line.');
    await new Promise((r) => setTimeout(r, 6_000));
    await session.interrupt();
    await new Promise((r) => setTimeout(r, 4_000));
    expect(rec.errors()).toEqual([]);
    await session.end();
  }, 180_000);
});
