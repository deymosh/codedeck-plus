/**
 * The commands OpenCode's terminal runs itself (compact, undo, redo), run
 * through its server API. V2 shares a conversation with nobody, so the
 * sharing pair it used to carry is gone.
 */
import { describe, expect, it, vi } from 'vitest';
import type { OpenCodeClient } from '@opencode/client';
import { SESSION_COMMANDS, sessionCommand, sessionSlashCommands, type SessionCommandContext } from '../sessionCommands';

const user = (id: string, text: string) => ({ id, type: 'user', text, time: { created: 0 } });

function context(revert?: string) {
  const session = {
    get: vi.fn().mockResolvedValue({ id: 'ses_1', ...(revert ? { revert: { messageID: revert } } : {}) }),
    compact: vi.fn().mockResolvedValue({}),
    revert: {
      stage: vi.fn().mockResolvedValue({ messageID: 'm3' }),
      clear: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
    },
  };
  const message = {
    list: vi.fn().mockResolvedValue({
      data: [user('m1', 'add a test'), user('m3', 'now rename it\nplease')],
      cursor: {},
    }),
  };
  const lines: string[] = [];
  const ctx: SessionCommandContext = {
    client: { session, message } as unknown as OpenCodeClient,
    sessionID: 'ses_1',
    model: { providerID: 'ccr', id: 'm' },
    status: (text) => lines.push(text),
  };
  return { ctx, session, message, lines };
}

const run = (name: string, ctx: SessionCommandContext) => SESSION_COMMANDS.find((c) => c.name === name)!.run(ctx);

describe('the built-in session commands', () => {
  it('undo takes back the last turn not yet undone', async () => {
    const { ctx, session, lines } = context();
    await run('undo', ctx);
    expect(session.revert.stage).toHaveBeenCalledWith({ sessionID: 'ses_1', messageID: 'm3', files: true });
    expect(lines.at(-1)).toMatch(/^Undid "now rename it" and the file changes/);

    const again = context('m3');
    await run('undo', again.ctx);
    expect(again.session.revert.stage).toHaveBeenCalledWith({ sessionID: 'ses_1', messageID: 'm1', files: true });

    const none = context('m1');
    await run('undo', none.ctx);
    expect(none.session.revert.stage).not.toHaveBeenCalled();
    expect(none.lines).toEqual(['Nothing to undo.']);
  });

  it('redo brings undone turns back, and says so when there are none', async () => {
    const undone = context('m3');
    await run('redo', undone.ctx);
    expect(undone.session.revert.clear).toHaveBeenCalledWith({ sessionID: 'ses_1' });
    const none = context();
    await run('redo', none.ctx);
    expect(none.session.revert.clear).not.toHaveBeenCalled();
    expect(none.lines).toEqual(['Nothing to redo.']);
  });

  it('compact asks the server to compact the conversation', async () => {
    const { ctx, session } = context();
    await run('compact', ctx);
    expect(session.compact).toHaveBeenCalledWith({ sessionID: 'ses_1' });
  });

  it('a failed call is an error naming what failed', async () => {
    const { ctx, session } = context();
    session.revert.stage.mockRejectedValue({ message: 'session is busy' });
    await expect(run('undo', ctx)).rejects.toThrow('OpenCode could not undo the last turn: session is busy');
  });

  it("gives way to a command of the server's with the same name", () => {
    expect(sessionCommand('undo', new Set())?.name).toBe('undo');
    expect(sessionCommand('undo', new Set(['undo']))).toBeUndefined();
    // No sharing command exists to be listed.
    expect(sessionSlashCommands(new Set()).map((c) => c.name)).toEqual(['compact', 'undo', 'redo']);
    expect(sessionSlashCommands(new Set(['compact'])).map((c) => c.name)).toEqual(['undo', 'redo']);
  });
});
