// @vitest-environment jsdom
/**
 * DM UI (Phase 5b): the rebuilt bottom bar (ONE flex component — all controls
 * are direct children, no nested control columns; the old icon-layout bug's
 * structural fix), conversation-list ordering + unread badges, and the chat
 * screen's failed-send retry affordance.
 *
 * Two real cores exchanging an actual NIP-17 gift-wrap over a fake transport
 * was the old local composition's own crypto — dead now (Rust owns DM
 * unwrap/ingest entirely; `createNativeDmStore`'s `ingest` is a documented
 * no-op). Every scenario below seeds the fake core's `dm`/`ui` views with the
 * state a real exchange would have produced, and scripts `onDispatch` for the
 * two Intents this screen actually sends (`startDmConversation`,
 * `selectDmPeer`) to react the way `client_runtime::Core` would.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { buildFakePhoneCore, tick } from '../../../core/__tests__/nativeCoreFixture';
import type { FakeNativeCore } from '../../../core/__tests__/nativeCoreFixture';
import { generateKeypair } from '../../../core/crypto';
import { parsePeerInput } from '../../../core/stores/dm';
import type { DmView } from '../../../core/nativeCoreTypes';
import { PhoneCoreProvider } from '../../coreContext';
import { DmBottomBar } from '../DmBottomBar';
import { DmChatScreen } from '../DmChatScreen';
import { DmSection } from '../../DmSection';
import { relativeTime } from '../../relativeTime';

afterEach(cleanup);

function emptyDmView(): DmView {
  return { conversations: [], messages: {}, activePeer: null, eventsReceived: 0, unwrapFailures: 0, invalidRumors: 0 };
}

/** Scripts the two dispatches this screen/section actually send, the way a
 *  real `client_runtime::Core` round trip would settle them. */
function wireDm(fake: FakeNativeCore): void {
  fake.onDispatch((intent) => {
    if (typeof intent !== 'object') return;
    if (intent.startDmConversation) {
      const peer = parsePeerInput(intent.startDmConversation.peerInput);
      if (!peer) return;
      const view = fake.views.dm ?? emptyDmView();
      if (view.conversations.some((c) => c.peerPubkey === peer)) return;
      fake.setView('dm', {
        ...view,
        conversations: [
          ...view.conversations,
          { peerPubkey: peer, protocol: 'nip17', lastMessageAt: Date.now(), unreadCount: 0, lastPreview: '' },
        ],
      });
    } else if (intent.selectDmPeer) {
      const { peer } = intent.selectDmPeer;
      const view = fake.views.dm ?? emptyDmView();
      if (!peer || !(peer in Object.fromEntries(view.conversations.map((c) => [c.peerPubkey, c])))) return;
      fake.setView('dm', {
        ...view,
        conversations: view.conversations.map((c) => (c.peerPubkey === peer ? { ...c, unreadCount: 0 } : c)),
      });
    }
  });
}

async function makeCore(dm: DmView = emptyDmView()) {
  const { phone, fake } = await buildFakePhoneCore({ dm });
  wireDm(fake);
  return { core: phone, fake };
}

describe('DmBottomBar (the rebuilt bar)', () => {
  it('is ONE flex component: textarea and send button are direct children of the bar', () => {
    render(<DmBottomBar onSend={() => {}} />);
    const bar = screen.getByTestId('dm-bottom-bar');
    expect(bar.className).toContain('bar');
    // All controls sit directly in the single flex row — no nested control
    // columns (the old layout's .left-controls/.right-controls disease).
    // 5c added the mic button — as another DIRECT child, keeping the invariant.
    expect(bar.children).toHaveLength(3);
    expect(bar.children[0]!.tagName).toBe('TEXTAREA');
    expect(bar.children[1]!.tagName).toBe('BUTTON');
    expect(bar.children[1]!.getAttribute('aria-label')).toBe('Dictate with voice');
    expect(bar.children[2]!.tagName).toBe('BUTTON');
    expect(bar.children[2]!.textContent).toBe('Send');
  });

  it('send is disabled while empty, enabled with text, clears + calls onSend on tap', () => {
    const sent: string[] = [];
    render(<DmBottomBar onSend={(text) => sent.push(text)} />);
    const textarea = screen.getByLabelText('Message') as HTMLTextAreaElement;
    const button = screen.getByText('Send') as HTMLButtonElement;

    expect(button.disabled).toBe(true);
    fireEvent.change(textarea, { target: { value: '  hello there  ' } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(sent).toEqual(['hello there']); // trimmed
    expect(textarea.value).toBe('');
    expect(button.disabled).toBe(true);
  });

  it('disabled prop disables both controls', () => {
    render(<DmBottomBar onSend={() => {}} disabled />);
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByText('Send') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('DmSection (Phase 2b sidebar section — the DM list surface)', () => {
  it('orders conversations newest-first and shows unread badges', async () => {
    const olderPeer = generateKeypair().pubkeyHex;
    const senderHex = generateKeypair().pubkeyHex;
    const { core } = await makeCore({
      ...emptyDmView(),
      conversations: [
        { peerPubkey: olderPeer, protocol: 'nip17', lastMessageAt: Date.now() - 3_600_000, unreadCount: 0, lastPreview: '' },
        { peerPubkey: senderHex, protocol: 'nip17', lastMessageAt: Date.now(), unreadCount: 1, lastPreview: 'newest message' },
      ],
      messages: {
        [senderHex]: [{ id: 'm1', peerPubkey: senderHex, senderPubkey: senderHex, content: 'newest message', at: Date.now(), status: 'delivered' }],
      },
    });

    const onSelected = vi.fn();
    render(
      <PhoneCoreProvider value={core}>
        <DmSection onConversationSelected={onSelected} />
      </PhoneCoreProvider>,
    );

    const rows = screen.getByTestId('dm-section').querySelectorAll('[data-protocol]');
    expect(rows).toHaveLength(2);
    // Newest (the incoming message) first; every row carries the Phase-6 seam.
    expect(rows[0]!.getAttribute('data-protocol')).toBe('nip17');
    expect(rows[0]!.textContent).toContain('newest message');
    expect(rows[1]!.textContent).not.toContain('newest message');

    const badge = screen.getByTestId('unread-badge');
    expect(badge.textContent).toBe('1');

    // Tapping a tile selects the DM in the ui store (panelMode flips so the
    // MainPanel shows the chat) and fires the drawer-close callback.
    fireEvent.click(rows[0]! as HTMLElement);
    expect(core.ui.getState().panelMode).toBe('dm');
    expect(core.ui.getState().activeDmPeer).toBe(senderHex);
    expect(onSelected).toHaveBeenCalledOnce();
  });

  it('rejects invalid new-DM input with a visible error; a valid one opens the chat', async () => {
    const { core } = await makeCore();
    render(
      <PhoneCoreProvider value={core}>
        <DmSection />
      </PhoneCoreProvider>,
    );
    fireEvent.click(screen.getByLabelText('New message'));
    fireEvent.change(screen.getByPlaceholderText(/npub/), { target: { value: 'not-a-key' } });
    fireEvent.click(screen.getByText('Start conversation'));
    expect(screen.getByText('Not a valid npub or hex pubkey')).toBeTruthy();

    const peer = generateKeypair();
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(/npub/), {
        target: { value: peer.pubkeyHex },
      });
      fireEvent.click(screen.getByText('Start conversation'));
      await tick();
    });
    expect(core.ui.getState().panelMode).toBe('dm');
    expect(core.ui.getState().activeDmPeer).toBe(peer.pubkeyHex);
    // The input closed and the new conversation renders as a tile.
    expect(screen.queryByPlaceholderText(/npub/)).toBeNull();
    expect(screen.getAllByTestId('dm-tile')).toHaveLength(1);
  });

  it('empty state renders; the connection dot is always on (client-runtime owns the one socket)', async () => {
    const { core } = await makeCore();
    render(
      <PhoneCoreProvider value={core}>
        <DmSection />
      </PhoneCoreProvider>,
    );
    expect(screen.getByText('No conversations yet.')).toBeTruthy();
    // `DmStoreState.subscribed` is hardcoded `true` on the native adapter —
    // there is no separate "DM subscription" to toggle from TS any more (see
    // nativeDm.ts's module doc); the dot no longer distinguishes states.
    expect(screen.getByTestId('dm-connection-dot').getAttribute('data-connected')).toBe('true');
  });
});

describe('DmChatScreen', () => {
  it('renders bubbles, marks the conversation read on open, and offers retry on failed sends', async () => {
    const peerHex = generateKeypair().pubkeyHex;
    const senderHex = generateKeypair().pubkeyHex;
    const { core } = await makeCore({
      ...emptyDmView(),
      conversations: [
        { peerPubkey: peerHex, protocol: 'nip17', lastMessageAt: 1, unreadCount: 0, lastPreview: 'did not make it' },
        { peerPubkey: senderHex, protocol: 'nip17', lastMessageAt: 2, unreadCount: 1, lastPreview: 'incoming text' },
      ],
      messages: {
        [peerHex]: [{ id: 'm1', peerPubkey: peerHex, senderPubkey: 'phone', content: 'did not make it', at: 1, status: 'failed' }],
        [senderHex]: [{ id: 'm2', peerPubkey: senderHex, senderPubkey: senderHex, content: 'incoming text', at: 2, status: 'delivered' }],
      },
    });
    expect(core.dm.getState().conversations[senderHex]!.unreadCount).toBe(1);

    render(
      <PhoneCoreProvider value={core}>
        <DmChatScreen peerPubkey={senderHex} />
      </PhoneCoreProvider>,
    );
    expect(screen.getByText('incoming text')).toBeTruthy();
    // Opening the chat selected the peer, which the Router treats as reading
    // it — scripted here via wireDm's `selectDmPeer` handler.
    await act(async () => {
      await tick();
    });
    expect(core.dm.getState().conversations[senderHex]!.unreadCount).toBe(0);
    expect(core.dm.getState().activePeer).toBe(senderHex);
    cleanup();

    render(
      <PhoneCoreProvider value={core}>
        <DmChatScreen peerPubkey={peerHex} />
      </PhoneCoreProvider>,
    );
    expect(screen.getByText(/send failed/)).toBeTruthy();
    expect(screen.getByText('Retry')).toBeTruthy();
  });
});

describe('relativeTime (ms input — the DM tiles feed lastMessageAt)', () => {
  it('buckets seconds/minutes/hours/days', () => {
    const now = 1_700_000_000_000;
    expect(relativeTime(now - 5_000, now)).toBe('now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h');
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2d');
  });
});
