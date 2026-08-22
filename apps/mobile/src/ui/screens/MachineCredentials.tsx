/**
 * Machine credentials (CDX-011) — per-machine set-credentials UI + the
 * formerly-unrouted credentials-ack feedback.
 *
 * Semantics match the bridge handler (ported from the old standalone bridge):
 * a field left EMPTY is not sent (leaves the stored value alone), a filled
 * field overwrites, the explicit Clear buttons send null (delete). The bridge
 * stores values in host storage, feeds them into the Claude SDK subprocess env
 * at session spawn, optionally 1-token-validates the API key, and answers with
 * a credentials-ack — rendered here as saving / saved (+ key-valid verdict) /
 * failed. Ack state is transient (uiStore) — a fresh boot makes no claims.
 *
 * The inputs are password fields and the draft is cleared on send; credential
 * values are never logged and never echoed back over the wire.
 */
import { useState } from 'react';
import { usePhoneCore, useUi } from '../coreContext';
import { cx, shared as s } from '../shared';

export function MachineCredentials({ machinePubkey }: { machinePubkey: string }) {
  const core = usePhoneCore();
  const status = useUi((st) => st.credentialsStatus[machinePubkey]);
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [pat, setPat] = useState('');

  const send = (creds: { anthropicApiKey?: string | null; githubPat?: string | null }): void => {
    core.ui.getState().noteCredentialsSent(machinePubkey);
    void core.api.setCredentials(machinePubkey, creds);
  };

  const save = (): void => {
    const creds = {
      ...(apiKey.trim() !== '' ? { anthropicApiKey: apiKey.trim() } : {}),
      ...(pat.trim() !== '' ? { githubPat: pat.trim() } : {}),
    };
    if (Object.keys(creds).length === 0) return;
    send(creds);
    setApiKey('');
    setPat('');
  };

  if (!open) {
    return (
      <button className={s.btn} onClick={() => setOpen(true)}>
        Machine credentials…
      </button>
    );
  }

  return (
    <div className={s.field} data-testid="machine-credentials">
      <label>Machine credentials</label>
      <div className={s.muted}>
        Stored on the bridge host and fed into Claude Code sessions started
        there (API key / GitHub token). Leave a field empty to keep the current
        value.
      </div>
      <input
        className={cx(s.input, s.mono)}
        type="password"
        value={apiKey}
        placeholder="ANTHROPIC_API_KEY (sk-ant-…)"
        aria-label="Anthropic API key"
        onChange={(e) => setApiKey(e.target.value)}
        autoCapitalize="none"
        autoCorrect="off"
      />
      <input
        className={cx(s.input, s.mono)}
        type="password"
        value={pat}
        placeholder="GitHub PAT (ghp_…)"
        aria-label="GitHub PAT"
        onChange={(e) => setPat(e.target.value)}
        autoCapitalize="none"
        autoCorrect="off"
      />
      <div className={s.row}>
        <button
          className={cx(s.btnPrimary, s.grow)}
          onClick={save}
          disabled={apiKey.trim() === '' && pat.trim() === ''}
        >
          Save on bridge
        </button>
        <button className={s.btnSmall} onClick={() => send({ anthropicApiKey: null })}>
          Clear key
        </button>
        <button className={s.btnSmall} onClick={() => send({ githubPat: null })}>
          Clear PAT
        </button>
        <button className={s.btnSmall} onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      {status && (
        <div
          className={status.state === 'failed' ? s.bannerError : s.muted}
          data-testid="credentials-status"
        >
          {status.state === 'saving' && 'Saving on the bridge…'}
          {status.state === 'saved' &&
            `Saved · API key: ${status.hasAnthropicKey ? 'set' : 'none'}${
              status.keyValid !== undefined ? (status.keyValid ? ' (valid)' : ' (INVALID)') : ''
            } · GitHub PAT: ${status.hasGithubPat ? 'set' : 'none'}`}
          {status.state === 'failed' && `Saving failed: ${status.error ?? 'unknown error'}`}
        </div>
      )}
    </div>
  );
}
