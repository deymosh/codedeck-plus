// @vitest-environment jsdom
/**
 * CDX-101 guard: a DM tile must say WHO the conversation is with.
 *
 * The founder's report was "the tiles only list a letter circle" — a sidebar
 * of anonymous avatars. Cause: `.convRow` used `composes: card from shared`,
 * and this module is emitted BEFORE shared.module.css in the bundle, so the
 * shared card's `flex-direction: column` beat the local `row` at equal
 * specificity. The tile stacked, the local `align-items: center` centred the
 * avatar, and — because tiles were shrinkable inside the height-capped
 * `.dmList` column — the name/preview were squashed out of a ~45px box and
 * clipped behind the next tile. Every glyph was in the DOM the whole time,
 * which is exactly why only a static/stylesheet check catches it.
 *
 * jsdom has no layout engine and vitest runs with `css: false`, so the layout
 * half is checked over the stylesheet (same technique as
 * transcriptTypography.test.ts / sidebarRail.test.ts); the label half is a
 * plain unit + render test. A device screenshot is the final oracle.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render, screen } from '@testing-library/react';
import { createPhoneCore } from '../../../core/createPhoneCore';
import { memoryKV, type PhoneTransport } from '../../../core/ports';
import type { DmProfile } from '../../../core/stores/dm';
import type { UnifiedConversation } from '../../../core/stores/marmot';
import { PhoneCoreProvider } from '../../coreContext';
import { conversationLabel, DmTile } from '../../DmTile';
import { DmSection } from '../../DmSection';

afterEach(cleanup);

const makeCore = () => {
  const transport: PhoneTransport = {
    subscribe: () => ({ close: () => {} }),
    publish: async () => true,
  };
  return createPhoneCore({ kv: memoryKV(), transport });
};

const dmDir = path.dirname(fileURLToPath(import.meta.url));
const dmCss = readFileSync(path.join(dmDir, '..', 'dm.module.css'), 'utf8');

/** Body of a top-level rule, e.g. block('convRow') → "display: flex; …". */
const block = (className: string): string => {
  const match = new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`).exec(dmCss);
  expect(match, `.${className} is not declared in dm.module.css`).not.toBeNull();
  return match![1]!;
};

const conversation = (over: Partial<UnifiedConversation> = {}): UnifiedConversation => ({
  protocol: 'marmot',
  key: 'g1',
  peerPubkey: 'a'.repeat(64),
  lastMessageAt: Date.now(),
  unreadCount: 0,
  lastPreview: 'hey there',
  title: '',
  memberCount: 2,
  ...over,
});

describe('conversation tile layout is not at the mercy of composes order', () => {
  it('.convRow owns its row layout — no cross-file composes to lose the cascade to', () => {
    const rule = block('convRow');
    expect(rule).not.toMatch(/composes:/);
    expect(rule).toMatch(/display:\s*flex/);
    expect(rule).toMatch(/flex-direction:\s*row/);
    // It still has to look like a card on its own.
    expect(rule).toMatch(/background:\s*var\(--surface\)/);
    expect(rule).toMatch(/border:\s*1px solid var\(--border\)/);
  });

  it('tiles and welcome cards never shrink inside the height-capped list', () => {
    expect(block('convRow')).toMatch(/flex-shrink:\s*0/);
    expect(block('welcomeCard')).toMatch(/flex-shrink:\s*0/);
  });

  it('the name truncates before the protocol badge gives up any width', () => {
    expect(block('convName')).toMatch(/flex:\s*0 1 auto/);
    expect(block('convName')).toMatch(/text-overflow:\s*ellipsis/);
    expect(block('protocolBadge')).toMatch(/flex-shrink:\s*0/);
  });
});

describe('conversationLabel', () => {
  const profile = (over: Partial<DmProfile>): DmProfile => ({
    fetchedAt: 0,
    status: 'ok',
    ...over,
  });

  it('prefers the resolved profile name, and marks it as a name (not a key)', () => {
    expect(conversationLabel(conversation(), profile({ displayName: 'Tycho' }))).toEqual({
      text: 'Tycho',
      isKey: false,
    });
    expect(conversationLabel(conversation(), profile({ name: 'tycho' }))).toEqual({
      text: 'tycho',
      isKey: false,
    });
  });

  it('falls back to a truncated npub — flagged as a key so it renders mono/dim', () => {
    const label = conversationLabel(conversation(), undefined);
    expect(label.isKey).toBe(true);
    expect(label.text).toMatch(/^npub1.*…/);
  });

  it('an empty profile name does not win over the key', () => {
    const label = conversationLabel(conversation(), profile({ displayName: '  ', name: '' }));
    expect(label.isKey).toBe(true);
  });

  it('names a >2-member group by its MLS group name, members as the last resort', () => {
    expect(
      conversationLabel(conversation({ memberCount: 4, title: 'CodeDeck crew' }), undefined).text,
    ).toBe('CodeDeck crew');
    expect(conversationLabel(conversation({ memberCount: 4 }), undefined).text).toBe(
      'Marmot group · 4 members',
    );
  });

  it('a 1:1 with no peer yet still says something — group name, else "Marmot chat"', () => {
    expect(conversationLabel(conversation({ peerPubkey: '', title: 'CodeDeck DM' }), undefined).text)
      .toBe('CodeDeck DM');
    expect(conversationLabel(conversation({ peerPubkey: '' }), undefined).text).toBe('Marmot chat');
  });
});

describe('DmTile renders the identity, not just an avatar', () => {
  it('shows name, preview, protocol badge and time', async () => {
    const core = await makeCore();
    const peer = 'a'.repeat(64);
    core.dm.setState((st) => ({
      profiles: { ...st.profiles, [peer]: { displayName: 'Tycho', fetchedAt: 1, status: 'ok' } },
    }));

    render(
      <PhoneCoreProvider value={core}>
        <DmTile
          conversation={conversation({ peerPubkey: peer, unreadCount: 3 })}
          onOpen={() => {}}
        />
      </PhoneCoreProvider>,
    );

    expect(screen.getByTestId('dm-tile-name').textContent).toBe('Tycho');
    expect(screen.getByTestId('dm-tile').textContent).toContain('hey there');
    expect(screen.getByTestId('protocol-badge').textContent).toBe('MLS');
    expect(screen.getByTestId('unread-badge').textContent).toBe('3');
  });

  it('a single-protocol list drops the badge — the name gets that width', async () => {
    const core = await makeCore();
    core.dm.getState().startConversation('b'.repeat(64));
    core.dm.getState().startConversation('c'.repeat(64));
    core.dm.getState().setActivePeer(null);

    render(
      <PhoneCoreProvider value={core}>
        <DmSection />
      </PhoneCoreProvider>,
    );

    expect(screen.getAllByTestId('dm-tile')).toHaveLength(2);
    expect(screen.queryAllByTestId('protocol-badge')).toHaveLength(0);
    // Mixed NIP-17 + Marmot lists DO tag every row — marmotUi.test.tsx owns that.
  });
});
