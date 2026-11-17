/**
 * esbuild bundle of the agent host: one ESM file the bridge spawns with
 * `node`. The banner shims `require` via createRequire, because CJS
 * dependencies dynamically require node builtins, which a plain ESM bundle
 * cannot satisfy.
 *
 * The Claude Agent SDK stays external: it ships its own CLI binary and must
 * resolve its files from node_modules, not from inside a bundle.
 *
 * The CodeDeck Pi extension is bundled first, on its own, and carried inside
 * the host as text (`__CODEDECK_PI_EXTENSION__`): it runs inside Pi's
 * process, not the host's, and the driver writes it into Pi's home.
 */
import { build } from 'esbuild';
import { bundlePiExtension } from './src/drivers/pi/extension/bundle.mjs';

const piExtension = await bundlePiExtension();

await build({
  entryPoints: ['src/host/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/main.js',
  external: ['@anthropic-ai/claude-agent-sdk'],
  define: { __CODEDECK_PI_EXTENSION__: JSON.stringify(piExtension) },
  banner: {
    js: [
      'import { createRequire as __cdxCreateRequire } from "node:module";',
      'const require = __cdxCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});
