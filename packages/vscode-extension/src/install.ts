/**
 * Installs the bridge from a release archive: download, check its sha256
 * against the release manifest, unpack it with the system `tar`, and only
 * then move it to where the extension runs it from. A failed or tampered
 * download leaves nothing behind that could pass for an installed bridge.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { ReleaseAsset } from './release.js';

export interface InstallOptions {
  /** The archive's URL. */
  url: string;
  asset: ReleaseAsset;
  /** The release tag: each release unpacks into its own directory. */
  version: string;
  /** The extension's storage directory. */
  storage: string;
  platform?: NodeJS.Platform;
  fetch?: typeof fetch;
  /** Bytes received so far and the total, when the server says. */
  onProgress?: (received: number, total: number | undefined) => void;
}

/** The binary's name in an archive. */
export function binaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'codedeck-bridge.exe' : 'codedeck-bridge';
}

/** The archive's top directory: its file name without the extension. */
function archiveRoot(asset: ReleaseAsset): string {
  return asset.name.replace(/\.(tar\.xz|zip)$/, '');
}

/** Where a release's bridge binary is once installed. */
export function installedBinary(storage: string, version: string, asset: ReleaseAsset, platform: NodeJS.Platform): string {
  return path.join(storage, 'bridge', version, archiveRoot(asset), binaryName(platform));
}

/**
 * The installed bridge's binary, downloading and verifying the archive
 * first if this release is not installed yet. Older releases' directories
 * are removed once the new one is in place.
 */
export async function ensureBridge(options: InstallOptions): Promise<string> {
  const platform = options.platform ?? process.platform;
  const binary = installedBinary(options.storage, options.version, options.asset, platform);
  if (existsSync(binary)) return binary;

  const bridges = path.join(options.storage, 'bridge');
  await mkdir(bridges, { recursive: true });
  const scratch = await mkdtemp(path.join(bridges, '.download-'));
  try {
    const archive = path.join(scratch, options.asset.name);
    const digest = await download(options.url, archive, options.fetch ?? fetch, options.onProgress);
    if (digest !== options.asset.sha256) {
      throw new Error(`${options.asset.name} does not match this release: sha256 ${digest}, expected ${options.asset.sha256}`);
    }
    const unpacked = path.join(scratch, 'unpacked');
    await mkdir(unpacked);
    await untar(archive, unpacked, platform);
    const root = path.join(unpacked, archiveRoot(options.asset));
    if (!existsSync(path.join(root, binaryName(platform)))) {
      throw new Error(`${options.asset.name} holds no ${binaryName(platform)}`);
    }
    const target = path.dirname(binary);
    await rm(target, { recursive: true, force: true });
    await mkdir(path.dirname(target), { recursive: true });
    await rename(root, target);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  await removeOtherReleases(bridges, options.version);
  return binary;
}

/** Streams `url` to `file` and returns its sha256 (lowercase hex). */
async function download(
  url: string,
  file: string,
  fetchImpl: typeof fetch,
  onProgress?: (received: number, total: number | undefined) => void,
): Promise<string> {
  const response = await fetchImpl(url);
  if (!response.ok || !response.body) {
    throw new Error(`downloading ${url} failed: HTTP ${response.status}`);
  }
  const length = Number(response.headers.get('content-length'));
  const total = Number.isFinite(length) && length > 0 ? length : undefined;
  const hash = createHash('sha256');
  let received = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      received += chunk.length;
      onProgress?.(received, total);
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), tap, createWriteStream(file));
  return hash.digest('hex');
}

/**
 * Unpacks with the system `tar`: GNU tar or bsdtar on Linux and macOS (both
 * read `.tar.xz`), and on Windows the bsdtar that ships in System32, which
 * reads `.zip` — named by its full path, because a Git for Windows `tar` on
 * PATH is GNU tar and cannot.
 */
function untar(archive: string, into: string, platform: NodeJS.Platform): Promise<void> {
  const tar =
    platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  return new Promise((resolve, reject) => {
    const child = spawn(tar, ['-xf', archive, '-C', into], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (err) => reject(new Error(`cannot run ${tar}: ${err.message}`)));
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${tar} could not unpack ${path.basename(archive)}: ${stderr.trim()}`)),
    );
  });
}

/**
 * Best effort: a directory still in use (a bridge of that release running
 * in another window, on Windows) stays until a later install.
 */
async function removeOtherReleases(bridges: string, keep: string): Promise<void> {
  for (const entry of await readdir(bridges)) {
    if (entry !== keep && !entry.startsWith('.download-')) {
      await rm(path.join(bridges, entry), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
