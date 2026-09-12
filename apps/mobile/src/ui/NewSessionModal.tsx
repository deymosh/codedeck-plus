/**
 * NewSessionModal (Phase 2b, CDX-031) — replaces the per-machine "+"'s
 * zero-option createSession with a real create sheet on ScreenOverlay:
 *
 * - folder picker: radio list of the machine's heartbeat-advertised `folders`
 *   (root-relative paths, valid create-session.cwd values) + a "Default"
 *   option (bridge picks its workspace root) + a free-text "new folder" that
 *   maps to `cwd` + `createCwd: true` (the bridge mkdirs + git-inits it);
 *   plus, when the bridge serves several `--workspace` roots, one row per ROOT
 *   (absolute path as `cwd`, basename as the label). `folders` lists what is
 *   inside the roots and can never name one, so without these rows roots
 *   2..N were unreachable and two flat project roots offered nothing at all;
 * - model select from the machine's SDK-reported model list (requested on
 *   mount when absent; empty selection = bridge default);
 * - effort select over the protocol's EffortLevel options → `defaultEffort`.
 *
 * Create sends only the fields the user actually chose — createSession's
 * options are all optional on the wire.
 */
import { useEffect, useState } from 'react';
import { CAPABILITIES, effortLevelSchema } from '@codedeck/protocol';
import type { EffortLevel } from '../core/nativeCoreTypes';
import { useMachines, usePhoneCore } from './coreContext';
import { ScreenOverlay } from './ScreenOverlay';
import { cx, shared as s } from './shared';
import styles from './NewSessionModal.module.css';

const EFFORT_LEVELS = effortLevelSchema.options;

/** Radio value for the free-text "new folder" branch. */
const NEW_FOLDER = '__new__';

/** Last path segment of an absolute workspace root, for the radio label — the
 *  full path is long enough to ellipsize away on a phone at high --ui-scale,
 *  and it is the tail that identifies the project. Kept here rather than
 *  imported: node's `path` is not in the phone bundle, and roots may carry
 *  either separator depending on the machine that published them. */
function rootLabel(root: string): string {
  const segments = root.split(/[\\/]/).filter((s) => s !== '');
  return segments[segments.length - 1] ?? root;
}

export function NewSessionModal({
  machinePubkey,
  onClose,
  onCreated,
}: {
  machinePubkey: string;
  onClose(): void;
  /** After a successful send (narrow shell keeps the drawer open to show the
   *  pending card — the caller decides). */
  onCreated?: () => void;
}) {
  const core = usePhoneCore();
  const machine = useMachines((st) => st.machines[machinePubkey]);
  const [folderChoice, setFolderChoice] = useState(''); // '' = bridge default
  const [newFolder, setNewFolder] = useState('');
  // Preferences (CDX-047) pre-select the model/effort; '' stays "bridge
  // default". Initializers only — the user's in-modal choice always wins.
  const [model, setModel] = useState(() => core.settings.getState().defaultModel);
  const [effort, setEffort] = useState<string>(() => core.settings.getState().defaultEffort);
  // CDX-062: '' = the plain Anthropic path (exactly the pre-CDX-062 modal);
  // a profile id binds the session to that stored provider at create time
  // (CDX-044 owner rule: the choice exists ONLY here, never in-session).
  const [providerId, setProviderId] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ask for the machine's model list, and KEEP asking while we still have none
  // (CDX-035). An empty answer no longer sets `models` — it only records a
  // reason — so the retry stays alive instead of freezing on an empty picker.
  // Heartbeats are the clock: no timers, at most one request per heartbeat,
  // and it stops the instant a list lands.
  const heartbeatAt = machine?.lastHeartbeatAt;
  useEffect(() => {
    if (!core.machines.getState().machine(machinePubkey)?.models) {
      void core.api.modelsRequest(machinePubkey);
    }
  }, [core, machinePubkey, heartbeatAt]);

  // CDX-062: same heartbeat-clocked loop for provider profiles — but ONLY when
  // the bridge advertises the capability (an old bridge's zod rejects the
  // request message), and only while we have no answer yet. Unlike models
  // there is no empty-answer retry dance: the first answer (even `[]`) sets
  // the field and stops the loop.
  useEffect(() => {
    const m = core.machines.getState().machine(machinePubkey);
    if (
      m?.capabilities.includes(CAPABILITIES.customProviders) &&
      m.providerProfiles === undefined
    ) {
      void core.api.requestProviderProfiles(machinePubkey);
    }
  }, [core, machinePubkey, heartbeatAt]);

  if (!machine) {
    // Machine vanished (removed while open) — nothing sane to create against.
    return null;
  }

  const folders = machine.folders;
  // CDX-031: the roots themselves, offered only when there is a choice to make
  // — with one root "Default (workspace root)" already IS that root, and a
  // second identical-looking row would be noise. `roots` is absolute and goes
  // out verbatim as `cwd`; the bridge matches it back to the root it names.
  const roots = machine.roots.length > 1 ? machine.roots : [];
  const newFolderPath = newFolder.trim();
  const canCreate = folderChoice !== NEW_FOLDER || newFolderPath !== '';

  // CDX-062: the Provider select exists only when the bridge can honor it —
  // cap advertised AND at least one stored profile. Without the cap the send
  // would be silently stripped by an old bridge's zod and the session would
  // run on Anthropic (wrong provider, wrong account's bill).
  const providerProfiles =
    machine.capabilities.includes(CAPABILITIES.customProviders) && machine.providerProfiles
      ? machine.providerProfiles
      : [];
  const activeProfile =
    providerId !== '' ? providerProfiles.find((p) => p.id === providerId) : undefined;

  /** Provider changed: the Model options swap wholesale, so the old selection
   *  is meaningless — preselect the profile's default (or "Default model"),
   *  and restore the settings preference when returning to Anthropic. */
  const changeProvider = (id: string): void => {
    setProviderId(id);
    const profile = id === '' ? undefined : providerProfiles.find((p) => p.id === id);
    setModel(profile ? (profile.defaultModel ?? '') : core.settings.getState().defaultModel);
  };

  const create = async (): Promise<void> => {
    setCreating(true);
    setError(null);
    const cwd = folderChoice === NEW_FOLDER ? newFolderPath : folderChoice;
    const effortLevel = effortLevelSchema.safeParse(effort);
    try {
      const sent = await core.api.createSession(machinePubkey, {
        ...(cwd !== '' ? { cwd } : {}),
        ...(folderChoice === NEW_FOLDER ? { createCwd: true } : {}),
        ...(model !== '' ? { model } : {}),
        ...(effortLevel.success ? { defaultEffort: effortLevel.data as EffortLevel } : {}),
        // CDX-062: bind the session to the chosen provider profile. Sent even
        // when the profile vanished from the list while the sheet was open
        // (deleted on another phone): the bridge is authoritative and answers
        // session-pending → session-failed with a named reason — D3 forbids a
        // silent fallback onto the Anthropic key (wrong account's bill).
        ...(providerId !== '' ? { providerId } : {}),
      });
      if (!sent) {
        setError('Could not reach a relay — check the connection and try again.');
        return;
      }
      await core.api.refreshSessions(machinePubkey);
      onCreated?.();
      onClose();
    } finally {
      setCreating(false);
    }
  };

  return (
    <ScreenOverlay title={`New session on ${machine.name}`} onClose={onClose}>
      <div className={s.screen} data-testid="new-session-modal">
        <div className={styles.sectionTitle}>Folder</div>
        <div className={styles.folderList} role="radiogroup" aria-label="Folder">
          <label className={styles.folderRow}>
            <input
              type="radio"
              name="folder"
              value=""
              checked={folderChoice === ''}
              onChange={() => setFolderChoice('')}
            />
            <span className={styles.folderPath}>Default (workspace root)</span>
          </label>
          {roots.map((root) => (
            <label key={root} className={styles.folderRow} data-testid="root-option">
              <input
                type="radio"
                name="folder"
                value={root}
                checked={folderChoice === root}
                onChange={() => setFolderChoice(root)}
              />
              <span className={cx(styles.folderPath, s.mono)} title={root}>
                {rootLabel(root)}
              </span>
            </label>
          ))}
          {folders.map((folder) => (
            <label key={folder} className={styles.folderRow}>
              <input
                type="radio"
                name="folder"
                value={folder}
                checked={folderChoice === folder}
                onChange={() => setFolderChoice(folder)}
              />
              <span className={cx(styles.folderPath, s.mono)}>{folder}</span>
            </label>
          ))}
          <label className={styles.folderRow}>
            <input
              type="radio"
              name="folder"
              value={NEW_FOLDER}
              checked={folderChoice === NEW_FOLDER}
              onChange={() => setFolderChoice(NEW_FOLDER)}
            />
            <span className={styles.folderPath}>New folder…</span>
          </label>
          {folderChoice === NEW_FOLDER && (
            <input
              className={cx(s.input, s.mono)}
              placeholder="my-new-project"
              aria-label="New folder name"
              value={newFolder}
              autoFocus
              onChange={(e) => setNewFolder(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
            />
          )}
        </div>
        <div className={s.muted}>
          Folders come from the machine's workspace; a new folder is created
          (and git-initialized) on the machine.
        </div>

        {/* CDX-062: Provider above Model — rendered only when the bridge
          * advertises 'custom-providers' AND stores at least one profile.
          * '' = Anthropic, the pre-CDX-062 path, untouched. */}
        {providerProfiles.length > 0 && (
          <>
            <div className={styles.sectionTitle}>Provider</div>
            <select
              className={styles.select}
              aria-label="Provider"
              value={providerId}
              onChange={(e) => changeProvider(e.target.value)}
            >
              <option value="">Anthropic</option>
              {providerProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </>
        )}

        <div className={styles.sectionTitle}>Model</div>
        {activeProfile ? (
          /* CDX-062 provider path: the profile's own model list; '' lets the
           * bridge fall back to profile.defaultModel ?? models[0]. */
          <select
            className={styles.select}
            aria-label="Model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="">Default model</option>
            {activeProfile.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label ?? m.id}
              </option>
            ))}
          </select>
        ) : (
          <select
            className={styles.select}
            aria-label="Model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="">{machine.models ? 'Default model' : 'Default model (list unavailable)'}</option>
            {(machine.models ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label ?? m.id}
              </option>
            ))}
            {/* The preferred default model (CDX-047) may not be in THIS
              * machine's list — keep the pre-selection honest instead of the
              * controlled select silently showing nothing. */}
            {model !== '' && !(machine.models ?? []).some((m) => m.id === model) && (
              <option value={model}>{model}</option>
            )}
          </select>
        )}
        {/* CDX-035: the bridge's own reason for an empty answer, so an
          * unavailable list is explained instead of silently blank. Only when
          * we have NO list — a usable picker needs no apology — and only on
          * the Anthropic path (a provider profile brings its own list). */}
        {!activeProfile && !machine.models && machine.modelsError && (
          <div className={s.muted} role="status" data-testid="models-error">
            {machine.modelsError}
          </div>
        )}

        <div className={styles.sectionTitle}>Effort</div>
        <select
          className={styles.select}
          aria-label="Effort"
          value={effort}
          onChange={(e) => setEffort(e.target.value)}
        >
          <option value="">Default effort</option>
          {EFFORT_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>

        {error && <div className={s.bannerError}>{error}</div>}

        <div className={s.row}>
          <button
            className={cx(s.btnPrimary, s.grow)}
            disabled={creating || !canCreate}
            onClick={() => void create()}
          >
            {creating ? 'Creating…' : 'Create'}
          </button>
          <button className={s.btn} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </ScreenOverlay>
  );
}
