/**
 * Pairing screen — in-app QR camera scan (CDX-011; mobile only), deep-link/
 * pasted pairing URL, manual npub+token fallback, flow states from the pairing
 * store, paired confirmation. A scanned QR goes through exactly the same
 * parsePairingUrl → beginPair path as a pasted link. Android deep links from
 * the bridge QR arrive via tauri-plugin-deep-link (wired in main.tsx).
 */
import { useState } from 'react';
import { parsePairingUrl } from '../../core/stores/pairing';
import { qrScanAvailable, scanQrCode } from '../../platform/qrScan';
import { usePairing, usePhoneCore } from '../coreContext';
import { PHONE_LABEL } from '../label';
import { cx, shared as s } from '../shared';
import styles from './PairingScreen.module.css';

export function PairingScreen({ onDone }: { onDone(): void }) {
  const core = usePhoneCore();
  const phase = usePairing((st) => st.phase);
  const flowError = usePairing((st) => st.error);
  const candidate = usePairing((st) => st.candidate);
  const staged = usePairing((st) => st.staged);
  const npub = useStoreIdentityNpub();

  const [url, setUrl] = useState('');
  const [manualNpub, setManualNpub] = useState('');
  const [manualToken, setManualToken] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);

  const startFromUrl = (): void => {
    const parsed = parsePairingUrl(url);
    if (!parsed.ok) {
      setParseError(parsed.error);
      return;
    }
    setParseError(null);
    core.pairing.getState().beginPair(parsed.parts, PHONE_LABEL);
  };

  // Scanned QR content is parsed EXACTLY like a pasted link — one path.
  const startFromScan = async (): Promise<void> => {
    const scanned = await scanQrCode();
    if (scanned === null) return; // cancelled / denied / unavailable — no error
    const parsed = parsePairingUrl(scanned);
    if (!parsed.ok) {
      setUrl(scanned); // let the user see (and fix) what the camera read
      setParseError(parsed.error);
      return;
    }
    setParseError(null);
    core.pairing.getState().beginPair(parsed.parts, PHONE_LABEL);
  };

  const startManual = (): void => {
    const result = core.pairing.getState().beginManualPair(manualNpub, manualToken, PHONE_LABEL);
    setParseError(result.ok ? null : (result.error ?? 'invalid input'));
  };

  // CDX-013: a deep link arrived without direct user action — show what it
  // wants to pair with and require an explicit tap. Nothing has been sent yet.
  if (staged && phase === 'idle') {
    return (
      <div className={s.screen} data-testid="staged-pairing-confirm">
        <div className={s.banner}>
          A pairing link wants to connect this phone to a machine. Only continue
          if YOU opened this link (e.g. from your own bridge).
        </div>
        <div className={s.card}>
          <div><b>Machine:</b> {staged.machine}</div>
          <div><b>Bridge npub:</b> {staged.npub.slice(0, 12)}…{staged.npub.slice(-6)}</div>
          <div><b>Relays:</b> {staged.relays.join(', ')}</div>
          {staged.meshAdmin && staged.netid && (
            <div><b>Includes mesh (VPN) join info.</b></div>
          )}
        </div>
        <button
          className={s.btnPrimary}
          onClick={() => core.pairing.getState().confirmStaged(PHONE_LABEL)}
        >
          Pair with {staged.machine}
        </button>
        <button className={s.btn} onClick={() => core.pairing.getState().dismissStaged()}>
          Dismiss
        </button>
      </div>
    );
  }

  if (phase === 'awaiting-ack') {
    return (
      <div className={s.screen}>
        <div className={s.banner}>
          Pairing with <b>{candidate?.machine ?? 'bridge'}</b>… waiting for the
          bridge to answer (the pairing window on the bridge must be open).
        </div>
        <button className={s.btn} onClick={() => core.pairing.getState().reset()}>
          Cancel
        </button>
      </div>
    );
  }

  if (phase === 'paired') {
    return (
      <div className={s.screen}>
        <div className={s.bannerOk}>
          Paired with <b>{candidate?.machine ?? 'bridge'}</b>.
        </div>
        <button
          className={s.btnPrimary}
          onClick={() => {
            core.pairing.getState().reset();
            onDone();
          }}
        >
          Go to machines
        </button>
      </div>
    );
  }

  return (
    <div className={s.screen}>
      {phase === 'failed' && (
        <div className={s.bannerError}>
          Pairing failed: {flowError ?? 'rejected'}. Open a fresh pairing window
          on the bridge and try again.
        </div>
      )}
      {parseError && <div className={s.bannerError}>{parseError}</div>}

      {qrScanAvailable() && (
        <button className={s.btnPrimary} onClick={() => void startFromScan()}>
          Scan pairing QR
        </button>
      )}

      <div className={s.field}>
        <label>Pairing link (from the bridge QR / `codedeck pair`)</label>
        <textarea
          className={styles.pairTextarea}
          rows={3}
          value={url}
          placeholder="codedeck://pair?npub=…"
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>
      <button className={s.btnPrimary} onClick={startFromUrl} disabled={url.trim() === ''}>
        Pair with link
      </button>

      <div className={styles.divider}>or manually</div>

      <div className={s.field}>
        <label>Bridge npub</label>
        <input
          className={cx(s.input, s.mono)}
          value={manualNpub}
          placeholder="npub1…"
          onChange={(e) => setManualNpub(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
        />
      </div>
      <div className={s.field}>
        <label>One-time token</label>
        <input
          className={cx(s.input, s.mono)}
          value={manualToken}
          placeholder="token from the bridge pairing screen"
          onChange={(e) => setManualToken(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
        />
      </div>
      <button
        className={s.btn}
        onClick={startManual}
        disabled={manualNpub.trim() === '' || manualToken.trim() === ''}
      >
        Pair manually
      </button>

      <div className={s.field}>
        <label>This phone's npub</label>
        <div className={s.mono}>{npub}</div>
      </div>
    </div>
  );
}

function useStoreIdentityNpub(): string {
  const core = usePhoneCore();
  return core.identity.getState().npub;
}
