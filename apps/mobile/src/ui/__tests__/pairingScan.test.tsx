// @vitest-environment jsdom
/**
 * CDX-011: QR camera scan on the pairing screen. The scanned string goes
 * through EXACTLY the pasted-link path (parsePairingUrl → beginPair) — these
 * tests mock only the platform camera seam and assert the same flow the
 * pairing tests already prove for pasted URLs.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { npubEncode } from 'nostr-tools/nip19';
import type { NostrEvent } from 'nostr-tools/core';
import type { PhoneCore } from '../../core/createPhoneCore';
import { createPhoneCore } from '../../core/createPhoneCore';
import { generateKeypair } from '../../core/crypto';
import { memoryKV, type PhoneTransport } from '../../core/ports';
import { PhoneCoreProvider } from '../coreContext';
import { PairingScreen } from '../screens/PairingScreen';
import * as qrScan from '../../platform/qrScan';

vi.mock('../../platform/qrScan', () => ({
  qrScanAvailable: vi.fn(() => true),
  scanQrCode: vi.fn(async () => null),
}));

afterEach(() => {
  cleanup();
  vi.mocked(qrScan.qrScanAvailable).mockReturnValue(true);
  vi.mocked(qrScan.scanQrCode).mockReset();
});

async function makeCore(
  extra: { pairTimeoutMs?: number } = {},
): Promise<{ core: PhoneCore; published: NostrEvent[] }> {
  const published: NostrEvent[] = [];
  const transport: PhoneTransport = {
    subscribe: () => ({ close: () => {} }),
    publish: async (event) => {
      published.push(event);
      return true;
    },
  };
  const core = await createPhoneCore({ kv: memoryKV(), transport, ...extra });
  return { core, published };
}

function pairingUrlFor(bridge: { pubkeyHex: string }): string {
  const npub = npubEncode(bridge.pubkeyHex);
  return `codedeck://pair?npub=${npub}&relays=${encodeURIComponent('wss://r.example')}&machine=laptop&token=tok123`;
}

describe('PairingScreen QR scan', () => {
  it('a scanned pairing QR starts the pair flow (same path as a pasted link)', async () => {
    const { core, published } = await makeCore();
    const bridge = generateKeypair();
    vi.mocked(qrScan.scanQrCode).mockResolvedValue(pairingUrlFor(bridge));

    render(
      <PhoneCoreProvider value={core}>
        <PairingScreen onDone={() => {}} />
      </PhoneCoreProvider>,
    );
    fireEvent.click(screen.getByText('Scan pairing QR'));

    // The flow leaves idle: candidate set, pair-request published, awaiting ack.
    await waitFor(() => expect(core.pairing.getState().phase).toBe('awaiting-ack'));
    expect(core.pairing.getState().candidate?.pubkeyHex).toBe(bridge.pubkeyHex);
    expect(core.pairing.getState().candidate?.machine).toBe('laptop');
    expect(published.length).toBeGreaterThan(0); // the encrypted pair-request left
    expect(screen.getByText(/waiting for the bridge/i)).toBeTruthy();
  });

  it('a scanned non-pairing QR surfaces the parse error and fills the URL box for fixing', async () => {
    const { core } = await makeCore();
    vi.mocked(qrScan.scanQrCode).mockResolvedValue('https://example.com/not-a-pairing-qr');

    render(
      <PhoneCoreProvider value={core}>
        <PairingScreen onDone={() => {}} />
      </PhoneCoreProvider>,
    );
    fireEvent.click(screen.getByText('Scan pairing QR'));

    await screen.findByText(/not a codedeck:\/\/pair URL/i);
    expect(core.pairing.getState().phase).toBe('idle');
    expect(
      (screen.getByPlaceholderText('codedeck://pair?npub=…') as HTMLTextAreaElement).value,
    ).toBe('https://example.com/not-a-pairing-qr');
  });

  it('CDX-041: the manual-pair confirmation renders the real machine name, not "(manual)"', async () => {
    const { core } = await makeCore();
    const bridge = generateKeypair();

    render(
      <PhoneCoreProvider value={core}>
        <PairingScreen onDone={() => {}} />
      </PhoneCoreProvider>,
    );

    fireEvent.change(screen.getByPlaceholderText('npub1…'), {
      target: { value: npubEncode(bridge.pubkeyHex) },
    });
    fireEvent.change(screen.getByPlaceholderText('token from the bridge pairing screen'), {
      target: { value: 'tok123' },
    });
    fireEvent.click(screen.getByText('Pair manually'));
    await waitFor(() => expect(core.pairing.getState().phase).toBe('awaiting-ack'));

    // The bridge answers with its real name (the manual URL never carried one).
    core.pairing
      .getState()
      .handlePairAck(bridge.pubkeyHex, { type: 'pair-ack', machine: 'laptop', ok: true });

    // Device symptom: the overlay read "Paired with (manual)." — an apparently
    // empty name plus a stray parenthetical.
    const banner = await screen.findByText(/Paired with/i);
    expect(banner.textContent).toContain('laptop');
    expect(banner.textContent).not.toContain('(manual)');
  });

  it('CDX-040: a pairing attempt nothing answers ends in a failure message, not an endless spinner', async () => {
    const { core } = await makeCore({ pairTimeoutMs: 50 });
    const bridge = generateKeypair();

    render(
      <PhoneCoreProvider value={core}>
        <PairingScreen onDone={() => {}} />
      </PhoneCoreProvider>,
    );

    fireEvent.change(screen.getByPlaceholderText('npub1…'), {
      target: { value: npubEncode(bridge.pubkeyHex) },
    });
    fireEvent.change(screen.getByPlaceholderText('token from the bridge pairing screen'), {
      target: { value: 'stale-token' },
    });
    fireEvent.click(screen.getByText('Pair manually'));

    // The stuck state from the device run: waiting, with Cancel the only way out.
    await waitFor(() => expect(core.pairing.getState().phase).toBe('awaiting-ack'));
    expect(screen.getByText('Cancel')).toBeTruthy();

    // Nothing ever answers (the bridge's window is already closed, so it is not
    // even subscribed to nack). The phone's own deadline resolves it.
    const banner = await screen.findByText(/Pairing failed/i);
    expect(banner.textContent).toMatch(/window may have closed/i);
    expect(core.pairing.getState().phase).toBe('failed');
    // ...and the form is back, so a retry does not need an app restart.
    expect(screen.getByText('Pair manually')).toBeTruthy();
  });

  it('cancelled scan (null) does nothing; unavailable hides the button entirely', async () => {
    const { core } = await makeCore();
    vi.mocked(qrScan.scanQrCode).mockResolvedValue(null);
    const first = render(
      <PhoneCoreProvider value={core}>
        <PairingScreen onDone={() => {}} />
      </PhoneCoreProvider>,
    );
    fireEvent.click(screen.getByText('Scan pairing QR'));
    await Promise.resolve();
    expect(core.pairing.getState().phase).toBe('idle');
    expect(screen.queryByText(/not a codedeck/i)).toBeNull();
    first.unmount();

    // Desktop/browser: no camera — no button (paste + deep link remain).
    vi.mocked(qrScan.qrScanAvailable).mockReturnValue(false);
    render(
      <PhoneCoreProvider value={core}>
        <PairingScreen onDone={() => {}} />
      </PhoneCoreProvider>,
    );
    expect(screen.queryByText('Scan pairing QR')).toBeNull();
  });
});
