import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Tauri v2 dev server expectations (fixed port, no auto-open) are configured in
// Phase 3 when src-tauri lands; for now this is a plain web build target.
export default defineConfig({
  plugins: [react()],
  server: { port: 1420, strictPort: true },
  build: { target: 'es2022' },
  test: {
    // CDX-034. 21 of these files ask for their own jsdom environment via a
    // `@vitest-environment` docblock, so every worker pays a full jsdom setup.
    // Left uncapped, vitest sizes the pool off the host core count (16 here)
    // and the box thrashes: the seeded property tests (pinReducer storms,
    // mergeSessionList sequences) stretch from ~1.1s to ~8s and the whole run
    // roughly doubles. Measured on this 16-core/14GB laptop, median of 7 runs:
    // uncapped 19.9s wall / pinReducer 8.0s, capped at 4 → 10.2s / 1.1s.
    // 4 is also exactly the vCPU count of the `ubuntu-latest` runner CI uses,
    // so the cap is a no-op there and purely a guard on fat dev machines.
    maxWorkers: 4,
    minWorkers: 1,
  },
});
