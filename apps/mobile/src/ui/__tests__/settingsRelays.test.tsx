// @vitest-environment jsdom
/**
 * Settings → Relays: a status dot per relay row (before the URL — CDX
 * follow-up on the "connection dot doesn't reflect reality" report),
 * reading `ConnectionView.connectedRelays` — see that view's own doc comment
 * for why this isn't a fully live push.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { buildFakePhoneCore } from '../../core/__tests__/nativeCoreFixture';
import { defaultSettings } from '../../core/stores/settings';
import type { PhoneCore } from '../../core/phoneCore';
import { PhoneCoreProvider } from '../coreContext';
import { SettingsScreen } from '../screens/SettingsScreen';

afterEach(cleanup);

const RELAY_UP = 'wss://relay-up.example';
const RELAY_DOWN = 'wss://relay-down.example';

function settingsWithRelays(relays: string[]) {
  return { ...defaultSettings(), relays };
}

function renderSettings(core: PhoneCore) {
  return render(
    <PhoneCoreProvider value={core}>
      <SettingsScreen />
    </PhoneCoreProvider>,
  );
}

describe('Settings — per-relay status dot', () => {
  it('marks only the relays connectedRelays actually lists', async () => {
    const { phone } = await buildFakePhoneCore(
      { settings: settingsWithRelays([RELAY_UP, RELAY_DOWN]) },
      { status: 'connected', needsPairingCheck: false, connectedRelays: [RELAY_UP] },
    );
    renderSettings(phone);

    const dots = screen.getAllByTestId('relay-status-dot');
    expect(dots).toHaveLength(2);
    expect(dots[0]!.getAttribute('data-connected')).toBe('true');
    expect(dots[1]!.getAttribute('data-connected')).toBe('false');
  });

  it('the dot precedes the relay URL in the row', async () => {
    const { phone } = await buildFakePhoneCore(
      { settings: settingsWithRelays([RELAY_UP]) },
      { status: 'connected', needsPairingCheck: false, connectedRelays: [RELAY_UP] },
    );
    renderSettings(phone);

    const row = screen.getByTitle(RELAY_UP).closest('div');
    const dot = screen.getByTestId('relay-status-dot');
    expect(row?.firstElementChild).toBe(dot);
  });
});
