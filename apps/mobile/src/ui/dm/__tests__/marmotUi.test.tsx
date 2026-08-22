// @vitest-environment jsdom
/**
 * Marmot UI (Phase 6, CDX-012): the unified conversation list carries BOTH
 * protocols with per-row tags, pending welcome cards accept into a joined
 * conversation, the start-chat sheet offers the Marmot path (with the honest
 * no-KeyPackage error), and the MarmotChatScreen renders MLS-tagged bubbles
 * over the marmot store.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { NostrEvent } from 'nostr-tools/core';
import type { PhoneCore } from '../../../core/createPhoneCore';
import { createPhoneCore } from '../../../core/createPhoneCore';
import { generateKeypair } from '../../../core/crypto';
import { memoryKV, type PhoneTransport } from '../../../core/ports';
import {
  GROUP_MESSAGE_KIND,
  KEY_PACKAGE_KIND,
  type MarmotGroupInfo,
  type MarmotIngested,
  type MarmotPlatform,
  type MarmotWelcomeInfo,
} from '../../../core/stores/marmot';
import { PhoneCoreProvider } from '../../coreContext';
import { DmSection } from '../../DmSection';
import { MarmotChatScreen } from '../MarmotChatScreen';

afterEach(cleanup);

const fakeEvent = (kind: number, tags: string[][] = [], id = 'e'.repeat(64)): NostrEvent => ({
  id,
  kind,
  pubkey: 'f'.repeat(64),
  created_at: Math.floor(Date.now() / 1000),
  content: '',
  tags,
  sig: '0'.repeat(128),
});

const WELCOMER = 'a'.repeat(64);

const WELCOME: MarmotWelcomeInfo = {
  welcomeId: 'w1',
  wrapperId: '1'.repeat(64),
  groupId: 'g1',
  hTag: 'h1',
  name: 'CodeDeck DM',
  welcomer: WELCOMER,
  memberCount: 2,
};

function fakeSeam(mePubkey: () => string) {
  const state = {
    groups: [] as MarmotGroupInfo[],
    pending: [] as MarmotWelcomeInfo[],
    ingestScript: [] as MarmotIngested[],
    sendCounter: 0,
  };
  const seam: MarmotPlatform = {
    init: async () => mePubkey(),
    publishKeyPackage: async () => fakeEvent(KEY_PACKAGE_KIND, [['d', 'kp']]),
    createGroup: async (peerPubkey) => ({
      groupId: 'g-new',
      hTag: 'h-new',
      welcomeEvent: fakeEvent(1059, [['p', peerPubkey]], '2'.repeat(64)),
    }),
    send: async () => {
      state.sendCounter++;
      return {
        event: fakeEvent(GROUP_MESSAGE_KIND, [['h', 'h1']], `${state.sendCounter}`.padStart(64, '0')),
        rumorId: `rumor-${state.sendCounter}`,
        createdAt: Math.floor(Date.now() / 1000),
      };
    },
    ingest: async () => state.ingestScript.shift() ?? { type: 'none' },
    pendingWelcomes: async () => state.pending,
    acceptWelcome: async (welcomeId) => {
      const group: MarmotGroupInfo = {
        groupId: WELCOME.groupId,
        hTag: WELCOME.hTag,
        name: WELCOME.name,
        members: [mePubkey(), WELCOME.welcomer],
        admins: [],
        active: true,
      };
      state.groups.push(group);
      state.pending = state.pending.filter((w) => w.welcomeId !== welcomeId);
      return group;
    },
    listGroups: async () => state.groups,
  };
  return { seam, state };
}

async function makeCore(): Promise<{
  core: PhoneCore;
  seamState: ReturnType<typeof fakeSeam>['state'];
  published: NostrEvent[];
}> {
  const published: NostrEvent[] = [];
  const transport: PhoneTransport = {
    // EOSE promptly with no stored events — the KP lookup resolves fast.
    subscribe: (_filter, params) => {
      const t = setTimeout(() => params.onEose?.(), 0);
      return { close: () => clearTimeout(t) };
    },
    publish: async (event) => {
      published.push(event);
      return true;
    },
  };
  let me = '';
  const fake = fakeSeam(() => me);
  const core = await createPhoneCore({ kv: memoryKV(), transport, marmot: fake.seam });
  me = core.identity.getState().pubkeyHex;
  return { core, seamState: fake.state, published };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

describe('unified list + welcome cards', () => {
  it('shows both protocols with badges, and Accept turns an invite into a Marmot conversation', async () => {
    const { core, seamState } = await makeCore();
    seamState.pending.push(WELCOME);
    core.marmot.getState().start();
    await settle();

    // A NIP-17 conversation beside the (future) Marmot one.
    const nip17Peer = generateKeypair();
    core.dm.getState().startConversation(nip17Peer.pubkeyHex);
    core.dm.getState().setActivePeer(null);

    render(
      <PhoneCoreProvider value={core}>
        <DmSection />
      </PhoneCoreProvider>,
    );

    // The pending welcome surfaces as an invite card.
    const card = screen.getByTestId('marmot-welcome-card');
    expect(card.textContent).toContain('Marmot (MLS) chat invite');

    // Accept → joined conversation appears in the SAME list, MLS-tagged.
    fireEvent.click(screen.getByText('Accept'));
    await waitFor(() => {
      expect(core.marmot.getState().conversations['g1']).toBeTruthy();
    });
    await waitFor(() => {
      const rows = screen.getByTestId('dm-section').querySelectorAll('[data-protocol]');
      expect(rows).toHaveLength(2);
    });
    const rows = screen.getByTestId('dm-section').querySelectorAll('[data-protocol]');
    const protocols = [...rows].map((r) => r.getAttribute('data-protocol')).sort();
    expect(protocols).toEqual(['marmot', 'nip17']);

    const badges = screen.getAllByTestId('protocol-badge').map((b) => b.textContent);
    expect(badges).toContain('MLS');
    expect(badges).toContain('NIP-17');

    // Tapping the Marmot row selects the group (panelMode flips to marmot).
    const marmotRow = [...rows].find((r) => r.getAttribute('data-protocol') === 'marmot')!;
    fireEvent.click(marmotRow as HTMLElement);
    expect(core.ui.getState().panelMode).toBe('marmot');
    expect(core.ui.getState().activeMarmotGroup).toBe('g1');
  });

  it('the start sheet offers Marmot when available and surfaces the no-KeyPackage error honestly', async () => {
    const { core } = await makeCore();
    core.marmot.getState().start();
    await settle();
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
    fireEvent.change(screen.getByPlaceholderText(/npub/), {
      target: { value: peer.pubkeyHex },
    });
    fireEvent.click(marmotBtn);
    // The KP lookup EOSEs empty → the honest, actionable error.
    await waitFor(() => {
      expect(screen.getByText(/no published Marmot KeyPackage/)).toBeTruthy();
    });
  });
});

describe('MarmotChatScreen', () => {
  it('renders MLS-tagged bubbles, marks read on open, sends via the engine', async () => {
    const { core, seamState, published } = await makeCore();
    core.marmot.getState().start();
    await settle();

    // A joined conversation with one unread incoming message.
    seamState.ingestScript.push({ type: 'welcome', welcome: WELCOME });
    core.marmot.getState().ingestGiftWrap(fakeEvent(1059, [], '3'.repeat(64)));
    await settle();
    await core.marmot.getState().acceptWelcome('w1');
    seamState.ingestScript.push({
      type: 'message',
      groupId: 'g1',
      id: 'r1',
      sender: WELCOMER,
      kind: 9,
      content: 'hello over MLS',
      createdAt: Math.floor(Date.now() / 1000),
    });
    core.marmot.getState().ingestGroupMessage(fakeEvent(GROUP_MESSAGE_KIND, [['h', 'h1']], '4'.repeat(64)));
    await settle();
    expect(core.marmot.getState().conversations['g1']!.unreadCount).toBe(1);

    render(
      <PhoneCoreProvider value={core}>
        <MarmotChatScreen groupId="g1" />
      </PhoneCoreProvider>,
    );
    expect(screen.getByText('hello over MLS')).toBeTruthy();
    expect(screen.getByTestId('protocol-badge').textContent).toBe('MLS');
    // Opening marked it read + active.
    expect(core.marmot.getState().conversations['g1']!.unreadCount).toBe(0);
    expect(core.marmot.getState().activeGroup).toBe('g1');

    // Sending publishes the engine's 445.
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hi back' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => {
      expect(published.some((e) => e.kind === GROUP_MESSAGE_KIND)).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText('hi back')).toBeTruthy();
    });
  });
});
