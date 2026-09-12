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
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CAPABILITIES, PROVIDER_BASE_URL_ERROR } from '../../core/protocolConstants';
import { buildFakePhoneCore, tick } from '../../core/__tests__/nativeCoreFixture';
import type { MachineView, ProviderProfileInfo } from '../../core/nativeCoreTypes';
import type { PhoneCore } from '../../core/phoneCore';
import { PhoneCoreProvider } from '../coreContext';
import { MachineProviders, profileIdFromLabel } from '../screens/MachineProviders';
import { SettingsScreen } from '../screens/SettingsScreen';

afterEach(cleanup);

const MACHINE = 'a'.repeat(64);

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

function baseMachine(withCap: boolean, profiles: ProviderProfileInfo[] | undefined, heartbeatAt = 1): MachineView {
  return {
    pubkeyHex: MACHINE,
    name: 'laptop',
    capabilities: withCap ? [CAPABILITIES.customProviders] : [],
    folders: [],
    roots: [],
    protocolVersion: null,
    machineOffline: false,
    lastHeartbeatAt: heartbeatAt,
    sessions: {},
    ...(profiles !== undefined ? { providerProfiles: profiles } : {}),
  };
}

async function makeCore(withCap = true, profiles?: ProviderProfileInfo[]) {
  return buildFakePhoneCore({ machines: { machines: { [MACHINE]: baseMachine(withCap, profiles) } } });
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
    const { phone: core, fake } = await makeCore(false);
    render(
      <PhoneCoreProvider value={core}>
        <SettingsScreen />
      </PhoneCoreProvider>,
    );

    expect(screen.getByTestId('machine-block')).toBeTruthy();
    expect(screen.queryByTestId('machine-providers')).toBeNull();
    expect(fake.dispatched.some((i) => typeof i === 'object' && 'requestProviderProfiles' in i)).toBe(false);
  });

  it('with the capability the section mounts inside the machine block and requests the list', async () => {
    const { phone: core, fake } = await makeCore(true);
    render(
      <PhoneCoreProvider value={core}>
        <SettingsScreen />
      </PhoneCoreProvider>,
    );

    expect(screen.getByTestId('machine-providers')).toBeTruthy();
    expect(screen.getByText('Loading provider profiles…')).toBeTruthy();
    expect(fake.dispatched).toContainEqual({ requestProviderProfiles: { machine: MACHINE } });
  });

  it('rows show label, baseUrl, model count and the hasToken badge — never a token', async () => {
    const { phone: core } = await makeCore(true, PROFILES);
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
    const { phone: core, fake } = await makeCore(true, [PROFILES[1]!]);
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

    expect(fake.dispatched).toContainEqual({
      setProviderProfile: {
        machine: MACHINE,
        profileId: 'kimi-k3',
        profile: {
          label: 'Kimi K3',
          baseUrl: 'https://api.moonshot.ai/anthropic',
          authToken: 'sk-kimi-secret',
          models: [{ id: 'kimi-k3', label: 'Kimi K3' }],
          defaultModel: 'kimi-k3',
        },
      },
    });
    // The secret is gone from the DOM either way. The screen's own optimistic
    // "Saving…" status write (`noteProviderProfileSent`) is a documented,
    // still-open native gap — see nativeUi.ts's module doc — so it is not
    // asserted here; only a real ack (tested below) drives that status now.
    expect(screen.queryByDisplayValue('sk-kimi-secret')).toBeNull();
  });

  it('OpenRouter preset prefills the base URL with the models left for the user; empty models gate Save', async () => {
    const { phone: core } = await makeCore(true, []);
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
    const { phone: core, fake } = await makeCore(true, PROFILES);
    renderProviders(core);

    fireEvent.click(screen.getAllByText('Edit')[0]!);
    // The password field shows "unchanged" for a profile with a stored token.
    expect(
      (screen.getByLabelText('Provider auth token') as HTMLInputElement).placeholder,
    ).toBe('unchanged');
    fireEvent.click(screen.getByText('Save on bridge'));

    const dispatched = fake.dispatched.find(
      (i) => typeof i === 'object' && 'setProviderProfile' in i,
    ) as { setProviderProfile: { profileId: string; profile: Record<string, unknown> | null } };
    expect(dispatched.setProviderProfile.profileId).toBe('kimi-k3'); // edit reuses the id, no re-slug
    expect(dispatched.setProviderProfile.profile).not.toBeNull();
    expect('authToken' in dispatched.setProviderProfile.profile!).toBe(false);
  });

  it('edit with Clear token checked sends an explicit null (delete semantics)', async () => {
    const { phone: core, fake } = await makeCore(true, PROFILES);
    renderProviders(core);

    fireEvent.click(screen.getAllByText('Edit')[0]!);
    fireEvent.click(screen.getByLabelText('Clear token'));
    fireEvent.click(screen.getByText('Save on bridge'));

    const dispatched = fake.dispatched.find(
      (i) => typeof i === 'object' && 'setProviderProfile' in i,
    ) as { setProviderProfile: { profile: { authToken: unknown } | null } };
    expect(dispatched.setProviderProfile.profile!.authToken).toBeNull();
  });

  it('delete requires the confirm step; Cancel sends nothing, confirm sends profile: null', async () => {
    const { phone: core, fake } = await makeCore(true, PROFILES);
    renderProviders(core);

    fireEvent.click(screen.getAllByText('Delete…')[0]!);
    expect(screen.getByText(/Delete Kimi K3 from the bridge\?/)).toBeTruthy();
    fireEvent.click(screen.getByText('Cancel'));
    expect(fake.dispatched.some((i) => typeof i === 'object' && 'setProviderProfile' in i)).toBe(false);

    fireEvent.click(screen.getAllByText('Delete…')[0]!);
    fireEvent.click(screen.getByText('Delete profile'));
    expect(fake.dispatched).toContainEqual({
      setProviderProfile: { machine: MACHINE, profileId: 'kimi-k3', profile: null },
    });
  });

  it('CDX-071: an http:// base URL is refused at the UI with the protocol sentence, verbatim', async () => {
    const { phone: core, fake } = await makeCore(true, []);
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
    expect(fake.dispatched.some((i) => typeof i === 'object' && 'setProviderProfile' in i)).toBe(false);

    // https clears the error and unlocks Save.
    fireEvent.change(screen.getByLabelText('Provider base URL'), {
      target: { value: 'https://api.moonshot.ai/anthropic' },
    });
    expect(screen.queryByTestId('provider-base-url-error')).toBeNull();
    expect((screen.getByText('Save on bridge') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText('Save on bridge'));
    expect(fake.dispatched).toContainEqual(
      expect.objectContaining({
        setProviderProfile: expect.objectContaining({
          profile: expect.objectContaining({ baseUrl: 'https://api.moonshot.ai/anthropic' }),
        }),
      }),
    );
  });

  it('CDX-071: a loopback http:// URL is a supported local model server, not a mistake', async () => {
    const { phone: core, fake } = await makeCore(true, []);
    renderProviders(core);

    fireEvent.click(screen.getByText('Add provider…'));
    fireEvent.change(screen.getByLabelText('Provider label'), { target: { value: 'Ollama' } });
    fireEvent.change(screen.getByLabelText('Model id 1'), { target: { value: 'llama3' } });
    fireEvent.change(screen.getByLabelText('Provider base URL'), {
      target: { value: 'http://localhost:11434' },
    });

    expect(screen.queryByTestId('provider-base-url-error')).toBeNull();
    fireEvent.click(screen.getByText('Save on bridge'));
    expect(fake.dispatched).toContainEqual(
      expect.objectContaining({
        setProviderProfile: expect.objectContaining({
          profileId: 'ollama',
          profile: expect.objectContaining({ baseUrl: 'http://localhost:11434' }),
        }),
      }),
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
    const { phone: core } = await makeCore(true, [legacy]);
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
    const { phone: core, fake } = await makeCore(true, PROFILES);
    renderProviders(core);

    // `applyProviderProfileAck` is a no-op native adapter method (the Rust
    // Router already folds a real ack into `UiView` — see nativeUi.ts's
    // module doc) — seed the resulting view directly instead.
    await act(async () => {
      fake.setView('ui', {
        ...fake.views.ui,
        providerProfileStatus: {
          [MACHINE]: { state: 'saved', at: 0, profileId: 'kimi-k3', tokenValid: false },
        },
      });
      await tick();
    });
    expect((await screen.findByTestId('provider-profile-status')).textContent).toContain(
      'token INVALID',
    );

    await act(async () => {
      fake.setView('ui', {
        ...fake.views.ui,
        providerProfileStatus: {
          [MACHINE]: { state: 'failed', at: 0, profileId: 'kimi-k3', error: 'disk full' },
        },
      });
      await tick();
    });
    expect((await screen.findByTestId('provider-profile-status')).textContent).toContain(
      'Saving failed: disk full',
    );
  });

  it('re-requests per heartbeat while unfetched; an answered list ends the loop', async () => {
    const { phone: core, fake } = await makeCore(true);
    renderProviders(core);
    expect(fake.dispatched.filter((i) => typeof i === 'object' && 'requestProviderProfiles' in i)).toHaveLength(1);

    await act(async () => {
      fake.setView('machines', { machines: { [MACHINE]: baseMachine(true, undefined, 2) } });
      await tick();
    });
    expect(
      fake.dispatched.filter((i) => typeof i === 'object' && 'requestProviderProfiles' in i),
    ).toHaveLength(2);

    await act(async () => {
      fake.setView('machines', { machines: { [MACHINE]: baseMachine(true, [], 3) } });
      await tick();
    });
    expect(
      fake.dispatched.filter((i) => typeof i === 'object' && 'requestProviderProfiles' in i),
    ).toHaveLength(2);
  });
});
