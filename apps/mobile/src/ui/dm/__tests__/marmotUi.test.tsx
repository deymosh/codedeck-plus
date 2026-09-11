// @vitest-environment jsdom
/**
 * Marmot UI (Phase 6, CDX-012): the unified conversation list carries BOTH
 * protocols with per-row tags, pending welcome cards accept into a joined
 * conversation, the start-chat sheet offers the Marmot path (with an honest
 * failure message when it cannot), and the MarmotChatScreen renders
 * MLS-tagged bubbles over the marmot store.
 *
 * The MDK/MLS engine this file used to drive through a fake `MarmotPlatform`
 * seam (KeyPackage lookup, welcome accept, group message send/ingest) is
 * `client_runtime`'s `MarmotEngineImpl` now — see that crate's own tests for
 * the engine itself. `nativeMarmot.ts` also DOCUMENTS a real, deliberate
 * simplification worth keeping visible here: `startChat`'s distinct
 * `'no-key-package'`/`'failed'` outcomes collapse into a single `'failed'`
 * (nothing in `CoreEvent::ActionFailed` distinguishes them yet), so the UI's
 * old "no published Marmot KeyPackage" copy no longer has a path that
 * produces it — the generic failure message does instead.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { buildFakePhoneCore, tick } from '../../../core/__tests__/nativeCoreFixture';
import type { FakeNativeCore } from '../../../core/__tests__/nativeCoreFixture';
import { generateKeypair } from '../../../core/crypto';
import type { MarmotView } from '../../../core/nativeCoreTypes';
import { PhoneCoreProvider } from '../../coreContext';
import { DmSection } from '../../DmSection';
import { MarmotChatScreen } from '../MarmotChatScreen';

afterEach(cleanup);

const WELCOMER = 'a'.repeat(64);

function emptyMarmotView(available = true): MarmotView {
  return {
    available,
    conversations: [],
    messages: {},
    activeGroup: null,
    eventsReceived: 0,
    ignored: 0,
    errors: 0,
    buffered: 0,
    pendingWelcomes: {},
  };
}

/** Scripts the Intents this UI actually dispatches, the way a real
 *  `client_runtime::Core` (backed by `MarmotEngineImpl`) would settle them. */
function wireMarmot(fake: FakeNativeCore, opts: { acceptSucceeds?: boolean } = {}): void {
  const acceptSucceeds = opts.acceptSucceeds ?? true;
  fake.onDispatch((intent) => {
    if (typeof intent !== 'object') return;
    const view = fake.views.marmot ?? emptyMarmotView();
    if ('acceptMarmotWelcome' in intent && acceptSucceeds) {
      const { welcomeId } = intent.acceptMarmotWelcome;
      const welcome = view.pendingWelcomes[welcomeId];
      if (!welcome) return;
      const { [welcomeId]: _accepted, ...restWelcomes } = view.pendingWelcomes;
      fake.setView('marmot', {
        ...view,
        pendingWelcomes: restWelcomes,
        conversations: [
          ...view.conversations,
          {
            groupId: welcome.groupId,
            hTag: welcome.hTag,
            peerPubkey: welcome.welcomer,
            name: welcome.name,
            memberCount: welcome.memberCount,
            lastMessageAt: Date.now(),
            unreadCount: 0,
            lastPreview: '',
          },
        ],
      });
    } else if ('selectMarmotGroup' in intent) {
      const { groupId } = intent.selectMarmotGroup;
      if (!groupId) return;
      fake.setView('marmot', {
        ...view,
        conversations: view.conversations.map((c) => (c.groupId === groupId ? { ...c, unreadCount: 0 } : c)),
      });
    } else if ('sendMarmotMessage' in intent) {
      const { groupId, text } = intent.sendMarmotMessage;
      const existing = view.messages[groupId] ?? [];
      fake.setView('marmot', {
        ...view,
        messages: {
          ...view.messages,
          [groupId]: [
            ...existing,
            { id: `r${existing.length + 1}`, groupId, senderPubkey: 'phone', content: text, at: Date.now(), status: 'sent' },
          ],
        },
      });
    }
  });
}

describe('unified list + welcome cards', () => {
  it('shows both protocols with badges, and Accept turns an invite into a Marmot conversation', async () => {
    const nip17Peer = generateKeypair().pubkeyHex;
    const { phone: core, fake } = await buildFakePhoneCore({
      dm: {
        conversations: [{ peerPubkey: nip17Peer, protocol: 'nip17', lastMessageAt: Date.now(), unreadCount: 0, lastPreview: '' }],
        messages: {},
        activePeer: null,
        eventsReceived: 0,
        unwrapFailures: 0,
        invalidRumors: 0,
      },
      marmot: {
        ...emptyMarmotView(),
        pendingWelcomes: {
          w1: { welcomeId: 'w1', wrapperId: '1'.repeat(64), groupId: 'g1', hTag: 'h1', name: 'CodeDeck DM', welcomer: WELCOMER, memberCount: 2 },
        },
      },
    });
    wireMarmot(fake);

    render(
      <PhoneCoreProvider value={core}>
        <DmSection />
      </PhoneCoreProvider>,
    );

    // The pending welcome surfaces as an invite card.
    const card = screen.getByTestId('marmot-welcome-card');
    expect(card.textContent).toContain('Marmot (MLS) chat invite');

    // Accept → joined conversation appears in the SAME list, MLS-tagged.
    await act(async () => {
      fireEvent.click(screen.getByText('Accept'));
      await tick();
    });
    expect(core.marmot.getState().conversations['g1']).toBeTruthy();

    const rows = screen.getByTestId('dm-section').querySelectorAll('[data-protocol]');
    expect(rows).toHaveLength(2);
    const protocols = [...rows].map((r) => r.getAttribute('data-protocol')).sort();
    expect(protocols).toEqual(['marmot', 'nip17']);

    const badges = screen.getAllByTestId('protocol-badge').map((b) => b.textContent);
    expect(badges).toContain('MLS');
    expect(badges).toContain('NIP-17');

    // Tapping the Marmot row selects the group (panelMode flips to marmot,
    // optimistically local — see nativeMarmot.ts's `setActiveGroup`).
    const marmotRow = [...rows].find((r) => r.getAttribute('data-protocol') === 'marmot')!;
    fireEvent.click(marmotRow as HTMLElement);
    expect(core.ui.getState().panelMode).toBe('marmot');
    expect(core.ui.getState().activeMarmotGroup).toBe('g1');
  });

  it('the start sheet offers Marmot when available and surfaces a failure honestly when the chat cannot start', async () => {
    const { phone: core, fake } = await buildFakePhoneCore({ marmot: emptyMarmotView(true) });
    wireMarmot(fake); // no startMarmotChat handler → the lookup never succeeds
    expect(core.marmot.getState().available).toBe(true);

    render(
      <PhoneCoreProvider value={core}>
        <DmSection />
      </PhoneCoreProvider>,
    );
    fireEvent.click(screen.getByLabelText('New message'));
    const marmotBtn = screen.getByTestId('start-marmot');
    expect(marmotBtn.textContent).toContain('Marmot (MLS)');

    const peer = generateKeypair();
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(/npub/), {
        target: { value: peer.pubkeyHex },
      });
      fireEvent.click(marmotBtn);
      await tick();
    });
    // `startChat`'s collapsed 'failed' reason (see this file's module doc).
    expect(screen.getByText('Could not start the Marmot chat — try again')).toBeTruthy();
  });
});

describe('MarmotChatScreen', () => {
  it('renders MLS-tagged bubbles, marks read on open, sends via the engine', async () => {
    const { phone: core, fake } = await buildFakePhoneCore({
      marmot: {
        ...emptyMarmotView(),
        conversations: [
          { groupId: 'g1', hTag: 'h1', peerPubkey: WELCOMER, name: 'CodeDeck DM', memberCount: 2, lastMessageAt: Date.now(), unreadCount: 1, lastPreview: 'hello over MLS' },
        ],
        messages: {
          g1: [{ id: 'r1', groupId: 'g1', senderPubkey: WELCOMER, content: 'hello over MLS', at: Date.now(), status: 'delivered' }],
        },
      },
    });
    wireMarmot(fake);
    expect(core.marmot.getState().conversations['g1']!.unreadCount).toBe(1);

    render(
      <PhoneCoreProvider value={core}>
        <MarmotChatScreen groupId="g1" />
      </PhoneCoreProvider>,
    );
    expect(screen.getByText('hello over MLS')).toBeTruthy();
    expect(screen.getByTestId('protocol-badge').textContent).toBe('MLS');
    // Opening selected the group, which the Router treats as reading it.
    await act(async () => {
      await tick();
    });
    expect(core.marmot.getState().conversations['g1']!.unreadCount).toBe(0);
    expect(core.marmot.getState().activeGroup).toBe('g1');

    // Sending dispatches Intent::SendMarmotMessage and the reply lands.
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hi back' } });
      fireEvent.click(screen.getByText('Send'));
      await tick();
    });
    expect(screen.getByText('hi back')).toBeTruthy();
  });
});
