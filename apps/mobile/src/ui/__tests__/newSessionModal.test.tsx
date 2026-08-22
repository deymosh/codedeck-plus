// @vitest-environment jsdom
/**
 * NewSessionModal (Phase 2b, CDX-031): the folder picker lists the machine's
 * heartbeat-advertised folders, Create passes exactly the chosen
 * cwd/model/defaultEffort to createSession, the free-text new-folder branch
 * maps to cwd + createCwd, and the zero-choice default sends no options.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CAPABILITIES, type ProviderProfileInfo } from '@codedeck/protocol';
import { createPhoneCore, type PhoneCore } from '../../core/createPhoneCore';
import { memoryKV, type PhoneTransport } from '../../core/ports';
import { PhoneCoreProvider } from '../coreContext';
import { NewSessionModal } from '../NewSessionModal';

afterEach(cleanup);

const MACHINE = 'a'.repeat(64);

const nullTransport: PhoneTransport = {
  subscribe: () => ({ close: () => {} }),
  publish: async () => true,
};

async function makeCore(withModels = true, capabilities?: string[]): Promise<PhoneCore> {
  const core = await createPhoneCore({ kv: memoryKV(), transport: nullTransport });
  core.machines.getState().registerMachine({ pubkeyHex: MACHINE, name: 'laptop' });
  // Heartbeat carries folders (CDX-031's picker source) — and a model list.
  core.machines.getState().applySessionList(
    MACHINE,
    {
      type: 'sessions',
      machine: 'laptop',
      sessions: [],
      protocolVersion: 10,
      folders: ['proj-a', 'proj-b'],
      ...(capabilities ? { capabilities } : {}),
    },
    Date.now(),
  );
  if (withModels) {
    core.machines.getState().applyModels(MACHINE, {
      type: 'models',
      models: [{ id: 'model-x', label: 'Model X' }, { id: 'model-y' }],
      defaultModel: 'model-x',
    });
  }
  return core;
}

function renderModal(core: PhoneCore, onClose = (): void => {}) {
  return render(
    <PhoneCoreProvider value={core}>
      <NewSessionModal machinePubkey={MACHINE} onClose={onClose} />
    </PhoneCoreProvider>,
  );
}

describe('NewSessionModal (CDX-031)', () => {
  it('lists the machine folders as radio options plus Default and New folder', async () => {
    const core = await makeCore();
    renderModal(core);

    expect(screen.getByText('New session on laptop', { selector: 'h1' })).toBeTruthy();
    expect(screen.getByDisplayValue('proj-a')).toBeTruthy();
    expect(screen.getByDisplayValue('proj-b')).toBeTruthy();
    expect(screen.getByText('Default (workspace root)')).toBeTruthy();
    expect(screen.getByText('New folder…')).toBeTruthy();
  });

  // CDX-044 removed the session header's model dropdown, so THIS picker is the
  // only place a model is ever chosen — it opening empty is now a regression,
  // not a cosmetic gap. The next two tests own that.
  it('the model select is populated from the machine model list (CDX-044)', async () => {
    const core = await makeCore();
    renderModal(core);

    const select = screen.getByLabelText('Model') as HTMLSelectElement;
    const options = [...select.options].map((o) => `${o.value}:${o.text}`);
    expect(options).toEqual([
      ':Default model',
      'model-x:Model X',
      'model-y:model-y', // no label → falls back to the id
    ]);
  });

  it('a machine with no model list yet requests one on mount (CDX-044)', async () => {
    const core = await makeCore(false);
    const modelsRequest = vi.spyOn(core.api, 'modelsRequest').mockResolvedValue(true);
    renderModal(core);

    // The modal never depends on some other screen having warmed the store.
    expect(modelsRequest).toHaveBeenCalledWith(MACHINE);
    const select = screen.getByLabelText('Model') as HTMLSelectElement;
    expect(select.options[0]!.text).toBe('Default model (list unavailable)');
  });

  it('picked folder + model + effort pass through to createSession, then closes', async () => {
    const core = await makeCore();
    const create = vi.spyOn(core.api, 'createSession').mockResolvedValue(true);
    const refresh = vi.spyOn(core.api, 'refreshSessions').mockResolvedValue(true);
    const onClose = vi.fn();
    renderModal(core, onClose);

    fireEvent.click(screen.getByDisplayValue('proj-b'));
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'model-y' } });
    fireEvent.change(screen.getByLabelText('Effort'), { target: { value: 'high' } });
    fireEvent.click(screen.getByText('Create'));
    await Promise.resolve();

    expect(create).toHaveBeenCalledWith(MACHINE, {
      cwd: 'proj-b',
      model: 'model-y',
      defaultEffort: 'high',
    });
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(refresh).toHaveBeenCalledWith(MACHINE);
  });

  it('new-folder free text maps to cwd + createCwd (and gates Create while empty)', async () => {
    const core = await makeCore();
    const create = vi.spyOn(core.api, 'createSession').mockResolvedValue(true);
    vi.spyOn(core.api, 'refreshSessions').mockResolvedValue(true);
    renderModal(core);

    fireEvent.click(screen.getByText('New folder…'));
    const createBtn = screen.getByText('Create') as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('New folder name'), {
      target: { value: '  fresh-project  ' },
    });
    expect(createBtn.disabled).toBe(false);
    fireEvent.click(createBtn);

    expect(create).toHaveBeenCalledWith(MACHINE, { cwd: 'fresh-project', createCwd: true });
  });

  it('zero choices → createSession with no options (bridge defaults)', async () => {
    const core = await makeCore();
    const create = vi.spyOn(core.api, 'createSession').mockResolvedValue(true);
    vi.spyOn(core.api, 'refreshSessions').mockResolvedValue(true);
    renderModal(core);

    fireEvent.click(screen.getByText('Create'));
    expect(create).toHaveBeenCalledWith(MACHINE, {});
  });

  // CDX-047: Settings → Preferences pre-select the modal's model/effort.
  it('preferences pre-select model + effort, and Create carries them (CDX-047)', async () => {
    const core = await makeCore();
    core.settings.getState().setDefaultModel('model-y');
    core.settings.getState().setDefaultEffort('high');
    const create = vi.spyOn(core.api, 'createSession').mockResolvedValue(true);
    vi.spyOn(core.api, 'refreshSessions').mockResolvedValue(true);
    renderModal(core);

    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('model-y');
    expect((screen.getByLabelText('Effort') as HTMLSelectElement).value).toBe('high');

    fireEvent.click(screen.getByText('Create'));
    expect(create).toHaveBeenCalledWith(MACHINE, { model: 'model-y', defaultEffort: 'high' });
  });

  it('a preferred model missing from THIS machine list still renders as the selection (CDX-047)', async () => {
    const core = await makeCore();
    core.settings.getState().setDefaultModel('model-elsewhere');
    renderModal(core);

    const select = screen.getByLabelText('Model') as HTMLSelectElement;
    expect(select.value).toBe('model-elsewhere');
    expect([...select.options].map((o) => o.value)).toContain('model-elsewhere');
  });

  it('the user in-modal choice overrides the preference (CDX-047)', async () => {
    const core = await makeCore();
    core.settings.getState().setDefaultModel('model-y');
    const create = vi.spyOn(core.api, 'createSession').mockResolvedValue(true);
    vi.spyOn(core.api, 'refreshSessions').mockResolvedValue(true);
    renderModal(core);

    fireEvent.change(screen.getByLabelText('Model'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Create'));
    expect(create).toHaveBeenCalledWith(MACHINE, {});
  });

  // --- CDX-022 / CDX-035: the picker must not lose its list, and must explain
  // itself when the bridge cannot answer. ---

  it('the picker SURVIVES a refresh-sessions heartbeat (CDX-022 device failure)', async () => {
    const core = await makeCore();
    renderModal(core);
    expect([...(screen.getByLabelText('Model') as HTMLSelectElement).options]).toHaveLength(3);

    // The exact device sequence: list lands, then a heartbeat arrives.
    core.machines.getState().applySessionList(
      MACHINE,
      { type: 'sessions', machine: 'laptop', sessions: [], protocolVersion: 10 },
      Date.now() + 1,
    );

    await vi.waitFor(() => {
      const select = screen.getByLabelText('Model') as HTMLSelectElement;
      expect([...select.options].map((o) => o.value)).toEqual(['', 'model-x', 'model-y']);
      expect(select.options[0]!.text).toBe('Default model');
    });
  });

  it('an empty answer renders the reason and keeps the retry alive (CDX-035)', async () => {
    const core = await makeCore(false);
    const modelsRequest = vi.spyOn(core.api, 'modelsRequest').mockResolvedValue(true);
    renderModal(core);
    expect(modelsRequest).toHaveBeenCalledTimes(1);

    core.machines.getState().applyModels(MACHINE, {
      type: 'models',
      models: [],
      error: 'No live Claude session answered — start or open a session and try again.',
    });
    await vi.waitFor(() => {
      expect(screen.getByTestId('models-error').textContent).toMatch(/No live Claude session answered/);
    });
    // Still "unavailable", NOT frozen on an empty list.
    expect((screen.getByLabelText('Model') as HTMLSelectElement).options[0]!.text).toBe(
      'Default model (list unavailable)',
    );

    // The next heartbeat re-asks — an empty answer never ends the retry.
    core.machines.getState().applySessionList(
      MACHINE,
      { type: 'sessions', machine: 'laptop', sessions: [], protocolVersion: 10 },
      Date.now() + 1,
    );
    await vi.waitFor(() => expect(modelsRequest).toHaveBeenCalledTimes(2));

    // A real answer populates the picker and clears the reason.
    core.machines.getState().applyModels(MACHINE, {
      type: 'models',
      models: [{ id: 'model-x', label: 'Model X' }],
    });
    await vi.waitFor(() => {
      expect(screen.queryByTestId('models-error')).toBeNull();
      expect([...(screen.getByLabelText('Model') as HTMLSelectElement).options]).toHaveLength(2);
    });
  });

  it('a populated picker stops re-requesting and shows no apology (CDX-035)', async () => {
    const core = await makeCore();
    const modelsRequest = vi.spyOn(core.api, 'modelsRequest').mockResolvedValue(true);
    renderModal(core);
    expect(modelsRequest).not.toHaveBeenCalled();

    // A late empty answer records the reason but must not nag over a working
    // picker — nor wipe it (CDX-022).
    core.machines.getState().applyModels(MACHINE, { type: 'models', models: [], error: 'transient' });
    await Promise.resolve();
    expect(screen.queryByTestId('models-error')).toBeNull();
    expect([...(screen.getByLabelText('Model') as HTMLSelectElement).options]).toHaveLength(3);

    for (let i = 1; i <= 3; i++) {
      core.machines.getState().applySessionList(
        MACHINE,
        { type: 'sessions', machine: 'laptop', sessions: [], protocolVersion: 10 },
        Date.now() + i,
      );
    }
    await Promise.resolve();
    expect(modelsRequest).not.toHaveBeenCalled();
  });

  it('failed publish surfaces an error and stays open', async () => {
    const core = await makeCore();
    vi.spyOn(core.api, 'createSession').mockResolvedValue(false);
    const onClose = vi.fn();
    renderModal(core, onClose);

    fireEvent.click(screen.getByText('Create'));
    await vi.waitFor(() => {
      expect(screen.getByText(/Could not reach a relay/)).toBeTruthy();
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});

// --- CDX-062: custom provider profiles in the create sheet ---

const CUSTOM_CAP = [CAPABILITIES.customProviders];

const PROFILES: ProviderProfileInfo[] = [
  {
    id: 'kimi',
    label: 'Kimi K3',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    models: [{ id: 'kimi-k3', label: 'Kimi K3' }, { id: 'kimi-k3-turbo' }],
    defaultModel: 'kimi-k3',
    hasToken: true,
  },
  {
    id: 'router',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api',
    models: [{ id: 'or-model' }],
    hasToken: false,
  },
];

function applyProfiles(core: PhoneCore, profiles: ProviderProfileInfo[]): void {
  core.machines
    .getState()
    .applyProviderProfiles(MACHINE, { type: 'provider-profiles', machine: 'laptop', profiles });
}

describe('NewSessionModal — provider profiles (CDX-062)', () => {
  it('no Provider select without the capability — even when profiles are somehow held', async () => {
    const core = await makeCore(); // heartbeat WITHOUT 'custom-providers'
    applyProfiles(core, PROFILES);
    const request = vi.spyOn(core.api, 'requestProviderProfiles').mockResolvedValue(true);
    renderModal(core);

    expect(screen.queryByLabelText('Provider')).toBeNull();
    // Cap-gated sends: an old bridge must never see a profile request.
    expect(request).not.toHaveBeenCalled();
  });

  it('no Provider select while the cap is present but the list is empty or unfetched', async () => {
    const core = await makeCore(true, CUSTOM_CAP);
    renderModal(core);
    expect(screen.queryByLabelText('Provider')).toBeNull();

    applyProfiles(core, []);
    await Promise.resolve();
    expect(screen.queryByLabelText('Provider')).toBeNull();
  });

  it('requests the profile list on mount and per heartbeat while unfetched; stops once answered', async () => {
    const core = await makeCore(true, CUSTOM_CAP);
    const request = vi.spyOn(core.api, 'requestProviderProfiles').mockResolvedValue(true);
    renderModal(core);
    expect(request).toHaveBeenCalledWith(MACHINE);
    expect(request).toHaveBeenCalledTimes(1);

    // Next heartbeat, still no answer → ask again (à la the CDX-035 models loop).
    core.machines.getState().applySessionList(
      MACHINE,
      { type: 'sessions', machine: 'laptop', sessions: [], protocolVersion: 10 },
      Date.now() + 1,
    );
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    // An answer — even an empty one — ends the loop (bridge storage is
    // authoritative; there is no could-not-answer case).
    applyProfiles(core, []);
    core.machines.getState().applySessionList(
      MACHINE,
      { type: 'sessions', machine: 'laptop', sessions: [], protocolVersion: 10 },
      Date.now() + 2,
    );
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('renders above Model with Anthropic first; choosing a profile swaps the Model options and preselects its default', async () => {
    const core = await makeCore(true, CUSTOM_CAP);
    applyProfiles(core, PROFILES);
    renderModal(core);

    const provider = screen.getByLabelText('Provider') as HTMLSelectElement;
    expect([...provider.options].map((o) => `${o.value}:${o.text}`)).toEqual([
      ':Anthropic',
      'kimi:Kimi K3',
      'router:OpenRouter',
    ]);
    expect(provider.value).toBe('');

    fireEvent.change(provider, { target: { value: 'kimi' } });
    const model = screen.getByLabelText('Model') as HTMLSelectElement;
    expect([...model.options].map((o) => `${o.value}:${o.text}`)).toEqual([
      ':Default model',
      'kimi-k3:Kimi K3',
      'kimi-k3-turbo:kimi-k3-turbo',
    ]);
    expect(model.value).toBe('kimi-k3');

    // A profile without a defaultModel preselects "Default model" ('').
    fireEvent.change(provider, { target: { value: 'router' } });
    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('');
  });

  it('create() carries providerId (and the chosen profile model)', async () => {
    const core = await makeCore(true, CUSTOM_CAP);
    applyProfiles(core, PROFILES);
    const create = vi.spyOn(core.api, 'createSession').mockResolvedValue(true);
    vi.spyOn(core.api, 'refreshSessions').mockResolvedValue(true);
    renderModal(core);

    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'kimi' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'kimi-k3-turbo' } });
    fireEvent.click(screen.getByText('Create'));

    expect(create).toHaveBeenCalledWith(MACHINE, {
      providerId: 'kimi',
      model: 'kimi-k3-turbo',
    });
  });

  it('a profile deleted while the sheet is open STILL sends its providerId (D3 — the bridge fails loudly, never a silent Anthropic fallback)', async () => {
    const core = await makeCore(true, CUSTOM_CAP);
    applyProfiles(core, PROFILES);
    const create = vi.spyOn(core.api, 'createSession').mockResolvedValue(true);
    vi.spyOn(core.api, 'refreshSessions').mockResolvedValue(true);
    renderModal(core);

    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'kimi' } });
    // The profile is deleted (broadcast lands) while the sheet is open.
    applyProfiles(core, []);
    fireEvent.click(screen.getByText('Create'));

    // The dead id goes out anyway: the bridge answers pending → failed with a
    // named reason. Dropping it here would silently create an ANTHROPIC
    // session — the exact wrong-account billing D3 exists to prevent.
    expect(create).toHaveBeenCalledWith(
      MACHINE,
      expect.objectContaining({ providerId: 'kimi' }),
    );
  });

  it('switching back to Anthropic restores the machine list + settings preselect, and sends NO providerId', async () => {
    const core = await makeCore(true, CUSTOM_CAP);
    applyProfiles(core, PROFILES);
    core.settings.getState().setDefaultModel('model-y');
    const create = vi.spyOn(core.api, 'createSession').mockResolvedValue(true);
    vi.spyOn(core.api, 'refreshSessions').mockResolvedValue(true);
    renderModal(core);

    const provider = screen.getByLabelText('Provider') as HTMLSelectElement;
    fireEvent.change(provider, { target: { value: 'kimi' } });
    fireEvent.change(provider, { target: { value: '' } });

    const model = screen.getByLabelText('Model') as HTMLSelectElement;
    expect([...model.options].map((o) => o.value)).toEqual(['', 'model-x', 'model-y']);
    // The CDX-047 settings preference applies to the Anthropic path only —
    // restored here, not while a profile was active.
    expect(model.value).toBe('model-y');

    fireEvent.click(screen.getByText('Create'));
    expect(create).toHaveBeenCalledWith(MACHINE, { model: 'model-y' });
  });

  it('REGRESSION: the Anthropic path keeps the CDX-035 retry + off-list synthetic option with provider UI present', async () => {
    const core = await makeCore(false, CUSTOM_CAP);
    applyProfiles(core, PROFILES);
    core.settings.getState().setDefaultModel('model-elsewhere');
    const modelsRequest = vi.spyOn(core.api, 'modelsRequest').mockResolvedValue(true);
    renderModal(core);

    // Models still requested on mount (provider profiles never satisfy it).
    expect(modelsRequest).toHaveBeenCalledWith(MACHINE);
    // Synthetic off-list option keeps the preference honest on the Anthropic path.
    const model = screen.getByLabelText('Model') as HTMLSelectElement;
    expect(model.value).toBe('model-elsewhere');
    expect([...model.options].map((o) => o.value)).toContain('model-elsewhere');

    // CDX-035 empty-answer reason renders on the Anthropic path…
    core.machines.getState().applyModels(MACHINE, {
      type: 'models',
      models: [],
      error: 'no live SDK session answered',
    });
    await vi.waitFor(() => expect(screen.getByTestId('models-error')).toBeTruthy());

    // …but a profile brings its own list, so the apology hides there.
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'kimi' } });
    expect(screen.queryByTestId('models-error')).toBeNull();
  });
});
