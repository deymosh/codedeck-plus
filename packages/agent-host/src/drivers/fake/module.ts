/**
 * The fake agent: scripted sessions for the bridge's and the host's tests.
 * Nothing to install, and loaded only when asked for by name.
 */
import type { DriverModule } from '../../sdk/module';
import { FAKE_AGENT_ID, FakeDriver } from './driver';

export const fakeModule: DriverModule = {
  id: FAKE_AGENT_ID,
  label: 'Fake agent',
  explicitOnly: true,
  create: () => new FakeDriver(),
};
