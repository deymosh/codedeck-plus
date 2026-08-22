/**
 * esbuild bundle for the CLI. A script (not a one-liner) because the banner
 * needs real newlines: after the shebang we shim `require` via createRequire —
 * CJS deps (qrcode) dynamically require node builtins, which a plain ESM
 * bundle can't satisfy ("Dynamic require of 'fs' is not supported").
 *
 * @anthropic-ai/claude-agent-sdk stays external (CDB-036): it ships its own
 * CLI binary and must resolve its files from node_modules, not from a bundle.
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'out/main.js',
  external: ['@anthropic-ai/claude-agent-sdk'],
  banner: {
    js: [
      '#!/usr/bin/env node',
      'import { createRequire as __cdxCreateRequire } from "node:module";',
      'const require = __cdxCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});
