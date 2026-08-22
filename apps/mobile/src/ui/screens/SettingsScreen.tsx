/**
 * Settings — UI scale (locked decision #4: auto by screen size × this manual
 * multiplier, live preview because useUiScale reacts to the store), the
 * stay-connected foreground-service toggle (Phase 5c: the settings store
 * drives the service via the attached controller; this screen only flips the
 * store and shows the service's true state), and relay management (plan §6:
 * every component supports manually adding relays).
 */
import { useEffect, useState } from 'react';
import {
  effortLevelSchema,
  permissionModeSchema,
  type EffortLevel,
  type PermissionMode,
} from '@codedeck/protocol';
import { MODE_LABELS } from '../../core/modeCycle';
import { UI_SCALE_DEFAULT, UI_SCALE_MAX, UI_SCALE_MIN } from '../../core/stores/settings';
import { tauriServiceApi } from '../../platform/foregroundService';
import { useMachines, useQuickPrompts, useSettings, usePhoneCore } from '../coreContext';
import { cx, shared as s } from '../shared';
import { MachineCredentials } from './MachineCredentials';
import { MachineProviders } from './MachineProviders';
import { MeshSection } from './MeshSection';
import styles from './SettingsScreen.module.css';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const MODE_OPTIONS = permissionModeSchema.options;
const EFFORT_OPTIONS = effortLevelSchema.options;

export function SettingsScreen() {
  const core = usePhoneCore();
  const machines = useMachines((st) => st.machines);
  const relays = useSettings((st) => st.relays);
  const uiScale = useSettings((st) => st.uiScale);
  const stayConnected = useSettings((st) => st.stayConnected);
  const torProxyEnabled = useSettings((st) => st.torProxyEnabled);
  const blossomServer = useSettings((st) => st.blossomServer);
  const defaultMode = useSettings((st) => st.defaultMode);
  const defaultEffort = useSettings((st) => st.defaultEffort);
  const defaultModel = useSettings((st) => st.defaultModel);
  const notificationsEnabled = useSettings((st) => st.notificationsEnabled);
  const showUsageBadge = useSettings((st) => st.showUsageBadge);
  const showCommitBadge = useSettings((st) => st.showCommitBadge);
  const [draft, setDraft] = useState('');
  const [blossomDraft, setBlossomDraft] = useState(blossomServer);
  const [error, setError] = useState<string | null>(null);
  const [serviceRunning, setServiceRunning] = useState<boolean | null>(null);
  // Which machine's Remove is awaiting its confirm step (Phase 2b).
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  // Default-model choices (CDX-047): the union of every paired machine's
  // SDK-reported model list, deduped by id.
  const modelUnion = Object.values(machines)
    .flatMap((m) => m.models ?? [])
    .filter((m, i, all) => all.findIndex((x) => x.id === m.id) === i);

  // Quick prompts editor (CDX-049): one add form + per-entry edit/delete.
  const quickPrompts = useQuickPrompts((st) => st.prompts);
  const [qpLabel, setQpLabel] = useState('');
  const [qpText, setQpText] = useState('');
  const [qpEditing, setQpEditing] = useState<string | null>(null);
  const [qpEditLabel, setQpEditLabel] = useState('');
  const [qpEditText, setQpEditText] = useState('');

  // Show the service's TRUE state (Android; desktop/browser: always off).
  // Poll while the screen is open — the controller starts/stops the service
  // asynchronously after a toggle.
  useEffect(() => {
    if (!isTauri) {
      setServiceRunning(false);
      return;
    }
    const api = tauriServiceApi();
    let cancelled = false;
    const refresh = (): void => {
      void api.isRunning().then((running) => {
        if (!cancelled) setServiceRunning(running);
      });
    };
    refresh();
    const interval = setInterval(refresh, 2_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [stayConnected]);

  const add = (): void => {
    const url = draft.trim();
    if (!/^wss?:\/\/.+/.test(url)) {
      setError('relay URLs start with wss:// (or ws:// for local dev)');
      return;
    }
    setError(null);
    core.settings.getState().addRelay(url);
    setDraft('');
  };

  return (
    <div className={s.screen}>
      <div className={styles.sectionTitle}>UI scale</div>
      <div className={styles.scaleRow}>
        <input
          className={styles.slider}
          type="range"
          aria-label="UI scale"
          min={UI_SCALE_MIN}
          max={UI_SCALE_MAX}
          step={0.05}
          value={uiScale}
          onChange={(e) => core.settings.getState().setUiScale(Number(e.target.value))}
        />
        <span className={styles.scaleValue}>{Math.round(uiScale * 100)}%</span>
        <button
          className={s.btnSmall}
          onClick={() => core.settings.getState().setUiScale(UI_SCALE_DEFAULT)}
          disabled={uiScale === UI_SCALE_DEFAULT}
        >
          Reset
        </button>
      </div>
      <div className={s.muted}>
        The whole interface previews live. Base size adapts to the screen
        automatically; this multiplies it.
      </div>

      {/* Preferences (CDX-047): defaults for NEW sessions. Mode is applied by
          sending a mode change after session-ready (the bridge starts in
          plan); effort/model ride the create-session message via
          NewSessionModal's pre-selection. */}
      <div className={styles.sectionTitle}>Preferences</div>
      <div className={styles.prefRow}>
        <span className={styles.prefLabel}>Default mode</span>
        <select
          className={styles.select}
          aria-label="Default mode"
          value={defaultMode}
          onChange={(e) =>
            core.settings.getState().setDefaultMode(e.target.value as PermissionMode)
          }
        >
          {MODE_OPTIONS.map((mode) => (
            <option key={mode} value={mode}>
              {MODE_LABELS[mode]}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.prefRow}>
        <span className={styles.prefLabel}>Default effort</span>
        <select
          className={styles.select}
          aria-label="Default effort"
          value={defaultEffort}
          onChange={(e) =>
            core.settings.getState().setDefaultEffort(e.target.value as EffortLevel | '')
          }
        >
          <option value="">Default (auto)</option>
          {EFFORT_OPTIONS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.prefRow}>
        <span className={styles.prefLabel}>Default model</span>
        <select
          className={styles.select}
          aria-label="Default model"
          value={defaultModel}
          onChange={(e) => core.settings.getState().setDefaultModel(e.target.value)}
        >
          <option value="">Bridge default</option>
          {modelUnion.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label ?? m.id}
            </option>
          ))}
          {defaultModel !== '' && !modelUnion.some((m) => m.id === defaultModel) && (
            <option value={defaultModel}>{defaultModel}</option>
          )}
        </select>
      </div>
      <div className={s.muted}>
        Applied to new sessions: the mode is switched right after the session
        starts; effort and model pre-fill the new-session sheet. Models come
        from every paired machine's reported list.
      </div>

      {/* Notifications & badges (CDX-048). The master toggle gates the whole
          coordinator seam in core/notifications — OS notifications AND the
          ping chime; the badge toggles hide the usage box (session header)
          and the committed badge (sidebar cards). */}
      <div className={styles.sectionTitle}>Notifications &amp; badges</div>
      <label className={styles.toggleRow}>
        <input
          type="checkbox"
          checked={notificationsEnabled}
          onChange={(e) => core.settings.getState().setNotificationsEnabled(e.target.checked)}
        />
        <span>Notifications (system notifications and the attention chime)</span>
      </label>
      <label className={styles.toggleRow}>
        <input
          type="checkbox"
          checked={showUsageBadge}
          onChange={(e) => core.settings.getState().setShowUsageBadge(e.target.checked)}
        />
        <span>Show usage badge (5h/7d limits in the session header)</span>
      </label>
      <label className={styles.toggleRow}>
        <input
          type="checkbox"
          checked={showCommitBadge}
          onChange={(e) => core.settings.getState().setShowCommitBadge(e.target.checked)}
        />
        <span>Show commit badge on session cards</span>
      </label>

      <div className={styles.sectionTitle}>Stay connected</div>
      <div className={styles.scaleRow}>
        <label className={styles.toggleRow}>
          <input
            type="checkbox"
            checked={stayConnected}
            onChange={(e) => core.settings.getState().setStayConnected(e.target.checked)}
          />
          <span>Keep the connection alive in the background</span>
        </label>
        {serviceRunning !== null && (
          <span className={serviceRunning ? s.badgeLive : s.badgeOffline}>
            {serviceRunning ? 'service running' : 'service off'}
          </span>
        )}
      </div>
      <div className={s.muted}>
        Android only: a foreground service holds the process and radio awake
        (persistent notification shows the live connection state). It asks for
        notification permission on first start. Off = the OS may pause CodeDeck
        in the background; it resyncs when you return.
      </div>

      <div className={styles.sectionTitle}>Route through Orbot</div>
      <label className={styles.toggleRow}>
        <input
          type="checkbox"
          checked={torProxyEnabled}
          onChange={(e) => core.settings.getState().setTorProxyEnabled(e.target.checked)}
        />
        <span>Route relay traffic through Orbot (SOCKS5)</span>
      </label>
      <div className={s.muted}>
        Android only. Requires Orbot installed and running with its SOCKS
        proxy enabled (127.0.0.1:9050 by default) — this does not launch or
        manage Orbot itself. Fully applied on the next app restart; toggling
        while running only affects NEW connections, not ones already open.
      </div>

      <MeshSection />

      {/* Quick prompts (CDX-049): the entries render as tappable shortcut
          boxes above the session input bar; a tap inserts the text into the
          draft. Empty list = no bar. */}
      <div className={styles.sectionTitle}>Quick prompts</div>
      {quickPrompts.map((qp) =>
        qpEditing === qp.id ? (
          <div key={qp.id} className={s.card} data-testid="quick-prompt-edit">
            <input
              className={s.input}
              aria-label="Quick prompt label"
              value={qpEditLabel}
              onChange={(e) => setQpEditLabel(e.target.value)}
            />
            <textarea
              className={s.input}
              aria-label="Quick prompt text"
              rows={3}
              value={qpEditText}
              onChange={(e) => setQpEditText(e.target.value)}
            />
            <div className={s.row}>
              <button
                className={s.btnPrimary}
                disabled={qpEditLabel.trim() === '' || qpEditText.trim() === ''}
                onClick={() => {
                  core.quickPrompts.getState().updatePrompt(qp.id, qpEditLabel, qpEditText);
                  setQpEditing(null);
                }}
              >
                Save
              </button>
              <button className={s.btn} onClick={() => setQpEditing(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div key={qp.id} className={styles.relayRow} data-testid="quick-prompt-row">
            <span className={styles.relayUrl} title={qp.text}>
              <strong>{qp.label}</strong> — {qp.text}
            </span>
            <button
              className={s.btnSmall}
              onClick={() => {
                setQpEditing(qp.id);
                setQpEditLabel(qp.label);
                setQpEditText(qp.text);
              }}
            >
              Edit
            </button>
            <button
              className={s.btnSmallDanger}
              onClick={() => core.quickPrompts.getState().removePrompt(qp.id)}
            >
              Delete
            </button>
          </div>
        ),
      )}
      <div className={s.row}>
        <input
          className={cx(s.input, s.grow)}
          placeholder="Label (e.g. Continue)"
          aria-label="New quick prompt label"
          value={qpLabel}
          onChange={(e) => setQpLabel(e.target.value)}
        />
      </div>
      <div className={s.row}>
        <textarea
          className={cx(s.input, s.grow)}
          placeholder="Prompt text inserted into the draft"
          aria-label="New quick prompt text"
          rows={2}
          value={qpText}
          onChange={(e) => setQpText(e.target.value)}
        />
        <button
          className={s.btn}
          disabled={qpLabel.trim() === '' || qpText.trim() === ''}
          onClick={() => {
            core.quickPrompts.getState().addPrompt(qpLabel, qpText);
            setQpLabel('');
            setQpText('');
          }}
        >
          Add
        </button>
      </div>
      <div className={s.muted}>
        Shortcuts shown above the session input; tapping one inserts its text
        into the draft (it never sends by itself).
      </div>

      <div className={styles.sectionTitle}>Messages</div>
      <div className={s.row}>
        <input
          className={cx(s.input, s.grow, s.mono)}
          value={blossomDraft}
          placeholder="https://blossom.descendant.io (image upload server)"
          aria-label="Image upload server"
          onChange={(e) => setBlossomDraft(e.target.value)}
          onBlur={() => core.settings.getState().setBlossomServer(blossomDraft)}
          autoCapitalize="none"
          autoCorrect="off"
        />
      </div>
      <div className={s.muted}>
        {/* CDX-086: this said "DM image attachments", but the session composer
          * reads the same setting — so it silently governed session uploads too
          * and the founder had no way to know. */}
        Blossom server for image attachments in DMs <strong>and session
        messages</strong> (images are encrypted before upload; the key travels
        only inside the encrypted message). Empty = the built-in default.
      </div>

      <div className={styles.sectionTitle}>Relays</div>
      {relays.map((url) => (
        <div key={url} className={styles.relayRow}>
          <span className={styles.relayUrl} title={url}>
            {url}
          </span>
          <button
            className={s.btnSmallDanger}
            onClick={() => core.settings.getState().removeRelay(url)}
            disabled={relays.length === 1}
          >
            Remove
          </button>
        </div>
      ))}
      {error && <div className={s.bannerError}>{error}</div>}
      <div className={s.row}>
        <input
          className={cx(s.input, s.grow, s.mono)}
          value={draft}
          placeholder="wss://relay.example.com"
          onChange={(e) => setDraft(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
        />
        <button className={s.btn} onClick={add} disabled={draft.trim() === ''}>
          Add
        </button>
      </div>
      <div className={s.muted}>
        Removing the last relay is blocked — the phone needs at least one.
      </div>

      {/* Machines proper (Phase 2b): one block per paired machine — identity
          summary, per-machine credentials, and the confirm-gated local
          removal (core.removeMachine cleans transcripts/unread/selection). */}
      {Object.keys(machines).length > 0 && (
        <>
          <div className={styles.sectionTitle}>Machines</div>
          {Object.values(machines)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((machine) => (
              <div key={machine.pubkeyHex} className={s.card} data-testid="machine-block">
                <div className={s.cardTitleRow}>
                  <span className={s.cardName}>{machine.name}</span>
                  {machine.host && <span className={s.badge}>{machine.host}</span>}
                </div>
                <div className={cx(s.muted, s.mono)} title={machine.pubkeyHex}>
                  {machine.pubkeyHex.slice(0, 16)}…{machine.pubkeyHex.slice(-8)}
                </div>
                <MachineCredentials machinePubkey={machine.pubkeyHex} />
                {/* CDX-062: custom AI provider profiles — the component
                    renders nothing unless this machine's heartbeat advertises
                    'custom-providers'. */}
                <MachineProviders machinePubkey={machine.pubkeyHex} />
                {confirmRemove === machine.pubkeyHex ? (
                  <>
                    <div className={s.bannerError}>
                      Remove {machine.name} from this phone? Its sessions keep
                      running on the machine; this forgets the pairing and the
                      local transcripts.
                    </div>
                    <div className={s.row}>
                      <button
                        className={s.btnDanger}
                        onClick={() => {
                          setConfirmRemove(null);
                          void core.removeMachine(machine.pubkeyHex);
                        }}
                      >
                        Remove machine
                      </button>
                      <button className={s.btn} onClick={() => setConfirmRemove(null)}>
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <div className={s.row}>
                    <button
                      className={s.btnSmallDanger}
                      onClick={() => setConfirmRemove(machine.pubkeyHex)}
                    >
                      Remove machine…
                    </button>
                  </div>
                )}
              </div>
            ))}
        </>
      )}
    </div>
  );
}
