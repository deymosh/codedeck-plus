// @vitest-environment jsdom
/**
 * Settings → per-machine AI providers (CDX-062): the section exists only when
 * the machine's heartbeat advertises 'custom-providers' (no cap → no UI and no
 * profile sends); rows render the redacted list (label, baseUrl, model count,
 * hasToken badge); the add/edit form follows the MachineCredentials secret
 * discipline — token tri-state (blank = keep, Clear token = null, value =
 * set), wiped after send; delete is confirm-gated and sends `profile: null`;
 * presets prefill the add form; status renders from uiStore's transient
 * providerProfileStatus.
 *
 * CDX-071 adds the base-URL gate: the Save button and its inline error read the
 * protocol's exported isValidProviderBaseUrl / PROVIDER_BASE_URL_ERROR, so an
 * http:// profile is refused ON SCREEN instead of throwing unexplained inside
 * encodePhoneToBridge, while loopback http:// (Ollama, LM Studio) stays saveable.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  CAPABILITIES,
  PROVIDER_BASE_URL_ERROR,
  type ProviderProfileInfo,
} from '@codedeck/protocol';
import { createPhoneCore, type PhoneCore } from '../../core/createPhoneCore';
import { memoryKV, type PhoneTransport } from '../../core/ports';
import { PhoneCoreProvider } from '../coreContext';
import { MachineProviders, profileIdFromLabel } from '../screens/MachineProviders';
import { SettingsScreen } from '../screens/SettingsScreen';

afterEach(cleanup);

const MACHINE = 'a'.repeat(64);

const nullTransport: PhoneTransport = {
  subscribe: () => ({ close: () => {} }),
  publish: async () => true,
};

const PROFILES: ProviderProfileInfo[] = [
  {
    id: 'kimi-k3',
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

async function makeCore(withCap = true, profiles?: ProviderProfileInfo[]): Promise<PhoneCore> {
  const core = await createPhoneCore({ kv: memoryKV(), transport: nullTransport });
  core.machines.getState().registerMachine({ pubkeyHex: MACHINE, name: 'laptop' });
  core.machines.getState().applySessionList(
    MACHINE,
    {
      type: 'sessions',
      machine: 'laptop',
      sessions: [],
      protocolVersion: 10,
      ...(withCap ? { capabilities: [CAPABILITIES.customProviders] } : {}),
    },
    Date.now(),
  );
  if (profiles) {
    core.machines
      .getState()
      .applyProviderProfiles(MACHINE, { type: 'provider-profiles', machine: 'laptop', profiles });
  }
  return core;
}

function renderProviders(core: PhoneCore) {
  return render(
    <PhoneCoreProvider value={core}>
      <MachineProviders machinePubkey={MACHINE} />
    </PhoneCoreProvider>,
  );
}

describe('profileIdFromLabel', () => {
  it('slugs the label and suffixes on collision', () => {
    expect(profileIdFromLabel('Kimi K3', new Set())).toBe('kimi-k3');
    expect(profileIdFromLabel('Kimi K3', new Set(['kimi-k3']))).toBe('kimi-k3-2');
    expect(profileIdFromLabel('Kimi K3', new Set(['kimi-k3', 'kimi-k3-2']))).toBe('kimi-k3-3');
    expect(profileIdFromLabel('  ***  ', new Set())).toBe('profile');
  });
});

describe('Settings — AI providers section (CDX-062)', () => {
  it('WITHOUT the capability: no section, no profile request (cap-gated sends)', async () => {
    const core = await makeCore(false);
    const request = vi.spyOn(core.api, 'requestProviderProfiles').mockResolvedValue(true);
    render(
      <PhoneCoreProvider value={core}>
        <SettingsScreen />
      </PhoneCoreProvider>,
    );

    expect(screen.getByTestId('machine-block')).toBeTruthy();
    expect(screen.queryByTestId('machine-providers')).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('with the capability the section mounts inside the machine block and requests the list', async () => {
    const core = await makeCore(true);
    const request = vi.spyOn(core.api, 'requestProviderProfiles').mockResolvedValue(true);
    render(
      <PhoneCoreProvider value={core}>
        <SettingsScreen />
      </PhoneCoreProvider>,
    );

    expect(screen.getByTestId('machine-providers')).toBeTruthy();
    expect(screen.getByText('Loading provider profiles…')).toBeTruthy();
    expect(request).toHaveBeenCalledWith(MACHINE);
  });

  it('rows show label, baseUrl, model count and the hasToken badge — never a token', async () => {
    const core = await makeCore(true, PROFILES);
    renderProviders(core);

    const rows = screen.getAllByTestId('provider-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Kimi K3');
    expect(rows[0]!.textContent).toContain('https://api.moonshot.ai/anthropic');
    expect(rows[0]!.textContent).toContain('2 models');
    expect(rows[0]!.textContent).toContain('default kimi-k3');
    expect(rows[0]!.textContent).toContain('token set');
    expect(rows[1]!.textContent).toContain('1 model');
    expect(rows[1]!.textContent).toContain('no token');
  });

  it('add form: Kimi preset prefills, save sends the profile with the token and a slug id, then wipes the secret', async () => {
    const core = await makeCore(true, [PROFILES[1]!]);
    const set = vi.spyOn(core.api, 'setProviderProfile').mockResolvedValue(true);
    renderProviders(core);

    fireEvent.click(screen.getByText('Add provider…'));
    fireEvent.click(screen.getByText('Kimi K3'));
    expect((screen.getByLabelText('Provider label') as HTMLInputElement).value).toBe('Kimi K3');
    expect((screen.getByLabelText('Provider base URL') as HTMLInputElement).value).toBe(
      'https://api.moonshot.ai/anthropic',
    );
    expect((screen.getByLabelText('Model id 1') as HTMLInputElement).value).toBe('kimi-k3');

    fireEvent.change(screen.getByLabelText('Provider auth token'), {
      target: { value: 'sk-kimi-secret' },
    });
    fireEvent.click(screen.getByText('Save on bridge'));

    expect(set).toHaveBeenCalledWith(MACHINE, 'kimi-k3', {
      label: 'Kimi K3',
      baseUrl: 'https://api.moonshot.ai/anthropic',
      authToken: 'sk-kimi-secret',
      models: [{ id: 'kimi-k3', label: 'Kimi K3' }],
      defaultModel: 'kimi-k3',
    });
    // Optimistic saving state + the secret gone from the DOM.
    expect(core.ui.getState().providerProfileStatus[MACHINE]).toMatchObject({
      state: 'saving',
      profileId: 'kimi-k3',
    });
    expect(screen.getByTestId('provider-profile-status').textContent).toContain('Saving');
    expect(screen.queryByDisplayValue('sk-kimi-secret')).toBeNull();
  });

  it('OpenRouter preset prefills the base URL with the models left for the user; empty models gate Save', async () => {
    const core = await makeCore(true, []);
    renderProviders(core);

    fireEvent.click(screen.getByText('Add provider…'));
    fireEvent.click(screen.getByText('OpenRouter'));
    expect((screen.getByLabelText('Provider base URL') as HTMLInputElement).value).toBe(
      'https://openrouter.ai/api',
    );
    expect((screen.getByLabelText('Model id 1') as HTMLInputElement).value).toBe('');
    expect((screen.getByText('Save on bridge') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Model id 1'), {
      target: { value: 'anthropic/claude-sonnet-4-6' },
    });
    expect((screen.getByText('Save on bridge') as HTMLButtonElement).disabled).toBe(false);
  });

  it('edit with a BLANK token field keeps the stored token (no authToken on the wire)', async () => {
    const core = await makeCore(true, PROFILES);
    const set = vi.spyOn(core.api, 'setProviderProfile').mockResolvedValue(true);
    renderProviders(core);

    fireEvent.click(screen.getAllByText('Edit')[0]!);
    // The password field shows "unchanged" for a profile with a stored token.
    expect(
      (screen.getByLabelText('Provider auth token') as HTMLInputElement).placeholder,
    ).toBe('unchanged');
    fireEvent.click(screen.getByText('Save on bridge'));

    const [, profileId, profile] = set.mock.calls[0]!;
    expect(profileId).toBe('kimi-k3'); // edit reuses the id, no re-slug
    expect(profile).not.toBeNull();
    expect('authToken' in profile!).toBe(false);
  });

  it('edit with Clear token checked sends an explicit null (delete semantics)', async () => {
    const core = await makeCore(true, PROFILES);
    const set = vi.spyOn(core.api, 'setProviderProfile').mockResolvedValue(true);
    renderProviders(core);

    fireEvent.click(screen.getAllByText('Edit')[0]!);
    fireEvent.click(screen.getByLabelText('Clear token'));
    fireEvent.click(screen.getByText('Save on bridge'));

    const [, , profile] = set.mock.calls[0]!;
    expect(profile!.authToken).toBeNull();
  });

  it('delete requires the confirm step; Cancel sends nothing, confirm sends profile: null', async () => {
    const core = await makeCore(true, PROFILES);
    const set = vi.spyOn(core.api, 'setProviderProfile').mockResolvedValue(true);
    renderProviders(core);

    fireEvent.click(screen.getAllByText('Delete…')[0]!);
    expect(screen.getByText(/Delete Kimi K3 from the bridge\?/)).toBeTruthy();
    fireEvent.click(screen.getByText('Cancel'));
    expect(set).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByText('Delete…')[0]!);
    fireEvent.click(screen.getByText('Delete profile'));
    expect(set).toHaveBeenCalledWith(MACHINE, 'kimi-k3', null);
    expect(core.ui.getState().providerProfileStatus[MACHINE]).toMatchObject({
      state: 'saving',
      profileId: 'kimi-k3',
    });
  });

  it('CDX-071: an http:// base URL is refused at the UI with the protocol sentence, verbatim', async () => {
    const core = await makeCore(true, []);
    const set = vi.spyOn(core.api, 'setProviderProfile').mockResolvedValue(true);
    renderProviders(core);

    fireEvent.click(screen.getByText('Add provider…'));
    fireEvent.change(screen.getByLabelText('Provider label'), { target: { value: 'Kimi K3' } });
    fireEvent.change(screen.getByLabelText('Model id 1'), { target: { value: 'kimi-k3' } });
    // Everything else valid: only the missing "s" stands between this and Save.
    fireEvent.change(screen.getByLabelText('Provider base URL'), {
      target: { value: 'http://api.moonshot.ai/anthropic' },
    });

    // Visible copy, verbatim from the protocol — no re-worded local variant.
    expect(screen.getByTestId('provider-base-url-error').textContent).toBe(
      PROVIDER_BASE_URL_ERROR,
    );
    expect((screen.getByText('Save on bridge') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('Save on bridge'));
    // Pre-CDX-071 this reached the send path and threw there, with nothing on
    // screen: the operator saw a failure and no reason.
    expect(set).not.toHaveBeenCalled();

    // https clears the error and unlocks Save.
    fireEvent.change(screen.getByLabelText('Provider base URL'), {
      target: { value: 'https://api.moonshot.ai/anthropic' },
    });
    expect(screen.queryByTestId('provider-base-url-error')).toBeNull();
    expect((screen.getByText('Save on bridge') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText('Save on bridge'));
    expect(set).toHaveBeenCalledWith(
      MACHINE,
      'kimi-k3',
      expect.objectContaining({ baseUrl: 'https://api.moonshot.ai/anthropic' }),
    );
  });

  it('CDX-071: a loopback http:// URL is a supported local model server, not a mistake', async () => {
    const core = await makeCore(true, []);
    const set = vi.spyOn(core.api, 'setProviderProfile').mockResolvedValue(true);
    renderProviders(core);

    fireEvent.click(screen.getByText('Add provider…'));
    fireEvent.change(screen.getByLabelText('Provider label'), { target: { value: 'Ollama' } });
    fireEvent.change(screen.getByLabelText('Model id 1'), { target: { value: 'llama3' } });
    fireEvent.change(screen.getByLabelText('Provider base URL'), {
      target: { value: 'http://localhost:11434' },
    });

    expect(screen.queryByTestId('provider-base-url-error')).toBeNull();
    fireEvent.click(screen.getByText('Save on bridge'));
    expect(set).toHaveBeenCalledWith(
      MACHINE,
      'ollama',
      expect.objectContaining({ baseUrl: 'http://localhost:11434' }),
    );
  });

  it('CDX-071: editing a legacy http:// profile surfaces the error instead of failing on Save', async () => {
    // The redacted bridge→phone echo stays permissive on purpose, so a profile
    // stored before the https gate existed still lists — the phone must show
    // WHY it cannot be re-saved rather than silently refusing.
    const legacy: ProviderProfileInfo = {
      id: 'legacy',
      label: 'Legacy',
      baseUrl: 'http://gateway.internal/anthropic',
      models: [{ id: 'm1' }],
      hasToken: false,
    };
    const core = await makeCore(true, [legacy]);
    renderProviders(core);

    expect(screen.getByTestId('provider-row').textContent).toContain(
      'http://gateway.internal/anthropic',
    );
    fireEvent.click(screen.getByText('Edit'));
    expect(screen.getByTestId('provider-base-url-error').textContent).toBe(
      PROVIDER_BASE_URL_ERROR,
    );
    expect((screen.getByText('Save on bridge') as HTMLButtonElement).disabled).toBe(true);
  });

  it('the status line renders the ack verdicts (saved + token INVALID, failed + error)', async () => {
    const core = await makeCore(true, PROFILES);
    renderProviders(core);

    core.ui.getState().applyProviderProfileAck(MACHINE, {
      profileId: 'kimi-k3',
      success: true,
      tokenValid: false,
    });
    expect((await screen.findByTestId('provider-profile-status')).textContent).toContain(
      'token INVALID',
    );

    core.ui.getState().applyProviderProfileAck(MACHINE, {
      profileId: 'kimi-k3',
      success: false,
      error: 'disk full',
    });
    expect((await screen.findByTestId('provider-profile-status')).textContent).toContain(
      'Saving failed: disk full',
    );
  });

  it('re-requests per heartbeat while unfetched; an answered list ends the loop', async () => {
    const core = await makeCore(true);
    const request = vi.spyOn(core.api, 'requestProviderProfiles').mockResolvedValue(true);
    renderProviders(core);
    expect(request).toHaveBeenCalledTimes(1);

    core.machines.getState().applySessionList(
      MACHINE,
      { type: 'sessions', machine: 'laptop', sessions: [], protocolVersion: 10 },
      Date.now() + 1,
    );
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    core.machines
      .getState()
      .applyProviderProfiles(MACHINE, { type: 'provider-profiles', machine: 'laptop', profiles: [] });
    core.machines.getState().applySessionList(
      MACHINE,
      { type: 'sessions', machine: 'laptop', sessions: [], protocolVersion: 10 },
      Date.now() + 2,
    );
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
