/**
 * nativeQuickPromptsStore — proves the adapter presents the SAME
 * `QuickPromptsStoreState` shape `createQuickPromptsStore` does: hydration
 * from `quickPromptsView()`, refresh on the quickPrompts slice's
 * `stateChanged`, and each mutator's dispatched `Intent`.
 */
import { describe, it, expect, vi } from 'vitest';
import { createNativeQuickPromptsStore } from '../stores/nativeQuickPrompts';
import type { CoreEvent, Intent, QuickPromptsView, SliceId } from '../nativeCoreTypes';
import type { NativeCore } from '../../platform/nativeCore';

function fakeCore(initialView: QuickPromptsView = { prompts: [] }) {
  let view: QuickPromptsView = initialView;
  const dispatched: Intent[] = [];
  let coreEventListener: ((e: CoreEvent) => void) | null = null;

  const core: NativeCore = {
    init: () => Promise.reject(new Error('unused')),
    start: () => Promise.reject(new Error('unused')),
    stop: () => Promise.reject(new Error('unused')),
    pause: () => Promise.reject(new Error('unused')),
    resume: () => Promise.reject(new Error('unused')),
    setOnline: () => Promise.reject(new Error('unused')),
    setMachines: () => Promise.reject(new Error('unused')),
    setRelays: () => Promise.reject(new Error('unused')),
    send: () => Promise.reject(new Error('unused')),
    publish: () => Promise.reject(new Error('unused')),
    connectionStatus: () => Promise.reject(new Error('unused')),
    onMessage: () => Promise.reject(new Error('unused')),
    onConnection: () => Promise.reject(new Error('unused')),
    onActionFailed: () => Promise.reject(new Error('unused')),
    onResume: () => Promise.resolve(() => {}),

    dispatch: vi.fn(async (intent: Intent) => {
      dispatched.push(intent);
    }),
    machinesView: () => Promise.reject(new Error('unused')),
    settingsView: () => Promise.reject(new Error('unused')),
    outboxView: () => Promise.reject(new Error('unused')),
    pairingView: () => Promise.reject(new Error('unused')),
    dmView: () => Promise.reject(new Error('unused')),
    marmotView: () => Promise.reject(new Error('unused')),
    quickPromptsView: vi.fn(async () => view),
    pendingSessionsView: () => Promise.reject(new Error('unused')),
    uiView: () => Promise.reject(new Error('unused')),
    transcriptView: () => Promise.reject(new Error('unused')),
    onCoreEvent: vi.fn(async (cb: (e: CoreEvent) => void) => {
      coreEventListener = cb;
      return () => {
        coreEventListener = null;
      };
    }),
  };

  return {
    core,
    dispatched,
    setView: (next: QuickPromptsView) => {
      view = next;
    },
    emitStateChanged: (slice: SliceId) => {
      coreEventListener?.({ stateChanged: { slice } });
    },
  };
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createNativeQuickPromptsStore', () => {
  it('hydrates from quickPromptsView() on creation', async () => {
    const { core } = fakeCore({ prompts: [{ id: 'qp-1', label: 'Go', text: 'continue' }] });
    const store = createNativeQuickPromptsStore({ core });
    await tick();

    expect(store.getState().prompts).toEqual([{ id: 'qp-1', label: 'Go', text: 'continue' }]);
  });

  it('addPrompt dispatches addQuickPrompt with a generated id', async () => {
    const { core, dispatched } = fakeCore();
    const store = createNativeQuickPromptsStore({ core });
    await tick();

    store.getState().addPrompt('Go', 'continue');
    expect(dispatched).toHaveLength(1);
    const intent = dispatched[0] as { addQuickPrompt: { id: string; label: string; text: string } };
    expect(intent.addQuickPrompt.label).toBe('Go');
    expect(intent.addQuickPrompt.text).toBe('continue');
    expect(intent.addQuickPrompt.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('updatePrompt dispatches updateQuickPrompt', async () => {
    const { core, dispatched } = fakeCore();
    const store = createNativeQuickPromptsStore({ core });
    await tick();

    store.getState().updatePrompt('qp-1', 'New label', 'new text');
    expect(dispatched).toEqual([{ updateQuickPrompt: { id: 'qp-1', label: 'New label', text: 'new text' } }]);
  });

  it('removePrompt dispatches removeQuickPrompt', async () => {
    const { core, dispatched } = fakeCore();
    const store = createNativeQuickPromptsStore({ core });
    await tick();

    store.getState().removePrompt('qp-1');
    expect(dispatched).toEqual([{ removeQuickPrompt: { id: 'qp-1' } }]);
  });

  it('a stateChanged("quickPrompts") core event re-fetches the view', async () => {
    const { core, setView, emitStateChanged } = fakeCore();
    const store = createNativeQuickPromptsStore({ core });
    await tick();

    setView({ prompts: [{ id: 'qp-2', label: 'Test', text: 'run tests' }] });
    emitStateChanged('quickPrompts');
    await tick();

    expect(store.getState().prompts).toEqual([{ id: 'qp-2', label: 'Test', text: 'run tests' }]);
  });

  it('a stateChanged for a different slice does not trigger a refresh', async () => {
    const { core, setView, emitStateChanged } = fakeCore();
    const store = createNativeQuickPromptsStore({ core });
    await tick();

    setView({ prompts: [{ id: 'qp-2', label: 'Test', text: 'run tests' }] });
    emitStateChanged('settings');
    await tick();

    expect(store.getState().prompts).toEqual([]);
  });
});
