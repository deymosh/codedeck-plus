/**
 * Mesh client — pure engine-state parsing (the nvpn UiState wire format the
 * DEPLOYED network speaks) + the manual-join/identity helpers over a fake
 * MeshApi.
 */
import { describe, it, expect } from 'vitest';
import {
  activeNetwork,
  extractMeshIdentity,
  getMeshIdentity,
  manualAddNetwork,
  parseMeshState,
  type MeshApi,
  type MeshStatus,
} from '../mesh';

const HEX = 'c1cf657c71ce41b45f2c4f323f688cd9f01b8c2ddc2b3a05bfab4007c40a6bdc';

function fakeApi(overrides: Partial<MeshApi>): MeshApi {
  return {
    status: async () => null,
    join: async () => null,
    leave: async () => null,
    action: async () => null,
    openWirelessDebugging: async () => {},
    prepareAdb: async () => null,
    ...overrides,
  };
}

describe('parseMeshState / activeNetwork', () => {
  it('parses the engine UiState and derives the active network like nvpn does (first enabled)', () => {
    const state = parseMeshState(
      JSON.stringify({
        tunnelIp: '10.44.126.167',
        networks: [
          { id: '1', name: 'other', enabled: false, networkId: 'deadbeef' },
          { id: '2', name: 'office', enabled: true, networkId: 'a237c978' },
        ],
      }),
    );
    expect(activeNetwork(state)?.networkId).toBe('a237c978');
  });

  it('falls back to the first network when none is enabled, and survives garbage', () => {
    expect(activeNetwork(parseMeshState('{"networks":[{"id":"x"}]}'))?.id).toBe('x');
    expect(parseMeshState('not json')).toEqual({});
    expect(parseMeshState('')).toEqual({});
    expect(activeNetwork({})).toBeUndefined();
  });
});

describe('extractMeshIdentity', () => {
  it('reads tunnelIp (stripping /32) + ownPubkeyHex — the engine key, not the app key', () => {
    const id = extractMeshIdentity(
      JSON.stringify({ tunnelIp: '10.44.126.167/32', ownPubkeyHex: HEX }),
    );
    expect(id).toEqual({ meshIp: '10.44.126.167', meshPubkey: HEX });
  });

  it('rejects non-mesh IPs and malformed pubkeys', () => {
    expect(
      extractMeshIdentity(JSON.stringify({ tunnelIp: '192.168.1.5', ownPubkeyHex: HEX })),
    ).toBeNull();
    expect(
      extractMeshIdentity(JSON.stringify({ tunnelIp: '10.44.1.2', ownPubkeyHex: 'nope' })),
    ).toBeNull();
    expect(extractMeshIdentity('')).toBeNull();
  });
});

describe('manualAddNetwork', () => {
  it('dispatches manual_add_network with adminNpub + meshNetworkId (trimmed) and succeeds when the engine has no error', async () => {
    const actions: string[] = [];
    const api = fakeApi({
      action: async (json) => {
        actions.push(json);
        return { state_json: JSON.stringify({ networks: [{ enabled: true }] }) };
      },
    });
    expect(await manualAddNetwork(api, ' npub1admin ', ' a237c978 ')).toBe(true);
    // Field names are the 4.0.x app core's wire format — must stay exact.
    expect(JSON.parse(actions[0]!)).toEqual({
      type: 'manual_add_network',
      adminNpub: 'npub1admin',
      meshNetworkId: 'a237c978',
    });
  });

  it('fails on a non-npub admin id, empty network id, plugin unavailability, and engine errors', async () => {
    // The admin device id must be an npub — hex or garbage never reaches the engine.
    const actions: string[] = [];
    const spying = fakeApi({
      action: async (json) => {
        actions.push(json);
        return { state_json: '{}' };
      },
    });
    expect(await manualAddNetwork(spying, 'deadbeef', 'a237c978')).toBe(false);
    expect(await manualAddNetwork(spying, 'npub1admin', '   ')).toBe(false);
    expect(actions).toEqual([]);

    expect(await manualAddNetwork(fakeApi({ action: async () => null }), 'npub1a', 'x')).toBe(false);
    expect(
      await manualAddNetwork(
        fakeApi({ action: async () => ({ state_json: JSON.stringify({ error: 'no such network' }) }) }),
        'npub1a',
        'x',
      ),
    ).toBe(false);
  });
});

describe('getMeshIdentity', () => {
  it('polls until the engine assigns a tunnel IP', async () => {
    let calls = 0;
    const api = fakeApi({
      status: async (): Promise<MeshStatus> => {
        calls++;
        return {
          running: true,
          state_json:
            calls < 3
              ? JSON.stringify({ ownPubkeyHex: HEX }) // no IP yet
              : JSON.stringify({ tunnelIp: '10.44.0.9', ownPubkeyHex: HEX }),
        };
      },
    });
    const id = await getMeshIdentity(api, 5, 1);
    expect(id).toEqual({ meshIp: '10.44.0.9', meshPubkey: HEX });
    expect(calls).toBe(3);
  });

  it('gives up after the attempt budget', async () => {
    const api = fakeApi({ status: async () => ({ running: false, state_json: '' }) });
    expect(await getMeshIdentity(api, 2, 1)).toBeNull();
  });
});
