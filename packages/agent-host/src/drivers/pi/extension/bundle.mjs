/**
 * Bundle the CodeDeck Pi extension (index.ts) into one ESM module's text.
 *
 * The agent host's build defines the result as `__CODEDECK_PI_EXTENSION__`
 * (build.mjs), and so does the test configuration (vitest.config.mjs), so a
 * test runs the same extension a release ships. Pi provides
 * `@earendil-works/*` and `typebox` to extensions, mapped to its own copies,
 * so they stay external: bundling them would load a second copy whose
 * classes and registries are not Pi's.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

export async function bundlePiExtension() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./index.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    write: false,
    external: ['@earendil-works/*', 'typebox', 'typebox/*'],
    banner: {
      js: "// Written by CodeDeck+ — the CodeDeck Pi extension of every Pi session.\n// Regenerated at each session start; do not edit.",
    },
    logLevel: 'warning',
  });
  const [file] = result.outputFiles;
  if (!file) throw new Error('esbuild produced no Pi extension');
  return file.text;
}
