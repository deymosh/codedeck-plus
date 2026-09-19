/**
 * esbuild bundle for the harness CLI. `ws` stays external (like
 * `apps/bridge`'s own build): it optionally `require()`s the native
 * `bufferutil`/`utf-8-validate` addons at runtime, which a static bundle
 * can't resolve — and since this ships as a devtool alongside its own
 * `node_modules`, external is free (no separate publish step to keep in
 * sync). The CJS shim mirrors `apps/bridge/build.mjs` for the same reason:
 * `ws` internally does a dynamic `require`, which a plain ESM bundle can't
 * satisfy on its own.
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'out/main.js',
  external: ['ws'],
  banner: {
    js: [
      '#!/usr/bin/env node',
      'import { createRequire as __cdxCreateRequire } from "node:module";',
      'const require = __cdxCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});
