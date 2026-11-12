/**
 * Writes the release manifest build.mjs bakes into the extension:
 *
 *   node tools/manifest.mjs <version> <owner/repo> <archive dir> <out.json>
 *
 * It names the bridge archive of each platform in <archive dir> (as the
 * release workflow names them) and its sha256. Every platform must be there:
 * an extension that cannot install on one of them is not shipped.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PLATFORMS = {
  'linux-x86_64': 'tar.xz',
  'linux-aarch64': 'tar.xz',
  'macos-aarch64': 'tar.xz',
  'windows-x86_64': 'zip',
};

const [version, repository, dir, out] = process.argv.slice(2);
if (!version || !repository || !dir || !out) {
  console.error('usage: node tools/manifest.mjs <version> <owner/repo> <archive dir> <out.json>');
  process.exit(2);
}

const assets = {};
for (const [key, ext] of Object.entries(PLATFORMS)) {
  const name = `codedeck-bridge-${version}-${key}.${ext}`;
  const sha256 = createHash('sha256').update(readFileSync(path.join(dir, name))).digest('hex');
  assets[key] = { name, sha256 };
  console.log(`${sha256}  ${name}`);
}
writeFileSync(out, `${JSON.stringify({ version, repository, assets }, null, 2)}\n`);
