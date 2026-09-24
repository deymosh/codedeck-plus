/**
 * esbuild bundle of the agent host: one ESM file the bridge spawns with
 * `node`. The banner shims `require` via createRequire, because CJS
 * dependencies dynamically require node builtins, which a plain ESM bundle
 * cannot satisfy.
 *
 * The Claude Agent SDK stays external: it ships its own CLI binary and must
 * resolve its files from node_modules, not from inside a bundle.
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/main.js',
  external: ['@anthropic-ai/claude-agent-sdk'],
  banner: {
    js: [
      'import { createRequire as __cdxCreateRequire } from "node:module";',
      'const require = __cdxCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});
