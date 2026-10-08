/**
 * The commands OpenCode's terminal runs itself (compact, undo, redo,
 * share), run through its server API.
 */
import { describe, expect, it, vi } from 'vitest';
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import { SESSION_COMMANDS, sessionCommand, sessionSlashCommands, type SessionCommandContext } from '../sessionCommands';

const user = (id: string, text: string) => ({ info: { id, role: 'user' }, parts: [{ type: 'text', text }] });
const assistant = (id: string) => ({ info: { id, role: 'assistant' }, parts: [{ type: 'text', text: 'done' }] });

function context(revert?: string) {
  const session = {
    messages: vi.fn().mockResolvedValue({ data: [user('m1', 'add a test'), assistant('m2'), user('m3', 'now rename it\nplease'), assistant('m4')] }),
    get: vi.fn().mockResolvedValue({ data: { id: 'ses_1', ...(revert ? { revert: { messageID: revert } } : {}) } }),
    revert: vi.fn().mockResolvedValue({ data: {} }),
    unrevert: vi.fn().mockResolvedValue({ data: {} }),
    summarize: vi.fn().mockResolvedValue({ data: true }),
    share: vi.fn().mockResolvedValue({ data: { share: { url: 'https://opncd.ai/s/abc' } } }),
    unshare: vi.fn().mockResolvedValue({ data: {} }),
  };
  const lines: string[] = [];
  const ctx: SessionCommandContext = {
    client: { session } as unknown as OpencodeClient,
    sessionID: 'ses_1',
    directory: '/w',
    model: { providerID: 'ccr', modelID: 'm' },
    status: (text) => lines.push(text),
  };
  return { ctx, session, lines };
}

const run = (name: string, ctx: SessionCommandContext) => SESSION_COMMANDS.find((c) => c.name === name)!.run(ctx);

describe('the built-in session commands', () => {
  it('undo takes back the last turn not yet undone', async () => {
    const { ctx, session, lines } = context();
    await run('undo', ctx);
    expect(session.revert).toHaveBeenCalledWith({ sessionID: 'ses_1', directory: '/w', messageID: 'm3' });
    expect(lines.at(-1)).toMatch(/^Undid "now rename it" and the file changes/);

    const again = context('m3');
    await run('undo', again.ctx);
    expect(again.session.revert).toHaveBeenCalledWith({ sessionID: 'ses_1', directory: '/w', messageID: 'm1' });

    const none = context('m1');
    await run('undo', none.ctx);
    expect(none.session.revert).not.toHaveBeenCalled();
    expect(none.lines).toEqual(['Nothing to undo.']);
  });

  it('redo brings undone turns back, and says so when there are none', async () => {
    const undone = context('m3');
    await run('redo', undone.ctx);
    expect(undone.session.unrevert).toHaveBeenCalled();
    const none = context();
    await run('redo', none.ctx);
    expect(none.session.unrevert).not.toHaveBeenCalled();
    expect(none.lines).toEqual(['Nothing to redo.']);
  });

  it("compact summarizes on the session's model; share names the link", async () => {
    const { ctx, session, lines } = context();
    await run('compact', ctx);
    expect(session.summarize).toHaveBeenCalledWith({ sessionID: 'ses_1', directory: '/w', providerID: 'ccr', modelID: 'm' });
    await run('share', ctx);
    expect(lines.at(-1)).toContain('https://opncd.ai/s/abc');
  });

  it('a failed call is an error naming what failed', async () => {
    const { ctx, session } = context();
    session.revert.mockResolvedValue({ error: { data: { message: 'session is busy' } } });
    await expect(run('undo', ctx)).rejects.toThrow('OpenCode could not undo the last turn: {"message":"session is busy"}');
  });

  it("gives way to a command of the server's with the same name", () => {
    expect(sessionCommand('undo', new Set())?.name).toBe('undo');
    expect(sessionCommand('undo', new Set(['undo']))).toBeUndefined();
    expect(sessionSlashCommands(new Set(['share'])).map((c) => c.name)).toEqual(['compact', 'undo', 'redo', 'unshare']);
  });
});
