/**
 * quickPromptsStore (CDX-049) — CRUD + KV persistence round-trip + garbage
 * hydrate, the legacy quickPromptStore's contract on this repo's store
 * pattern (hydrate + save through the KV port).
 */
import { describe, expect, it } from 'vitest';
import { memoryKV } from '../ports';
import {
  createQuickPromptsStore,
  hydrateQuickPrompts,
  loadPersistedQuickPrompts,
  type QuickPromptsStoreDeps,
} from '../stores/quickPrompts';

function harness() {
  const kv = memoryKV();
  let id = 0;
  const deps: QuickPromptsStoreDeps = { kv, newId: () => `qp-${++id}` };
  const store = createQuickPromptsStore(deps);
  return { kv, store };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('quickPromptsStore (CDX-049)', () => {
  it('add / update / remove, with trimming and empty-field rejection', () => {
    const { store } = harness();

    store.getState().addPrompt('  Continue  ', '  Keep going with the plan.  ');
    expect(store.getState().prompts).toEqual([
      { id: 'qp-1', label: 'Continue', text: 'Keep going with the plan.' },
    ]);

    // Blank label or text never creates/updates an entry.
    store.getState().addPrompt('   ', 'text');
    store.getState().addPrompt('label', '   ');
    expect(store.getState().prompts).toHaveLength(1);

    store.getState().updatePrompt('qp-1', 'Go on', 'Continue exactly where you left off.');
    expect(store.getState().prompts[0]).toEqual({
      id: 'qp-1',
      label: 'Go on',
      text: 'Continue exactly where you left off.',
    });
    store.getState().updatePrompt('qp-1', '', 'x'); // rejected, unchanged
    expect(store.getState().prompts[0]!.label).toBe('Go on');
    store.getState().updatePrompt('nope', 'a', 'b'); // unknown id → no-op
    expect(store.getState().prompts).toHaveLength(1);

    store.getState().removePrompt('qp-1');
    expect(store.getState().prompts).toEqual([]);
    store.getState().removePrompt('qp-1'); // second remove is a no-op
  });

  it('round-trips through the KV: mutate → persist → hydrate on next boot', async () => {
    const { kv, store } = harness();
    store.getState().addPrompt('Tests', 'Run the whole test suite and report counts.');
    store.getState().addPrompt('Ship', 'Commit with a conventional message.');
    store.getState().removePrompt(store.getState().prompts[0]!.id);
    await flush();

    const rebooted = await loadPersistedQuickPrompts(kv);
    expect(rebooted).toEqual([
      { id: 'qp-2', label: 'Ship', text: 'Commit with a conventional message.' },
    ]);
    // A store seeded with the hydrated list carries on where the last run stopped.
    const store2 = createQuickPromptsStore({ kv, newId: () => 'qp-9' }, rebooted);
    expect(store2.getState().prompts).toHaveLength(1);
  });

  it('hydrate tolerates garbage: bad JSON, non-arrays, malformed entries', () => {
    expect(hydrateQuickPrompts(undefined)).toEqual([]);
    expect(hydrateQuickPrompts('not json')).toEqual([]);
    expect(hydrateQuickPrompts(JSON.stringify({ a: 1 }))).toEqual([]);
    expect(
      hydrateQuickPrompts(
        JSON.stringify([
          { id: 'ok', label: 'L', text: 'T' },
          { id: '', label: 'no-id', text: 'x' },
          { id: 'no-text', label: 'x' },
          'garbage',
          null,
        ]),
      ),
    ).toEqual([{ id: 'ok', label: 'L', text: 'T' }]);
  });
});
