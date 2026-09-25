/**
 * Installing an agent's CLI binary on demand. The release archives do not
 * ship the agents' platform binaries (a couple of hundred MB each); a driver
 * that finds no binary on the machine asks for its npm platform package
 * here instead. The package is fetched from the npm registry at the exact
 * version and sha512 pnpm-lock.yaml pins (src/generated/platformPackages.ts),
 * so what runs is what this build was tested with, and a download that does
 * not match is rejected. Only the one binary is kept, under
 * `<cache>/<package>@<version>/`; older versions of the package are removed
 * once a new one is in place.
 *
 * Nothing here knows a particular agent: the driver names the package and
 * the binary's path inside it.
 */
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { isFile } from './executable';
import { PLATFORM_PACKAGES } from './generated/platformPackages';
import type { PackagePin } from './lockfilePins';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** A binary inside an npm platform package. */
export interface PackagedBinary {
  /** The npm package, e.g. `@anthropic-ai/claude-agent-sdk-linux-x64`. */
  pkg: string;
  /** Its path inside the package, `/`-separated, e.g. `bin/opencode`. */
  file: string;
  /** What to call it in logs and errors. */
  label: string;
}

export interface InstallOptions {
  /** Where installed binaries live (see agentCacheDir). */
  cacheDir: string;
  /** The npm registry base URL (see registryUrl). */
  registry?: string;
  log: (message: string) => void;
  fetchFn?: typeof fetch;
  pins?: Readonly<Record<string, PackagePin>>;
}

/** The bridge passes `<home>/agents`; a host started by hand uses the same
 *  place under the default home. */
export function agentCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEDECK_AGENT_CACHE?.trim() || path.join(os.homedir(), '.codedeck', 'agents');
}

/** CODEDECK_NPM_REGISTRY points at a mirror; the sha512 pin still applies. */
export function registryUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.CODEDECK_NPM_REGISTRY?.trim() || DEFAULT_REGISTRY).replace(/\/+$/, '');
}

/** Install `binary` if it is not cached yet, and return its path. */
export async function installBinary(binary: PackagedBinary, options: InstallOptions): Promise<string> {
  const pin = (options.pins ?? PLATFORM_PACKAGES)[binary.pkg];
  if (!pin) throw new Error(`${binary.label}: ${binary.pkg} is not pinned in this build, so it cannot be downloaded`);

  const prefix = `${binary.pkg.replace('/', '+')}@`;
  const dir = path.join(options.cacheDir, `${prefix}${pin.version}`);
  const target = path.join(dir, ...binary.file.split('/'));
  if (isFile(target)) return target;

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tarball = path.join(dir, `.download-${process.pid}.tgz`);
  const partial = `${target}.part-${process.pid}`;
  try {
    const url = `${options.registry ?? DEFAULT_REGISTRY}/${binary.pkg}/-/${binary.pkg.split('/').pop()}-${pin.version}.tgz`;
    const res = await (options.fetchFn ?? fetch)(url);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} from ${url}`);
    const size = Number(res.headers.get('content-length'));
    options.log(
      `[install] downloading ${binary.label} (${binary.pkg}@${pin.version}` +
        `${size > 0 ? `, ${Math.round(size / 1048576)} MB` : ''}) from ${url}`,
    );

    const hash = createHash('sha512');
    await pipeline(
      Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
      new Transform({
        transform(chunk: Buffer, _encoding, done) {
          hash.update(chunk);
          done(null, chunk);
        },
      }),
      fs.createWriteStream(tarball),
    );
    const actual = `sha512-${hash.digest('base64')}`;
    if (actual !== pin.integrity) {
      throw new Error(`${binary.pkg}@${pin.version} does not match its pinned sha512; the download was rejected`);
    }

    // The tarball stream is closed before the tarball is removed: Windows
    // cannot delete a file that is still open.
    const source = fs.createReadStream(tarball);
    let found: boolean;
    try {
      found = await extractFile(source.pipe(createGunzip()), `package/${binary.file}`, partial);
    } finally {
      source.destroy();
      if (!source.closed) await once(source, 'close');
    }
    if (!found) throw new Error(`${binary.pkg}@${pin.version} has no ${binary.file}`);
    fs.chmodSync(partial, 0o755);
    fs.renameSync(partial, target);
  } catch (err) {
    throw new Error(`${binary.label} could not be installed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    removeQuietly(tarball);
    removeQuietly(partial);
  }

  pruneOtherVersions(options.cacheDir, prefix, path.basename(dir));
  options.log(`[install] ${binary.label} installed at ${target}`);
  return target;
}

/** Best-effort cleanup: a leftover must never mask the install's outcome. */
function removeQuietly(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* left for the next install to overwrite */
  }
}

function pruneOtherVersions(cacheDir: string, prefix: string, keep: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(cacheDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(prefix) && name !== keep) removeQuietly(path.join(cacheDir, name));
  }
}

/**
 * Stream a tar archive and write the one regular file named `wanted` to
 * `dest`. Returns whether it was found. Understands ustar names with a
 * prefix and the pax / GNU long-name records npm tarballs may carry.
 */
export async function extractFile(tar: AsyncIterable<Buffer>, wanted: string, dest: string): Promise<boolean> {
  let pending: Buffer = Buffer.alloc(0);
  let inBody = false;
  let bodyLeft = 0;
  let padLeft = 0;
  let sink: 'skip' | 'file' | 'pax' | 'longname' = 'skip';
  let meta: Buffer[] = [];
  let nextName: string | undefined;
  let out: fs.WriteStream | null = null;

  const endBody = async (): Promise<boolean> => {
    inBody = false;
    if (sink === 'file' && out) {
      out.end();
      await once(out, 'finish');
      return true;
    }
    if (sink === 'longname') nextName = cString(Buffer.concat(meta), 0, Infinity);
    if (sink === 'pax') nextName = paxPath(Buffer.concat(meta).toString('utf8')) ?? nextName;
    return false;
  };

  try {
    for await (const chunk of tar) {
      pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      let offset = 0;
      for (;;) {
        if (!inBody) {
          const skip = Math.min(padLeft, pending.length - offset);
          offset += skip;
          padLeft -= skip;
          if (padLeft > 0 || pending.length - offset < 512) break;
          const header = pending.subarray(offset, offset + 512);
          offset += 512;
          if (header.every((b) => b === 0)) continue; // end-of-archive blocks
          const type = String.fromCharCode(header[156] || 0x30);
          const name = nextName ?? entryName(header);
          nextName = undefined;
          bodyLeft = parseInt(cString(header, 124, 12).trim() || '0', 8);
          padLeft = (512 - (bodyLeft % 512)) % 512;
          meta = [];
          sink = type === 'x' ? 'pax' : type === 'L' ? 'longname' : type === '0' && name === wanted ? 'file' : 'skip';
          if (sink === 'file') out = fs.createWriteStream(dest);
          inBody = true;
          if (bodyLeft === 0 && (await endBody())) return true;
          continue;
        }
        const n = Math.min(bodyLeft, pending.length - offset);
        if (n === 0) break;
        const piece = pending.subarray(offset, offset + n);
        offset += n;
        bodyLeft -= n;
        if (sink === 'file' && out && !out.write(piece)) await once(out, 'drain');
        else if (sink === 'pax' || sink === 'longname') meta.push(Buffer.from(piece));
        if (bodyLeft === 0 && (await endBody())) return true;
      }
      pending = pending.subarray(offset);
    }
    return false;
  } finally {
    if (out && !out.writableFinished) out.destroy();
  }
}

/** A NUL-terminated field of a tar header. */
function cString(block: Buffer, start: number, length: number): string {
  const field = block.subarray(start, Math.min(block.length, start + length));
  const nul = field.indexOf(0);
  return field.subarray(0, nul < 0 ? field.length : nul).toString('utf8');
}

function entryName(header: Buffer): string {
  const name = cString(header, 0, 100);
  const prefix = cString(header, 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

/** The `path` of a pax extended header (`<len> path=<value>\n` records). */
function paxPath(records: string): string | undefined {
  for (const record of records.split('\n')) {
    const match = /^\d+ path=(.*)$/.exec(record);
    if (match) return match[1];
  }
  return undefined;
}
