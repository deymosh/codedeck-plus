// @vitest-environment jsdom
/**
 * DM UI (Phase 5b): the rebuilt bottom bar (ONE flex component — all controls
 * are direct children, no nested control columns; the old icon-layout bug's
 * structural fix), conversation-list ordering + unread badges, and the chat
 * screen's failed-send retry affordance.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { NostrEvent } from 'nostr-tools/core';
import type { PhoneCore } from '../../../core/createPhoneCore';
import { createPhoneCore } from '../../../core/createPhoneCore';
import { generateKeypair } from '../../../core/crypto';
import { memoryKV, type PhoneTransport } from '../../../core/ports';
import { GIFT_WRAP_KIND } from '../../../core/stores/dm';
import { PhoneCoreProvider } from '../../coreContext';
import { DmBottomBar } from '../DmBottomBar';
import { DmChatScreen } from '../DmChatScreen';
import { DmSection } from '../../DmSection';
import { relativeTime } from '../../relativeTime';

afterEach(cleanup);

function fakeTransport(publishOk = true) {
  const published: NostrEvent[] = [];
  const transport: PhoneTransport = {
    subscribe: () => ({ close: () => {} }),
    publish: async (event) => {
      published.push(event);
      return publishOk;
    },
  };
  return { transport, published };
}

async function makeCore(publishOk = true): Promise<{ core: PhoneCore; published: NostrEvent[] }> {
  const { transport, published } = fakeTransport(publishOk);
  const core = await createPhoneCore({ kv: memoryKV(), transport });
  return { core, published };
}

const wrapFor = (published: NostrEvent[], pubkey: string): NostrEvent =>
  published.find(
    (e) => e.kind === GIFT_WRAP_KIND && e.tags.some((t) => t[0] === 'p' && t[1] === pubkey),
  )!;

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
    const { core } = await makeCore();
    const dm = core.dm.getState();

    // Older conversation (created first, no unread) — pinned clearly into the
    // past (startConversation stamps "now", which would tie with the incoming
    // message's second-truncated rumor time).
    const olderPeer = generateKeypair();
    dm.startConversation(olderPeer.pubkeyHex);
    core.dm.getState().setActivePeer(null);
    core.dm.setState({
      conversations: {
        ...core.dm.getState().conversations,
        [olderPeer.pubkeyHex]: {
          ...core.dm.getState().conversations[olderPeer.pubkeyHex]!,
          lastMessageAt: Date.now() - 3_600_000,
        },
      },
    });

    // Newer conversation via an incoming message → unread 1, newer activity.
    const sender = await makeCore();
    const me = core.identity.getState().pubkeyHex;
    await sender.core.dm.getState().send(me, 'newest message');
    core.dm.getState().ingest(wrapFor(sender.published, me));

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
    const senderHex = sender.core.identity.getState().pubkeyHex;
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
    fireEvent.change(screen.getByPlaceholderText(/npub/), {
      target: { value: peer.pubkeyHex },
    });
    fireEvent.click(screen.getByText('Start conversation'));
    expect(core.ui.getState().panelMode).toBe('dm');
    expect(core.ui.getState().activeDmPeer).toBe(peer.pubkeyHex);
    // The input closed and the new conversation renders as a tile.
    expect(screen.queryByPlaceholderText(/npub/)).toBeNull();
    expect(screen.getAllByTestId('dm-tile')).toHaveLength(1);
  });

  it('empty state and the connection dot reflect the store', async () => {
    const { core } = await makeCore();
    render(
      <PhoneCoreProvider value={core}>
        <DmSection />
      </PhoneCoreProvider>,
    );
    expect(screen.getByText('No conversations yet.')).toBeTruthy();
    expect(screen.getByTestId('dm-connection-dot').getAttribute('data-connected')).toBe('false');
  });
});

describe('DmChatScreen', () => {
  it('renders bubbles, marks the conversation read on open, and offers retry on failed sends', async () => {
    // Failed send: transport rejects everything.
    const { core } = await makeCore(false);
    const peer = generateKeypair();
    await core.dm.getState().send(peer.pubkeyHex, 'did not make it');

    // An incoming message too (unread until the chat opens).
    const sender = await makeCore();
    const me = core.identity.getState().pubkeyHex;
    await sender.core.dm.getState().send(me, 'incoming text');
    core.dm.getState().ingest(wrapFor(sender.published, me));
    const senderHex = sender.core.identity.getState().pubkeyHex;
    expect(core.dm.getState().conversations[senderHex]!.unreadCount).toBe(1);

    render(
      <PhoneCoreProvider value={core}>
        <DmChatScreen peerPubkey={senderHex} />
      </PhoneCoreProvider>,
    );
    expect(screen.getByText('incoming text')).toBeTruthy();
    // Opening the chat marked it read.
    expect(core.dm.getState().conversations[senderHex]!.unreadCount).toBe(0);
    expect(core.dm.getState().activePeer).toBe(senderHex);
    cleanup();

    render(
      <PhoneCoreProvider value={core}>
        <DmChatScreen peerPubkey={peer.pubkeyHex} />
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
