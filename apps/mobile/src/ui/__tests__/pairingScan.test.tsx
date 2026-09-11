// @vitest-environment jsdom
/**
 * CDX-011: QR camera scan on the pairing screen. The scanned string goes
 * through EXACTLY the pasted-link path (parsePairingUrl → beginPair) — these
 * tests mock only the platform camera seam and assert the same flow the
 * pairing tests already prove for pasted URLs.
 *
 * The pairing FSM itself (publish, await-ack timeout, the bridge's ack
 * landing) is `client_runtime::Core`'s job now (`Intent::BeginPairing`/
 * `BeginManualPairing`; see its own tests for that timing, including
 * CDX-040's "window may have closed" failure). What is left worth testing
 * here is: `parsePairingUrl` gating what reaches `beginPair` at all, the
 * exact dispatched Intent, and that `PairingScreen` renders each pairing
 * phase correctly — so awaiting-ack/paired/failed are reached by seeding the
 * fake core's `pairing` view directly, the way Rust's own events would.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { npubEncode } from 'nostr-tools/nip19';
import { buildFakePhoneCore, tick } from '../../core/__tests__/nativeCoreFixture';
import { generateKeypair } from '../../core/crypto';
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

async function makeCore() {
  const { phone, fake } = await buildFakePhoneCore();
  // Any begin-pairing dispatch moves the view to awaiting-ack with a
  // candidate the assertions below can check — same shape a real
  // `Intent::BeginPairing`/`BeginManualPairing` acceptance would produce.
  fake.onDispatch((intent) => {
    if (typeof intent === 'object' && 'beginPairing' in intent) {
      const url = new URL(intent.beginPairing.url.replace('codedeck://pair', 'https://pair'));
      fake.setView('pairing', {
        phase: 'awaiting-ack',
        candidate: {
          pubkeyHex: '', // not asserted in this path — see below
          npub: url.searchParams.get('npub') ?? '',
          machine: url.searchParams.get('machine') ?? '',
          relays: (url.searchParams.get('relays') ?? '').split(',').filter(Boolean),
        },
        error: null,
        timedOut: false,
        hasStaged: false,
      });
    } else if (typeof intent === 'object' && 'beginManualPairing' in intent) {
      fake.setView('pairing', {
        phase: 'awaiting-ack',
        candidate: { pubkeyHex: '', npub: intent.beginManualPairing.npub, machine: '', relays: [] },
        error: null,
        timedOut: false,
        hasStaged: false,
      });
    }
  });
  return { core: phone, fake };
}

function pairingUrlFor(bridge: { pubkeyHex: string }): string {
  const npub = npubEncode(bridge.pubkeyHex);
  return `codedeck://pair?npub=${npub}&relays=${encodeURIComponent('wss://r.example')}&machine=laptop&token=tok123`;
}

describe('PairingScreen QR scan', () => {
  it('a scanned pairing QR starts the pair flow (same path as a pasted link)', async () => {
    const { core, fake } = await makeCore();
    const bridge = generateKeypair();
    vi.mocked(qrScan.scanQrCode).mockResolvedValue(pairingUrlFor(bridge));

    render(
      <PhoneCoreProvider value={core}>
        <PairingScreen onDone={() => {}} />
      </PhoneCoreProvider>,
    );
    await act(async () => {
      fireEvent.click(screen.getByText('Scan pairing QR'));
      await tick();
    });

    // The flow leaves idle: candidate set, pair-request dispatched, awaiting ack.
    await waitFor(() => expect(core.pairing.getState().phase).toBe('awaiting-ack'));
    expect(core.pairing.getState().candidate?.machine).toBe('laptop');
    expect(fake.dispatched).toContainEqual(
      expect.objectContaining({ beginPairing: expect.objectContaining({ label: expect.any(String) }) }),
    );
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
    const { core, fake } = await makeCore();
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

    // The bridge answers with its real name (the manual URL never carried one)
    // — simulating what `client_runtime::Core`'s Router does on a real ack.
    await act(async () => {
      fake.setView('pairing', {
        phase: 'paired',
        candidate: { pubkeyHex: bridge.pubkeyHex, npub: npubEncode(bridge.pubkeyHex), machine: 'laptop', relays: [] },
        error: null,
        timedOut: false,
        hasStaged: false,
      });
      await tick();
    });

    // Device symptom: the overlay read "Paired with (manual)." — an apparently
    // empty name plus a stray parenthetical.
    const banner = await screen.findByText(/Paired with/i);
    expect(banner.textContent).toContain('laptop');
    expect(banner.textContent).not.toContain('(manual)');
  });

  it('CDX-040: a pairing attempt nothing answers ends in a failure message, not an endless spinner', async () => {
    const { core, fake } = await makeCore();
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

    // Nothing ever answers — simulating `client_runtime::Core`'s own deadline
    // resolving the attempt to a failure (its own test owns the timing).
    await act(async () => {
      fake.setView('pairing', {
        phase: 'failed',
        candidate: null,
        error: 'the pairing window may have closed',
        timedOut: true,
        hasStaged: false,
      });
      await tick();
    });

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
