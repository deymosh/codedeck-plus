/**
 * `applyProtocolDefaults` reassigns this module's own `let` exports — proves
 * that reassignment is actually visible through an import binding taken
 * BEFORE the call, the property this whole design relies on.
 */
import { describe, it, expect } from 'vitest';
import {
  applyProtocolDefaults,
  CAPABILITIES,
  DEFAULT_RELAYS,
  EFFORT_LEVELS,
  isEffortLevel,
  isPermissionMode,
  MARMOT_RELAYS,
  PERMISSION_MODES,
  PROVIDER_BASE_URL_ERROR,
} from '../protocolConstants';

describe('applyProtocolDefaults', () => {
  it('is visible through bindings imported before the call', () => {
    expect(isEffortLevel('low')).toBe(true);
    expect(isPermissionMode('plan')).toBe(true);

    applyProtocolDefaults({
      effortLevels: ['auto'],
      permissionModes: ['plan'],
      defaultRelays: ['wss://only.example'],
      marmotRelays: ['wss://marmot.example'],
      customProvidersCapability: 'custom-providers-v2',
      providerBaseUrlError: 'new error text',
    });

    expect(EFFORT_LEVELS).toEqual(['auto']);
    expect(PERMISSION_MODES).toEqual(['plan']);
    expect(DEFAULT_RELAYS).toEqual(['wss://only.example']);
    expect(MARMOT_RELAYS).toEqual(['wss://marmot.example']);
    expect(CAPABILITIES.customProviders).toBe('custom-providers-v2');
    expect(PROVIDER_BASE_URL_ERROR).toBe('new error text');
    // The predicates read the SAME reassigned bindings, not a stale closure.
    expect(isEffortLevel('low')).toBe(false);
    expect(isEffortLevel('auto')).toBe(true);
    expect(isPermissionMode('default')).toBe(false);

    // Restore the fallback so other test files importing this module in the
    // same worker don't inherit this test's mutation (module state is
    // process-lifetime, not per-test).
    applyProtocolDefaults({
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'],
      permissionModes: ['default', 'acceptEdits', 'plan'],
      defaultRelays: ['wss://relay2.descendant.io', 'wss://relay.primal.net', 'wss://nostr.oxtr.dev'],
      marmotRelays: ['wss://relay.us.whitenoise.chat', 'wss://relay.eu.whitenoise.chat'],
      customProvidersCapability: 'custom-providers',
      providerBaseUrlError:
        'Base URL must be https:// (http:// is allowed only for localhost, 127.0.0.1 or [::1])',
    });
  });
});
