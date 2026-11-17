import { defineConfig } from 'vitest/config';
import { bundlePiExtension } from './src/drivers/pi/extension/bundle.mjs';

export default defineConfig(async () => ({
  // The CodeDeck Pi extension as the build carries it (build.mjs), so a test
  // that starts a real Pi runs the extension a release ships.
  define: { __CODEDECK_PI_EXTENSION__: JSON.stringify(await bundlePiExtension()) },
  test: {
    // Above the recording context's WAIT_FOR_MS, so a session event that
    // never comes fails with what it was waiting for, not a bare timeout.
    testTimeout: 20_000,
  },
}));
