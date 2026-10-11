import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Above the recording context's WAIT_FOR_MS, so a session event that
    // never comes fails with what it was waiting for, not a bare timeout.
    testTimeout: 20_000,
  },
});
