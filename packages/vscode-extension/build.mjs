/**
 * esbuild bundle of the extension: one CommonJS file VS Code loads, with
 * `vscode` left to the editor.
 *
 * CODEDECK_RELEASE_MANIFEST names the release manifest the release workflow
 * writes (tools/manifest.mjs): its archives' names and sha256, baked into the
 * bundle so the extension installs only those exact archives. Without it the
 * build carries no release and runs the bridge `codedeck.bridgePath` names.
 */
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const PLATFORMS = ['linux-x86_64', 'linux-aarch64', 'macos-aarch64', 'windows-x86_64'];

let release = null;
const manifest = process.env.CODEDECK_RELEASE_MANIFEST;
if (manifest) {
  release = JSON.parse(readFileSync(manifest, 'utf8'));
  for (const key of PLATFORMS) {
    if (!/^[0-9a-f]{64}$/.test(release.assets?.[key]?.sha256 ?? '')) {
      throw new Error(`${manifest}: no sha256 for ${key}`);
    }
  }
}

await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  // The Node in VS Code 1.100's Electron.
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  define: { __CODEDECK_RELEASE__: JSON.stringify(release) },
  logLevel: 'info',
});
