/**
 * settingsStore uiScale (Phase 5a) — the slider's store contract: clamped
 * writes, KV persistence, and hydrate round-trip (persisted multiplier
 * survives an app restart; garbage never escapes the slider range).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_RELAYS, FALLBACK_RELAY, MARMOT_RELAYS, PAIRING_RELAY } from '@codedeck/protocol';
import { memoryKV } from '../ports';
import {
  DEAD_DEFAULT_RELAYS,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  createSettingsStore,
  defaultSettings,
  hydrateSettings,
  loadPersistedSettings,
} from '../stores/settings';

// Formerly the dead default (CDX-021); live since CDX-007, scrub retired (CDX-036).
const RELAY2 = 'wss://relay2.descendant.io';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('settingsStore uiScale', () => {
  it('round-trips through the KV: set → persist → hydrate on next boot', async () => {
    const kv = memoryKV();
    const store = createSettingsStore({ kv });

    store.getState().setUiScale(1.2);
    expect(store.getState().uiScale).toBe(1.2);
    await flush();

    const rebooted = await loadPersistedSettings(kv);
    expect(rebooted.uiScale).toBe(1.2);
    // ...and the rest of the settings survive alongside it
    expect(rebooted.relays.length).toBeGreaterThan(0);
  });

  it('clamps writes onto the slider range', async () => {
    const kv = memoryKV();
    const store = createSettingsStore({ kv });

    store.getState().setUiScale(3);
    expect(store.getState().uiScale).toBe(UI_SCALE_MAX);

    store.getState().setUiScale(0.1);
    expect(store.getState().uiScale).toBe(UI_SCALE_MIN);

    store.getState().setUiScale(Number.NaN);
    expect(store.getState().uiScale).toBe(1);

    await flush();
    expect((await loadPersistedSettings(kv)).uiScale).toBe(1);
  });

  it('hydrate clamps out-of-range persisted values and defaults garbage', () => {
    expect(hydrateSettings(JSON.stringify({ uiScale: 9 })).uiScale).toBe(UI_SCALE_MAX);
    expect(hydrateSettings(JSON.stringify({ uiScale: 0.2 })).uiScale).toBe(UI_SCALE_MIN);
    expect(hydrateSettings(JSON.stringify({ uiScale: 'big' })).uiScale).toBe(1);
    expect(hydrateSettings('not json').uiScale).toBe(1);
    expect(hydrateSettings(undefined).uiScale).toBe(1);
  });

  it('meshTestTarget (5d): OFF by default, round-trips, garbage defaults to OFF', async () => {
    // Default OFF — only a device the user designates as a test target exposes adb.
    expect(hydrateSettings(undefined).meshTestTarget).toBe(false);
    expect(hydrateSettings(JSON.stringify({ meshTestTarget: 'yes' })).meshTestTarget).toBe(false);

    const kv = memoryKV();
    const store = createSettingsStore({ kv });
    store.getState().setMeshTestTarget(true);
    expect(store.getState().meshTestTarget).toBe(true);
    await flush();
    expect((await loadPersistedSettings(kv)).meshTestTarget).toBe(true);
  });
});

describe('CDX-047 — new-session preferences (default mode / effort / model)', () => {
  it('defaults: plan mode, unset effort, unset model', () => {
    const defaults = defaultSettings();
    expect(defaults.defaultMode).toBe('plan');
    expect(defaults.defaultEffort).toBe('');
    expect(defaults.defaultModel).toBe('');
  });

  it('round-trips through the KV: set → persist → hydrate on next boot', async () => {
    const kv = memoryKV();
    const store = createSettingsStore({ kv });

    store.getState().setDefaultMode('acceptEdits');
    store.getState().setDefaultEffort('high');
    store.getState().setDefaultModel('  model-y  '); // trimmed like blossomServer
    expect(store.getState().defaultModel).toBe('model-y');
    await flush();

    const rebooted = await loadPersistedSettings(kv);
    expect(rebooted.defaultMode).toBe('acceptEdits');
    expect(rebooted.defaultEffort).toBe('high');
    expect(rebooted.defaultModel).toBe('model-y');
  });

  it('hydrate rejects garbage back to the defaults (mode/effort are enum-validated)', () => {
    const garbage = hydrateSettings(
      JSON.stringify({ defaultMode: 'yolo', defaultEffort: 'ultra', defaultModel: 7 }),
    );
    expect(garbage.defaultMode).toBe('plan');
    expect(garbage.defaultEffort).toBe('');
    expect(garbage.defaultModel).toBe('');
    // Absent keys (pre-CDX-047 installs) hydrate to the defaults too.
    expect(hydrateSettings(JSON.stringify({ uiScale: 1 })).defaultMode).toBe('plan');
  });
});

describe('CDX-048 — notification & badge toggles', () => {
  it('all three default ON, round-trip through the KV, garbage defaults back ON', async () => {
    const defaults = defaultSettings();
    expect(defaults.notificationsEnabled).toBe(true);
    expect(defaults.showUsageBadge).toBe(true);
    expect(defaults.showCommitBadge).toBe(true);

    const kv = memoryKV();
    const store = createSettingsStore({ kv });
    store.getState().setNotificationsEnabled(false);
    store.getState().setShowUsageBadge(false);
    store.getState().setShowCommitBadge(false);
    await flush();

    const rebooted = await loadPersistedSettings(kv);
    expect(rebooted.notificationsEnabled).toBe(false);
    expect(rebooted.showUsageBadge).toBe(false);
    expect(rebooted.showCommitBadge).toBe(false);

    const garbage = hydrateSettings(
      JSON.stringify({ notificationsEnabled: 'no', showUsageBadge: 0, showCommitBadge: null }),
    );
    expect(garbage.notificationsEnabled).toBe(true);
    expect(garbage.showUsageBadge).toBe(true);
    expect(garbage.showCommitBadge).toBe(true);
  });
});

describe('CDX-021/CDX-036 — the relay2 scrub is retired now the relay is deployed', () => {
  it('a fresh install ships the full protocol default list, relay2 included', () => {
    const defaults = defaultSettings();
    // CDX-100: transport defaults FIRST, then the Marmot island appended.
    expect(defaults.relays).toEqual([...DEFAULT_RELAYS, ...MARMOT_RELAYS]);
    expect(defaults.relays).toContain(RELAY2);
    expect(DEAD_DEFAULT_RELAYS).toEqual([]); // mechanism kept, list empty
  });

  it('hydrate no longer strips relay2 from a customised persisted list', () => {
    const hydrated = hydrateSettings(
      JSON.stringify({ relays: [RELAY2, 'wss://relay.primal.net', 'wss://user.example'] }),
    );
    expect(hydrated.relays).toEqual([RELAY2, 'wss://relay.primal.net', 'wss://user.example']);
  });

  it('a persisted EMPTY list still falls back to the live defaults', () => {
    const hydrated = hydrateSettings(JSON.stringify({ relays: [] }));
    expect(hydrated.relays).toEqual(defaultSettings().relays);
  });
});

describe('CDX-042 — a fresh install ships more than one live relay', () => {
  it('defaults carry at least two live relays, including the second public one', () => {
    const { relays } = defaultSettings();
    // The device symptom: after the CDX-021 scrub a clean install held exactly
    // ONE relay (relay.primal.net) and a second one had to be added by hand
    // before the phone could reach the bridge.
    expect(relays.length).toBeGreaterThanOrEqual(2);
    expect(relays).toContain(FALLBACK_RELAY);
    expect(relays).toContain(PAIRING_RELAY);
    expect(relays).toContain(RELAY2); // primary transport, live since CDX-007
    expect(new Set(relays).size).toBe(relays.length); // no duplicates
  });

  it('an untouched legacy default list is lifted to the current defaults on upgrade', () => {
    // Installs from before CDX-042 persisted the then-default list. They never
    // chose it, so they must not be stranded on a single relay.
    expect(hydrateSettings(JSON.stringify({ relays: ['wss://relay.primal.net'] })).relays).toEqual(
      defaultSettings().relays,
    );
    // Same list as it was persisted BEFORE the CDX-021 scrub.
    expect(
      hydrateSettings(JSON.stringify({ relays: [RELAY2, 'wss://relay.primal.net'] })).relays,
    ).toEqual(defaultSettings().relays);
    // CDX-042-era default as persisted while the CDX-021 scrub was active.
    expect(
      hydrateSettings(
        JSON.stringify({ relays: ['wss://relay.primal.net', 'wss://relay.damus.io'] }),
      ).relays,
    ).toEqual(defaultSettings().relays);
    // CDX-081-era default as persisted while the scrub was active (damus → oxtr).
    // This is the list EVERY currently-installed build carries, so if this entry
    // is ever dropped the CDX-036 retirement strands the entire installed base
    // on [primal, oxtr] and none of them ever gain relay2.
    expect(
      hydrateSettings(JSON.stringify({ relays: [PAIRING_RELAY, FALLBACK_RELAY] })).relays,
    ).toEqual(defaultSettings().relays);
    // CDX-100-era default: what 0.9.2/0.9.3 shipped after the CDX-036
    // retirement. This is the list the founder's phone actually holds, so this
    // entry is what makes the update deliver the Marmot relays at all.
    expect(
      hydrateSettings(JSON.stringify({ relays: [RELAY2, PAIRING_RELAY, FALLBACK_RELAY] })).relays,
    ).toEqual(defaultSettings().relays);
  });

  /**
   * CDX-100 — the whole point of the change: an install that took the 0.9.3
   * default could not start a Marmot chat with any MDK peer, because every
   * KeyPackage it needed lives on relays it never dialled. `startChat` reported
   * "Peer has no published Marmot KeyPackage" for peers whose KeyPackage was
   * live on nos.lol and both whitenoise relays the entire time.
   */
  it('an install on the 0.9.3 default gains the Marmot relays on upgrade', () => {
    const shipped093 = [RELAY2, PAIRING_RELAY, FALLBACK_RELAY];
    const upgraded = hydrateSettings(JSON.stringify({ relays: shipped093 })).relays;
    for (const relay of MARMOT_RELAYS) expect(upgraded).toContain(relay);
    // ...without losing the transport relays it was already using.
    for (const relay of shipped093) expect(upgraded).toContain(relay);
  });

  it('leaves a hand-customised list alone — including one the user already fixed', () => {
    // Someone who added the relay by hand (the workaround before this shipped)
    // must not have their ordering or extra relays rewritten underneath them.
    const custom = [PAIRING_RELAY, 'wss://relay.us.whitenoise.chat'];
    expect(hydrateSettings(JSON.stringify({ relays: custom })).relays).toEqual(custom);
  });

  /**
   * CDX-081 — the trap this list exists to prevent, exercised on the specific
   * swap that just happened. 0.9.0/0.9.1 shipped [primal, damus]; damus was
   * then evicted for rate-limiting every publish. An install that simply took
   * that default never chose damus, so it must be LIFTED. Had the outgoing
   * default not been added to LEGACY_DEFAULT_RELAY_SETS, every such install
   * would have been read as customised and stranded on the evicted relay —
   * silently, and with no way for the user to know why messaging got worse.
   */
  it('the OUTGOING default is lifted, not stranded, when the fallback relay changes', () => {
    const outgoing = ['wss://relay.primal.net', 'wss://relay.damus.io'];
    expect(hydrateSettings(JSON.stringify({ relays: outgoing })).relays).toEqual(
      defaultSettings().relays,
    );
    // And the current default no longer contains the evicted relay at all.
    expect(defaultSettings().relays).not.toContain('wss://relay.damus.io');
    // Still two live public relays — CDX-042's floor for a working first run.
    expect(defaultSettings().relays.length).toBeGreaterThanOrEqual(2);
  });

  it('a user who deliberately kept damus kicks out of the lift', () => {
    // Same relays, user's own order → customised, so hands off. The lift must be
    // exact-match only; anything looser would overwrite real intent.
    const reordered = ['wss://relay.damus.io', 'wss://relay.primal.net'];
    expect(hydrateSettings(JSON.stringify({ relays: reordered })).relays).toEqual(reordered);
  });

  it('a CUSTOMISED relay list is never clobbered by the new default', () => {
    // One extra relay, one missing relay, and a reordering are all user intent.
    const added = hydrateSettings(
      JSON.stringify({ relays: ['wss://relay.primal.net', 'wss://user.example'] }),
    );
    expect(added.relays).toEqual(['wss://relay.primal.net', 'wss://user.example']);

    const narrowed = hydrateSettings(JSON.stringify({ relays: ['wss://only.example'] }));
    expect(narrowed.relays).toEqual(['wss://only.example']);

    const reordered = hydrateSettings(
      JSON.stringify({ relays: [FALLBACK_RELAY, PAIRING_RELAY] }),
    );
    expect(reordered.relays).toEqual([FALLBACK_RELAY, PAIRING_RELAY]);
  });

  it('relays merged from a pairing URL keep relay2 now the scrub is retired (CDX-036)', () => {
    const store = createSettingsStore({ kv: memoryKV() });
    // Exactly what a default-config bridge puts in its pairing URL today.
    store.getState().addRelays([RELAY2, 'wss://bridge.example']);
    expect(store.getState().relays).toContain(RELAY2);
    expect(store.getState().relays).toContain('wss://bridge.example');
  });
});
