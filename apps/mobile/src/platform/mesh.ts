/**
 * Mesh (nostr-vpn) client — the phone side of CodeDeck's embedded FIPS mesh,
 * ported from the old app's services/meshClient.ts (Phase 5d).
 *
 * All calls go through `tauri-plugin-mesh`'s Android VpnService; on desktop the
 * plugin's commands are compiled no-ops (empty state), and in plain-browser dev
 * the invoke import fails — both degrade to null so the UI can show a
 * "mobile only" note instead of dead buttons.
 *
 * Plugin commands (see apps/mobile/tauri-plugin-mesh):
 *   plugin:mesh|mesh_status              -> { running, state_json }
 *   plugin:mesh|join_mesh                -> { running, state_json }  (VPN consent on first use)
 *   plugin:mesh|leave_mesh               -> { running, state_json }
 *   plugin:mesh|mesh_action              -> { state_json }           (engine action passthrough)
 *   plugin:mesh|open_wireless_debugging  -> opens Android dev settings
 *   plugin:mesh|prepare_adb              -> { enabled }              (WRITE_SECURE_SETTINGS)
 *
 * The pure state parsing lives here too (exported, unit-tested): the engine's
 * `state_json` (UiState) is the wire format the DEPLOYED mesh network speaks —
 * field names (`tunnelIp`, `ownPubkeyHex`, `networks[].enabled`) must stay
 * exactly as nvpn emits them.
 */
import type { Logger } from '../core/ports';

export interface MeshStatus {
  running: boolean;
  state_json: string;
}

/** A minimal view of the engine's UiState JSON we care about. The engine emits
 *  much more; we only read what the section displays so we don't couple to the
 *  full schema. NOTE: there is NO top-level `activeNetwork` object — nvpn's own
 *  UI derives it as `networks.firstOrNull { it.enabled }` (Models.kt). We
 *  mirror that exactly. The local mesh address is the top-level `tunnelIp`. */
export interface MeshNetwork {
  id?: string;
  name?: string;
  enabled?: boolean;
  networkId?: string;
}
export interface MeshState {
  vpnEnabled?: boolean;
  vpnActive?: boolean;
  tunnelIp?: string;
  ownPubkeyHex?: string;
  connectedPeerCount?: number;
  expectedPeerCount?: number;
  networks?: MeshNetwork[];
  error?: string;
}

export function parseMeshState(json: string): MeshState {
  if (!json) return {};
  try {
    return JSON.parse(json) as MeshState;
  } catch {
    return {};
  }
}

/** The active network = first enabled network, mirroring nvpn's `AppState.activeNetwork`. */
export function activeNetwork(s: MeshState): MeshNetwork | undefined {
  return s.networks?.find((n) => n.enabled) ?? s.networks?.[0];
}

export interface MeshIdentity {
  /** The phone's real mesh tunnel IP, e.g. "10.44.126.167" (no /32). */
  meshIp: string;
  /** The phone's mesh-engine pubkey (hex) — the identity the bridge authorizes on the roster. */
  meshPubkey: string;
}

/**
 * Extract the phone's OWN mesh identity (tunnel IP + mesh pubkey) from the
 * engine state. The mesh VpnService runs its own nostr key, separate from the
 * app/bridge key, so this is the only authoritative source for the device's
 * adb-reachable mesh IP. Returns null while the engine hasn't assigned a
 * tunnel IP yet.
 */
export function extractMeshIdentity(stateJson: string): MeshIdentity | null {
  const st = parseMeshState(stateJson);
  const meshIp = (st.tunnelIp || '').split('/')[0]!.trim();
  const meshPubkey = (st.ownPubkeyHex || '').trim();
  if (!/^10\.44\.\d{1,3}\.\d{1,3}$/.test(meshIp) || !/^[0-9a-f]{64}$/i.test(meshPubkey)) {
    return null;
  }
  return { meshIp, meshPubkey };
}

/** The Tauri command surface of the mesh plugin. Null results = unavailable. */
export interface MeshApi {
  status(): Promise<MeshStatus | null>;
  /** Bring the tunnel up (Android VPN consent dialog on first use; rejects →
   *  null + the error surfaced via the thrown message when `throwOnError`). */
  join(): Promise<MeshStatus | null>;
  leave(): Promise<MeshStatus | null>;
  /** Generic engine-action passthrough (manual_add_network, settings, ...). */
  action(actionJson: string): Promise<{ state_json: string } | null>;
  openWirelessDebugging(): Promise<void>;
  /** Enable Wireless Debugging via WRITE_SECURE_SETTINGS (granted once over
   *  USB). `enabled:false` = the one-time grant hasn't been done. */
  prepareAdb(): Promise<{ enabled: boolean } | null>;
}

/** Production impl over the plugin commands. join() re-throws (the UI shows a
 *  denied VPN consent); everything else swallows to null. */
export function tauriMeshApi(log?: Logger): MeshApi {
  const invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> => {
    try {
      const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
      return await tauriInvoke<T>(`plugin:mesh|${cmd}`, args);
    } catch (err) {
      log?.(`[Mesh] ${cmd} failed: ${err}`);
      return null;
    }
  };
  return {
    status: () => invoke<MeshStatus>('mesh_status'),
    join: async () => {
      // join_mesh rejects when the user denies the VPN consent dialog —
      // surface that instead of silently returning null.
      const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
      return tauriInvoke<MeshStatus>('plugin:mesh|join_mesh');
    },
    leave: () => invoke<MeshStatus>('leave_mesh'),
    action: (actionJson) => invoke<{ state_json: string }>('mesh_action', { actionJson }),
    openWirelessDebugging: async () => void (await invoke('open_wireless_debugging')),
    prepareAdb: () => invoke<{ enabled: boolean }>('prepare_adb'),
  };
}

/**
 * Join a mesh network via the engine's MANUAL-JOIN flow (CDX-028: nvpn 4.1.x
 * removed bearer invites; the phone's 4.0.x core supports `manual_add_network`
 * — the equivalent of `nvpn join-manual --admin-device-id <npub> --network-id
 * <id>`). Registers the network + admin and waits for the admin's signed
 * roster; the admin side must run `add-device --publish` for this device.
 * Idempotent on the native side. True on success (engine reported no error).
 */
export async function manualAddNetwork(
  api: MeshApi,
  adminNpub: string,
  meshNetworkId: string,
): Promise<boolean> {
  const admin = adminNpub.trim();
  const netId = meshNetworkId.trim();
  if (!admin.startsWith('npub1') || !netId) return false;
  const res = await api.action(
    JSON.stringify({ type: 'manual_add_network', adminNpub: admin, meshNetworkId: netId }),
  );
  if (!res) return false;
  const st = parseMeshState(res.state_json);
  return !st.error;
}

/** Read the phone's mesh identity, polling briefly — the engine may take a
 *  moment to assign the tunnel IP after connect (ported RolePrompt loop). */
export async function getMeshIdentity(
  api: MeshApi,
  attempts = 5,
  delayMs = 600,
): Promise<MeshIdentity | null> {
  for (let i = 0; i < attempts; i++) {
    const s = await api.status();
    const identity = s?.state_json ? extractMeshIdentity(s.state_json) : null;
    if (identity) return identity;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}
