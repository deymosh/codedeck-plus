/**
 * Packs the built extension into a .vsix:
 *
 *   node tools/package.mjs [out.vsix] [version]
 *
 * The version (a release's number, e.g. 1.4.0) is written into package.json
 * first, so the .vsix carries the release it installs. The licence and the
 * icon are copied in from the repository; they are not kept twice in git.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVSIX } from '@vscode/vsce';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repo = path.resolve(root, '../..');
const [out = 'codedeck-plus-vscode.vsix', version] = process.argv.slice(2);

copyFileSync(path.join(repo, 'LICENSE'), path.join(root, 'LICENSE'));
mkdirSync(path.join(root, 'media'), { recursive: true });
copyFileSync(path.join(repo, 'docs', 'logo.png'), path.join(root, 'media', 'icon.png'));

const manifest = path.join(root, 'package.json');
const original = readFileSync(manifest, 'utf8');
if (version) {
  writeFileSync(manifest, `${JSON.stringify({ ...JSON.parse(original), version }, null, 2)}\n`);
}
try {
  // The bundle holds every dependency; node_modules stays out.
  await createVSIX({ cwd: root, packagePath: path.resolve(out), dependencies: false });
} finally {
  writeFileSync(manifest, original);
}
