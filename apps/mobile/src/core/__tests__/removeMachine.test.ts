/**
 * core.removeMachine (Phase 2b) — the composition-root companion cleanup the
 * bare machinesStore.removeMachine can't do alone: sessions' transcripts
 * (memory + persisted rows) and unread marks go with the machine, and a
 * selection pointing at it resets instead of dangling.
 */
import { describe, expect, it } from 'vitest';
import type { RemoteSessionInfo } from '@codedeck/protocol';
import { createPhoneCore } from '../createPhoneCore';
import { memoryKV, memoryTranscriptStorage, type PhoneTransport } from '../ports';

const MACHINE = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

const nullTransport: PhoneTransport = {
  subscribe: () => ({ close: () => {} }),
  publish: async () => true,
};

const info = (id: string): RemoteSessionInfo => ({
  id,
  slug: id,
  cwd: `/x/${id}`,
  lastActivity: '2026-08-08T10:00:00.000Z',
  lineCount: 0,
  title: null,
  project: id,
});

describe('PhoneCore.removeMachine', () => {
  it('removes the machine, its transcripts (incl. persisted rows), unread marks, and the dangling selection', async () => {
    const storage = memoryTranscriptStorage();
    const core = await createPhoneCore({
      kv: memoryKV(),
      transport: nullTransport,
      transcriptStorage: storage,
    });
    core.machines.getState().registerMachine({ pubkeyHex: MACHINE, name: 'laptop' });
    core.machines.getState().registerMachine({ pubkeyHex: OTHER, name: 'other' });
    core.machines.getState().applySessionUpsert(MACHINE, info('s1'), 0);
    core.machines.getState().applySessionUpsert(OTHER, info('s9'), 0);

    // Transcript rows on both machines; unread + selection on the doomed one.
    const entry = (content: string) => ({
      entryType: 'text' as const,
      content,
      timestamp: '2026-08-08T10:00:00.000Z',
    });
    await core.transcript.getState().applyOutput(MACHINE, 's1', 1, entry('hello'));
    await core.transcript.getState().applyOutput(OTHER, 's9', 1, entry('other'));
    await core.flush();
    core.ui.getState().markSessionUnread(MACHINE, 's1');
    core.ui.getState().selectSession(MACHINE, 's1');
    core.ui.getState().markSessionUnread(MACHINE, 's1'); // re-mark after select cleared it

    await core.removeMachine(MACHINE);

    expect(core.machines.getState().machines[MACHINE]).toBeUndefined();
    expect(core.machines.getState().machines[OTHER]).toBeTruthy();
    expect(core.ui.getState().isSessionUnread(MACHINE, 's1')).toBe(false);
    expect(core.ui.getState().selectedMachine).toBeNull();
    expect(core.ui.getState().selectedSession).toBeNull();
    expect(core.transcript.getState().sessions[`${MACHINE} s1`]).toBeUndefined();
    // Persisted rows are gone too — a re-pair starts clean.
    expect(await storage.readRange(MACHINE, 's1', 1, 10)).toEqual([]);
    // The untouched machine keeps everything.
    expect((await storage.readRange(OTHER, 's9', 1, 10)).length).toBe(1);
  });

  it('leaves an unrelated selection alone', async () => {
    const core = await createPhoneCore({ kv: memoryKV(), transport: nullTransport });
    core.machines.getState().registerMachine({ pubkeyHex: MACHINE, name: 'laptop' });
    core.machines.getState().registerMachine({ pubkeyHex: OTHER, name: 'other' });
    core.machines.getState().applySessionUpsert(OTHER, info('s9'), 0);
    core.ui.getState().selectSession(OTHER, 's9');

    await core.removeMachine(MACHINE);

    expect(core.ui.getState().selectedMachine).toBe(OTHER);
    expect(core.ui.getState().selectedSession).toBe('s9');
  });
});
