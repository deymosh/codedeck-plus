/**
 * Machine AI provider profiles (CDX-062) — per-machine editor for custom
 * Anthropic-compatible providers (Kimi K3, OpenRouter, any base URL that
 * speaks the Anthropic API).
 *
 * Ground rules:
 * - Renders ONLY when the machine's heartbeat advertises 'custom-providers' —
 *   an old bridge's zod rejects every profile message, so the UI (and with it
 *   every send) simply does not exist against one.
 * - Profiles are bridge-authoritative: this screen edits drafts and sends
 *   set-provider-profile; the truth comes back as a redacted provider-profiles
 *   broadcast into the machines slice. The phone persists nothing.
 * - The auth token follows the MachineCredentials secret discipline: password
 *   input, send-and-forget, wiped after send, never logged. Tri-state on the
 *   wire — blank = keep the stored token, explicit "Clear token" = null
 *   (delete), a value = set. The list only ever shows `hasToken`.
 * - CDX-071: the base URL is gated on the protocol's exported
 *   `isValidProviderBaseUrl` — the same predicate the wire schema refines on —
 *   and the rejection renders `PROVIDER_BASE_URL_ERROR` verbatim. A legacy
 *   http:// profile stored before that gate still LISTS (the redacted echo is
 *   permissive on purpose) and Edit shows the error the moment it loads, so it
 *   can be fixed or deleted rather than sitting unexplained.
 */
import { useEffect, useState } from 'react';
import { CAPABILITIES, isValidProviderBaseUrl, PROVIDER_BASE_URL_ERROR } from '../../core/protocolConstants';
import type { ProviderModel, ProviderProfileInfo } from '../../core/nativeCoreTypes';
import { useMachines, usePhoneCore, useUi } from '../coreContext';
import { cx, shared as s } from '../shared';

/** Draft row of the models editor ('' label = omit on the wire). */
interface ModelRow {
  id: string;
  label: string;
}

/** Human-legible profile id from the label (house slug style), suffixed on
 *  collision so re-adding "Kimi K3" never silently overwrites a profile. */
export function profileIdFromLabel(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'profile';
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** Add-form prefills for the two providers the feature was built around. */
const PRESETS: ReadonlyArray<{
  name: string;
  baseUrl: string;
  models: ModelRow[];
  defaultModel: string;
}> = [
  {
    name: 'Kimi K3',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    models: [{ id: 'kimi-k3', label: 'Kimi K3' }],
    defaultModel: 'kimi-k3',
  },
  {
    // OpenRouter fronts many models — the user picks which to expose.
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api',
    models: [{ id: '', label: '' }],
    defaultModel: '',
  },
];

const EMPTY_ROW: ModelRow = { id: '', label: '' };

export function MachineProviders({ machinePubkey }: { machinePubkey: string }) {
  const core = usePhoneCore();
  const machine = useMachines((st) => st.machines[machinePubkey]);
  const status = useUi((st) => st.providerProfileStatus[machinePubkey]);

  const [formOpen, setFormOpen] = useState(false);
  /** Profile id being edited; null = the add form. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [models, setModels] = useState<ModelRow[]>([EMPTY_ROW]);
  const [defaultModel, setDefaultModel] = useState('');
  /** Which profile's Delete awaits its confirm step. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // CDX-062 re-request loop, heartbeat-clocked like the models picker: ask
  // while the bridge advertises the cap but we hold no answer yet. The first
  // answer (even an empty list) ends it — the bridge always answers from
  // storage, so there is no could-not-answer retry case.
  const heartbeatAt = machine?.lastHeartbeatAt;
  useEffect(() => {
    const m = core.machines.getState().machine(machinePubkey);
    if (
      m?.capabilities.includes(CAPABILITIES.customProviders) &&
      m.providerProfiles === undefined
    ) {
      void core.api.requestProviderProfiles(machinePubkey);
    }
  }, [core, machinePubkey, heartbeatAt]);

  // Cap gate AFTER the hooks (rules of hooks): no capability, no provider UI,
  // no provider sends — the effect above self-gates the same way.
  if (!machine || !machine.capabilities.includes(CAPABILITIES.customProviders)) {
    return null;
  }

  const profiles = machine.providerProfiles;
  const editingProfile =
    editingId !== null ? profiles?.find((p) => p.id === editingId) : undefined;
  const validModels = models.filter((m) => m.id.trim() !== '');
  // CDX-071: the base URL gate is the protocol's own predicate, not a local
  // re-derivation. `set-provider-profile` carries the auth token, so the wire
  // schema requires https (http only on exact loopback, for Ollama/LM Studio)
  // and `encodePhoneToBridge` throws on the way out — pre-CDX-071 this screen
  // only checked non-empty, so an http:// profile died inside the send path
  // with nothing on screen telling the operator what was wrong.
  const trimmedBaseUrl = baseUrl.trim();
  const baseUrlValid = isValidProviderBaseUrl(trimmedBaseUrl);
  const baseUrlError = trimmedBaseUrl !== '' && !baseUrlValid;
  const canSave = label.trim() !== '' && baseUrlValid && validModels.length >= 1;

  const resetForm = (): void => {
    setEditingId(null);
    setLabel('');
    setBaseUrl('');
    setToken('');
    setClearToken(false);
    setModels([EMPTY_ROW]);
    setDefaultModel('');
  };

  const openAdd = (): void => {
    resetForm();
    setFormOpen(true);
  };

  const openEdit = (p: ProviderProfileInfo): void => {
    setEditingId(p.id);
    setLabel(p.label);
    setBaseUrl(p.baseUrl);
    setToken('');
    setClearToken(false);
    setModels(p.models.map((m) => ({ id: m.id, label: m.label ?? '' })));
    setDefaultModel(p.defaultModel ?? '');
    setFormOpen(true);
  };

  const applyPreset = (preset: (typeof PRESETS)[number]): void => {
    setLabel(preset.name);
    setBaseUrl(preset.baseUrl);
    setModels(preset.models.map((m) => ({ ...m })));
    setDefaultModel(preset.defaultModel);
  };

  const save = (): void => {
    const profileId =
      editingId ?? profileIdFromLabel(label, new Set((profiles ?? []).map((p) => p.id)));
    const wireModels: ProviderModel[] = validModels.map((m) => ({
      id: m.id.trim(),
      ...(m.label.trim() !== '' ? { label: m.label.trim() } : {}),
    }));
    core.ui.getState().noteProviderProfileSent(machinePubkey, profileId);
    void core.api.setProviderProfile(machinePubkey, profileId, {
      label: label.trim(),
      baseUrl: baseUrl.trim(),
      // Token tri-state: clear beats keep beats set-nothing; a blank input
      // sends NOTHING (the stored token stays).
      ...(clearToken
        ? { authToken: null }
        : token.trim() !== ''
          ? { authToken: token.trim() }
          : {}),
      models: wireModels,
      ...(defaultModel !== '' && wireModels.some((m) => m.id === defaultModel)
        ? { defaultModel }
        : {}),
    });
    // Secrets never linger in the DOM (MachineCredentials discipline).
    setToken('');
    setClearToken(false);
    setFormOpen(false);
    resetForm();
  };

  const deleteProfile = (profileId: string): void => {
    setConfirmDelete(null);
    core.ui.getState().noteProviderProfileSent(machinePubkey, profileId);
    void core.api.setProviderProfile(machinePubkey, profileId, null);
    if (editingId === profileId) {
      setFormOpen(false);
      resetForm();
    }
  };

  return (
    <div className={s.field} data-testid="machine-providers">
      <label>AI providers</label>
      <div className={s.muted}>
        Custom Anthropic-compatible providers (Kimi, OpenRouter, …) stored on
        the bridge; new sessions can be bound to one at create time. Tokens
        stay on the bridge — this phone never stores them.
      </div>

      {profiles === undefined && (
        <div className={s.muted} role="status">
          Loading provider profiles…
        </div>
      )}
      {(profiles ?? []).map((p) => (
        <div key={p.id} className={s.card} data-testid="provider-row">
          <div className={s.cardTitleRow}>
            <span className={s.cardName}>{p.label}</span>
            <span className={p.hasToken ? s.badge : s.badgeOffline}>
              {p.hasToken ? 'token set' : 'no token'}
            </span>
          </div>
          <div className={cx(s.muted, s.mono)} title={p.baseUrl}>
            {p.baseUrl}
          </div>
          <div className={s.muted}>
            {p.models.length} {p.models.length === 1 ? 'model' : 'models'}
            {p.defaultModel ? ` · default ${p.defaultModel}` : ''}
          </div>
          {confirmDelete === p.id ? (
            <>
              <div className={s.bannerError}>
                Delete {p.label} from the bridge? Sessions bound to it will fail
                on their next restart instead of silently falling back to
                Anthropic.
              </div>
              <div className={s.row}>
                <button className={s.btnDanger} onClick={() => deleteProfile(p.id)}>
                  Delete profile
                </button>
                <button className={s.btn} onClick={() => setConfirmDelete(null)}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <div className={s.row}>
              <button className={s.btnSmall} onClick={() => openEdit(p)}>
                Edit
              </button>
              <button
                className={s.btnSmallDanger}
                onClick={() => setConfirmDelete(p.id)}
              >
                Delete…
              </button>
            </div>
          )}
        </div>
      ))}

      {!formOpen && (
        <div className={s.row}>
          <button className={s.btn} onClick={openAdd}>
            Add provider…
          </button>
        </div>
      )}

      {formOpen && (
        <div className={s.card} data-testid="provider-form">
          {editingId === null && (
            <div className={s.row}>
              {PRESETS.map((preset) => (
                <button
                  key={preset.name}
                  className={s.btnSmall}
                  onClick={() => applyPreset(preset)}
                >
                  {preset.name}
                </button>
              ))}
            </div>
          )}
          <input
            className={s.input}
            value={label}
            placeholder="Label (e.g. Kimi K3)"
            aria-label="Provider label"
            onChange={(e) => setLabel(e.target.value)}
          />
          <input
            className={cx(s.input, s.mono)}
            value={baseUrl}
            placeholder="https://api.moonshot.ai/anthropic"
            aria-label="Provider base URL"
            onChange={(e) => setBaseUrl(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
          />
          {baseUrlError && (
            <div className={s.bannerError} data-testid="provider-base-url-error">
              {PROVIDER_BASE_URL_ERROR}
            </div>
          )}
          <input
            className={cx(s.input, s.mono)}
            type="password"
            value={token}
            placeholder={editingProfile?.hasToken ? 'unchanged' : 'API token (sk-…)'}
            aria-label="Provider auth token"
            disabled={clearToken}
            onChange={(e) => setToken(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
          />
          {editingProfile?.hasToken && (
            <label className={s.row}>
              <input
                type="checkbox"
                checked={clearToken}
                aria-label="Clear token"
                onChange={(e) => {
                  setClearToken(e.target.checked);
                  if (e.target.checked) setToken('');
                }}
              />
              <span className={s.muted}>
                Clear token (removes the stored token on save)
              </span>
            </label>
          )}
          {models.map((row, i) => (
            <div key={i} className={s.row}>
              <input
                className={cx(s.input, s.mono, s.grow)}
                value={row.id}
                placeholder="model id (e.g. kimi-k3)"
                aria-label={`Model id ${i + 1}`}
                onChange={(e) =>
                  setModels(models.map((m, j) => (j === i ? { ...m, id: e.target.value } : m)))
                }
                autoCapitalize="none"
                autoCorrect="off"
              />
              <input
                className={cx(s.input, s.grow)}
                value={row.label}
                placeholder="label (optional)"
                aria-label={`Model label ${i + 1}`}
                onChange={(e) =>
                  setModels(
                    models.map((m, j) => (j === i ? { ...m, label: e.target.value } : m)),
                  )
                }
              />
              <button
                className={s.btnSmallDanger}
                aria-label={`Remove model ${i + 1}`}
                disabled={models.length === 1}
                onClick={() => setModels(models.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </div>
          ))}
          <div className={s.row}>
            <button
              className={s.btnSmall}
              onClick={() => setModels([...models, { ...EMPTY_ROW }])}
            >
              Add model
            </button>
          </div>
          <div className={s.row}>
            <span className={s.muted}>Default model</span>
            <select
              className={cx(s.input, s.grow)}
              aria-label="Provider default model"
              value={defaultModel}
              onChange={(e) => setDefaultModel(e.target.value)}
            >
              <option value="">First model</option>
              {validModels.map((m) => (
                <option key={m.id} value={m.id.trim()}>
                  {m.label.trim() !== '' ? m.label : m.id}
                </option>
              ))}
            </select>
          </div>
          <div className={s.row}>
            <button
              className={cx(s.btnPrimary, s.grow)}
              disabled={!canSave}
              onClick={save}
            >
              Save on bridge
            </button>
            <button
              className={s.btn}
              onClick={() => {
                setFormOpen(false);
                resetForm();
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {status && (
        <div
          className={status.state === 'failed' ? s.bannerError : s.muted}
          data-testid="provider-profile-status"
        >
          {status.state === 'saving' && 'Saving on the bridge…'}
          {status.state === 'saved' &&
            `Saved${
              status.tokenValid !== undefined
                ? status.tokenValid
                  ? ' · token valid'
                  : ' · token INVALID'
                : ''
            }`}
          {status.state === 'failed' && `Saving failed: ${status.error ?? 'unknown error'}`}
        </div>
      )}
    </div>
  );
}
