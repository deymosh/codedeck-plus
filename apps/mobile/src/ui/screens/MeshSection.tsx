/**
 * Settings → Mesh (remote testing) — ported from the old app's MeshSection
 * (Phase 5d) onto the 5a tokens.
 *
 * Lets the phone join the encrypted nostr-vpn FIPS mesh so the office laptop
 * can reach this device over the overlay (remote on-device testing). The heavy
 * lifting is in `tauri-plugin-mesh`'s Android VpnService; this is the control
 * surface. On desktop/browser the plugin is a no-op, so the section shows a
 * "mobile only" note instead of dead buttons.
 *
 * The "Use this device as a test target" toggle is the per-device opt-in that
 * lets CodeDeck auto-enable Wireless Debugging (WRITE_SECURE_SETTINGS, granted
 * ONCE over USB — zero-touch afterwards). While the mesh is up AND the opt-in
 * is on, a 60s heartbeat re-enables WD (it silently turns off on idle/network
 * change) so the laptop's adb connection self-heals. A controller phone never
 * exposes adb.
 *
 * On join (and on opt-in while joined) the phone reports its REAL mesh
 * identity (tunnel IP + mesh-engine pubkey) to every paired bridge via
 * set-device-config — the bridge authorizes the mesh key on the nvpn roster
 * and derives the adb serial (`<meshIp>:0`). Zero typing.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  activeNetwork,
  getMeshIdentity,
  manualAddNetwork,
  parseMeshState,
  tauriMeshApi,
  type MeshApi,
  type MeshState,
  type MeshStatus,
} from '../../platform/mesh';
import { useMachines, usePhoneCore, useSettings, useUi } from '../coreContext';
import { cx, shared as s } from '../shared';
import styles from './SettingsScreen.module.css';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** One-time USB grant that makes the test-target toggle zero-touch (the
 *  permission is `development`-flagged: grantable via adb, never via a tap). */
const WD_GRANT_CMD = 'adb shell pm grant com.codedeck.plus android.permission.WRITE_SECURE_SETTINGS';

let defaultApi: MeshApi | null = null;
function api(): MeshApi {
  defaultApi ??= tauriMeshApi((m) => console.log(m));
  return defaultApi;
}

export function MeshSection() {
  const core = usePhoneCore();
  const machines = useMachines((st) => st.machines);
  const testTarget = useSettings((st) => st.meshTestTarget);
  // set-device-config round-trip feedback (CDX-011: the formerly fire-and-
  // forget report now shows each bridge's device-config-ack).
  const deviceConfigStatus = useUi((st) => st.deviceConfigStatus);

  const [status, setStatus] = useState<MeshStatus | null>(null);
  const [state, setState] = useState<MeshState>({});
  const [supported, setSupported] = useState<boolean | null>(null);
  // Manual-join fallback (CDX-028): the two PUBLIC strings the bridge prints —
  // the admin device ID (npub) and the network ID from `nvpn status`.
  const [adminNpub, setAdminNpub] = useState('');
  const [networkId, setNetworkId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [wdActive, setWdActive] = useState(false);
  // prepare_adb answered enabled:false ⇒ the one-time USB grant is missing —
  // show the degraded state with the grant instructions instead of pretending.
  const [grantNeeded, setGrantNeeded] = useState(false);
  const [reported, setReported] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<MeshStatus | null> => {
    const st = await api().status();
    setSupported(st !== null);
    if (st) {
      setStatus(st);
      setState(parseMeshState(st.state_json));
    }
    return st;
  }, []);

  // Poll a few times after mount: the first mesh_status triggers a one-time
  // async engine init on the native side, so a persisted network (imported
  // invite) only appears on a later poll. Stops early once a network shows up.
  useEffect(() => {
    if (!isTauri) {
      setSupported(false);
      return;
    }
    let cancelled = false;
    let tries = 0;
    const tick = async (): Promise<void> => {
      if (cancelled) return;
      const st = await refresh();
      tries += 1;
      const joined = st ? !!activeNetwork(parseMeshState(st.state_json)) : false;
      if (!cancelled && tries < 6 && !joined) setTimeout(() => void tick(), 700);
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  /** Report this device's mesh identity to every paired bridge (zero-touch
   *  test-target onboarding: roster add + serial derivation happen bridge-side). */
  const reportToBridges = useCallback(async () => {
    const identity = await getMeshIdentity(api());
    if (!identity) {
      setReported('mesh IP not assigned yet — will report on next connect');
      return;
    }
    const targets = Object.keys(machines);
    if (targets.length === 0) {
      setReported('no paired machines to notify — pair a bridge first');
      return;
    }
    await Promise.all(
      targets.map((m) => {
        core.ui.getState().noteDeviceConfigSent(m);
        return core.api.setDeviceConfig(m, {
          label: 'Test device',
          role: 'test-target',
          appUnderTest: 'kubo',
          meshIp: identity.meshIp,
          meshPubkey: identity.meshPubkey,
        });
      }),
    );
    setReported(`reported ${identity.meshIp} to ${targets.length} machine${targets.length === 1 ? '' : 's'}`);
  }, [core, machines]);

  const prepareAdb = useCallback(async () => {
    const r = await api().prepareAdb();
    setWdActive(!!r?.enabled);
    setGrantNeeded(r !== null && !r.enabled);
  }, []);

  const toggleMesh = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const res = status?.running ? await api().leave() : await api().join();
      if (res) {
        setStatus(res);
        const st = parseMeshState(res.state_json);
        setState(st);
        if (st.error) setError(st.error);
        // On a fresh connect, IF this device is a designated test target,
        // prepare adb-over-mesh + report our mesh identity to the bridges.
        // Gated by the opt-in: a controller phone never auto-opens adb.
        if (res.running && testTarget) {
          void prepareAdb();
          void reportToBridges();
        }
      }
    } catch (e) {
      // join_mesh rejects if the user denies the VPN consent dialog.
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [status, testTarget, prepareAdb, reportToBridges]);

  // While the mesh is up AND this device is a designated test target, keep
  // Wireless Debugging alive (it silently turns off on idle/network change).
  // A light heartbeat re-enables it so the laptop's adb connection self-heals
  // without any interaction on the phone. NEVER runs on a controller.
  useEffect(() => {
    if (!isTauri || !status?.running || !testTarget) {
      setWdActive(false);
      return;
    }
    let cancelled = false;
    const beat = (): void => {
      void api()
        .prepareAdb()
        .then((r) => {
          if (cancelled) return;
          setWdActive(!!r?.enabled);
          setGrantNeeded(r !== null && !r.enabled);
        });
    };
    beat();
    const id = setInterval(beat, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [status?.running, testTarget]);

  const joinManually = useCallback(async () => {
    const admin = adminNpub.trim();
    const netId = networkId.trim();
    if (!admin || !netId) {
      setError('Enter both the admin device ID (npub…) and the network ID first.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const ok = await manualAddNetwork(api(), admin, netId);
      if (ok) {
        setAdminNpub('');
        setNetworkId('');
      } else {
        setError(
          'Manual join failed — check the admin device ID (npub…) and network ID. Both are shown by `nvpn status` on the bridge machine.',
        );
      }
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [adminNpub, networkId, refresh]);

  const net = activeNetwork(state);

  return (
    <>
      <div className={styles.sectionTitle}>Mesh (remote testing)</div>
      <div className={s.muted}>
        Join the encrypted mesh so your office laptop can install &amp; drive dev builds on this
        phone from anywhere. Scanning the pairing QR from the laptop joins the mesh for you; the
        controls below are for checking status or joining manually. Android allows ONE active VPN
        at a time — connecting replaces any other VPN on this device (including another CodeDeck
        build&rsquo;s mesh).
      </div>

      {supported === false && (
        <div className={s.muted}>
          Mesh is available on the Android app only (it runs as a system VPN service).
        </div>
      )}

      {supported && (
        <>
          <div className={styles.relayRow}>
            <span className={status?.running ? s.badgeLive : s.badgeOffline}>
              {status?.running ? 'connected' : 'disconnected'}
            </span>
            <span className={cx(styles.relayUrl)}>
              {net
                ? `${net.name || net.networkId || 'mesh'}${state.tunnelIp ? ` · ${state.tunnelIp}` : ''}`
                : 'No network joined yet'}
            </span>
            <button
              className={s.btnSmall}
              onClick={() => void toggleMesh()}
              disabled={busy || !net}
            >
              {status?.running ? 'Disconnect' : 'Connect'}
            </button>
          </div>
          {status?.running && (
            <div className={s.muted}>
              {`Peers: ${state.connectedPeerCount ?? 0}/${state.expectedPeerCount ?? 0} connected`}
            </div>
          )}

          {/* Per-device opt-in: only a designated TEST TARGET exposes adb over the mesh. */}
          <div className={styles.scaleRow}>
            <label className={cx(styles.toggleRow, s.grow)}>
              <input
                type="checkbox"
                checked={testTarget}
                onChange={(e) => {
                  const on = e.target.checked;
                  core.settings.getState().setMeshTestTarget(on);
                  if (on && status?.running) {
                    void prepareAdb();
                    void reportToBridges();
                  } else if (!on) {
                    setWdActive(false);
                    setGrantNeeded(false);
                  }
                }}
              />
              <span>Use this device as a test target</span>
            </label>
            {wdActive && <span className={s.badgeLive}>WD on</span>}
          </div>
          <div className={s.muted}>
            Lets the laptop install &amp; drive dev builds here over adb. Enables Wireless
            Debugging while connected. Leave OFF on your controller phone.
          </div>
          {reported && testTarget && <div className={s.muted}>{reported}</div>}
          {testTarget &&
            Object.entries(deviceConfigStatus).map(([pk, ack]) => {
              const m = machines[pk];
              if (!m) return null;
              return (
                <div
                  key={pk}
                  className={ack.state === 'failed' ? s.bannerError : s.muted}
                  data-testid="device-config-ack"
                >
                  {m.name}:{' '}
                  {ack.state === 'saving'
                    ? 'saving device config…'
                    : ack.state === 'saved'
                      ? 'device config saved'
                      : `device config failed — ${ack.error ?? 'unknown error'}`}
                </div>
              );
            })}

          {grantNeeded && testTarget && (
            <>
              <div className={s.bannerError}>
                Wireless Debugging can&rsquo;t be enabled automatically yet — the one-time
                permission grant is missing. Connect this phone to the laptop over USB once and
                run:
              </div>
              <div className={cx(s.mono, s.muted)}>{WD_GRANT_CMD}</div>
              <div className={s.muted}>
                After that single grant, the toggle is zero-touch forever (survives reboots; a
                reinstall needs the grant again). Until then you can turn Wireless Debugging on by
                hand in Developer options:
              </div>
              <button className={s.btnSmall} onClick={() => void api().openWirelessDebugging()}>
                Open developer settings
              </button>
            </>
          )}

          {/* Manual-join fallback (CDX-028): scanning the pairing QR does this
              automatically; these two fields cover a QR-less setup. Both
              values are public and shown by `nvpn status` on the bridge. */}
          <div className={s.row}>
            <input
              className={cx(s.input, s.grow, s.mono)}
              value={adminNpub}
              placeholder="Admin device ID (npub…) — manual fallback"
              onChange={(e) => {
                setAdminNpub(e.target.value);
                setError('');
              }}
              autoCapitalize="none"
              autoCorrect="off"
            />
          </div>
          <div className={s.row}>
            <input
              className={cx(s.input, s.grow, s.mono)}
              value={networkId}
              placeholder="Network ID (e.g. a237c978)"
              onChange={(e) => {
                setNetworkId(e.target.value);
                setError('');
              }}
              autoCapitalize="none"
              autoCorrect="off"
            />
            <button
              className={s.btn}
              onClick={() => void joinManually()}
              disabled={busy || adminNpub.trim() === '' || networkId.trim() === ''}
            >
              {busy ? 'Working…' : 'Join'}
            </button>
          </div>

          {error && <div className={s.bannerError}>{error}</div>}
        </>
      )}
    </>
  );
}
