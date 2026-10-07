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
import { createGunzip, gunzipSync } from 'node:zlib';
import { isFile, isMusl } from './executable';
import { PLATFORM_PACKAGES } from './generated/platformPackages';
import type { PackagePin, TreePackageEntry } from './lockfilePins';

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

/** `<cache>/bin`: a stable name for each installed binary, for people (a
 *  shell in the container puts it on PATH). */
export function agentBinDir(cacheDir: string): string {
  return path.join(cacheDir, 'bin');
}

/**
 * `env` with `<cache>/bin` dropped from its PATH, for the drivers' own
 * lookups. A link there points at whatever version was installed last, so a
 * driver that found it on PATH would never install the version this build
 * pins after an upgrade moved the pin; drivers resolve the pinned binary
 * through installBinary instead.
 */
export function withoutAgentBin(env: NodeJS.ProcessEnv, cacheDir: string): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  const value = key ? env[key] : undefined;
  if (!key || !value) return env;
  const bin = realPath(agentBinDir(cacheDir));
  const kept = value.split(path.delimiter).filter((dir) => dir.length > 0 && realPath(dir) !== bin);
  return { ...env, [key]: kept.join(path.delimiter) };
}

/** Symlinks resolved when the path exists (the image reaches /data/agents as
 *  ~/.codedeck/agents), else just made absolute. */
function realPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * The file beside an installed binary that says it is complete: written,
 * holding the pin's sha512, only once the binary is whole. Installs never
 * rename anything into place — some filesystems the cache lives on (a
 * Windows host's bind mount in a container, a Windows disk an antivirus is
 * scanning) refuse a rename of a file they have just seen written, for
 * longer than any retry should wait — so completeness is this marker's to
 * say instead.
 */
const INSTALLED_MARKER = '.installed';

/** Install `binary` if it is not cached yet, and return its path. */
export async function installBinary(binary: PackagedBinary, options: InstallOptions): Promise<string> {
  const pin = (options.pins ?? PLATFORM_PACKAGES)[binary.pkg];
  if (!pin) throw new Error(`${binary.label}: ${binary.pkg} is not pinned in this build, so it cannot be downloaded`);

  const prefix = `${binary.pkg.replace('/', '+')}@`;
  const dir = path.join(options.cacheDir, `${prefix}${pin.version}`);
  const target = path.join(dir, ...binary.file.split('/'));
  const marker = path.join(dir, INSTALLED_MARKER);
  if (isFile(target) && readQuietly(marker) === pin.integrity) {
    linkIntoBin(options.cacheDir, target);
    return target;
  }

  // Whatever is there is incomplete: it stops counting as installed before
  // a byte of the new one is written.
  removeQuietly(marker);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tarball = path.join(dir, `.download-${process.pid}.tgz`);
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
      found = await extractFile(source.pipe(createGunzip()), `package/${binary.file}`, target);
    } finally {
      source.destroy();
      if (!source.closed) await once(source, 'close');
    }
    if (!found) throw new Error(`${binary.pkg}@${pin.version} has no ${binary.file}`);
    fs.chmodSync(target, 0o755);
    fs.writeFileSync(marker, pin.integrity);
  } catch (err) {
    throw new Error(`${binary.label} could not be installed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    removeQuietly(tarball);
  }

  pruneOtherVersions(options.cacheDir, prefix, path.basename(dir));
  linkIntoBin(options.cacheDir, target);
  options.log(`[install] ${binary.label} installed at ${target}`);
  return target;
}

/** Point `<cache>/bin/<name>` at `target` (replacing a link to an older
 *  version). Best effort, and skipped on Windows, where creating a symlink
 *  needs a privilege a normal account lacks. */
function linkIntoBin(cacheDir: string, target: string): void {
  if (process.platform === 'win32') return;
  const bin = agentBinDir(cacheDir);
  const link = path.join(bin, path.basename(target));
  const relative = path.relative(bin, target);
  try {
    if (fs.readlinkSync(link) === relative) return;
  } catch {
    /* no link yet */
  }
  const staged = `${link}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(bin, { recursive: true });
    removeQuietly(staged);
    fs.symlinkSync(relative, staged);
    fs.renameSync(staged, link);
  } catch {
    removeQuietly(staged);
  }
}

/** Best-effort cleanup: a leftover must never mask the install's outcome. */
function removeQuietly(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* left for the next install to overwrite */
  }
}

/** A small text file's contents, or undefined when it cannot be read. */
function readQuietly(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
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

// --- Whole dependency trees ---
//
// A pure-JS agent CLI (the DeepSeek Harness runtime) is not one platform
// binary but a ~90-package npm closure: nothing to run unless every package
// sits in one node_modules. The pins for that come from pnpm-lock.yaml the
// same way the single-binary pins do (src/lockfilePins.ts), and the same
// rules hold — every tarball at the exact pinned version, rejected unless
// its sha512 matches, from the configured registry or mirror.

/** Whether a tree package's platform gates admit this machine. */
export function packageMatchesPlatform(
  pin: { os?: string[]; cpu?: string[]; libc?: string[] },
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl: boolean = isMusl(),
): boolean {
  if (pin.os && !pin.os.includes(platform)) return false;
  if (pin.cpu && !pin.cpu.includes(arch)) return false;
  if (pin.libc && !pin.libc.includes(musl ? 'musl' : 'glibc')) return false;
  return true;
}

/** The `version` of an installed package's package.json, or undefined for a
 *  missing or unreadable package. */
function installedVersion(dir: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/** Download one tarball and verify it against its sha512 pin. */
async function fetchVerifiedTarball(
  url: string,
  integrity: string,
  fetchFn: typeof fetch,
): Promise<Buffer> {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const body = Buffer.from(await res.arrayBuffer());
  const actual = `sha512-${createHash('sha512').update(body).digest('base64')}`;
  if (actual !== integrity) throw new Error('the tarball does not match its pinned sha512; the download was rejected');
  return body;
}

async function* oneBuffer(data: Buffer): AsyncGenerator<Buffer> {
  yield data;
}

/**
 * Extract every regular file of a package tarball under `dest` (its
 * `package/` prefix stripped). Understands the same ustar/pax quirks as
 * extractFile; non-file entries other than directories (symlinks, devices)
 * do not occur in npm tarballs and are skipped. The executable bit of a
 * file's tar mode survives as 0o755.
 *
 * `last` names one file (relative to `dest`, `/`-separated) that is held
 * back and written only after every other one: a reader that trusts that
 * file to mean "complete" never sees it beside a half-written package.
 */
export async function extractTree(tar: AsyncIterable<Buffer>, dest: string, options: { last?: string } = {}): Promise<void> {
  let pending: Buffer = Buffer.alloc(0);
  let inBody = false;
  let bodyLeft = 0;
  let padLeft = 0;
  let sink: 'skip' | 'file' | 'held' | 'dir' | 'pax' | 'longname' = 'skip';
  let meta: Buffer[] = [];
  let nextName: string | undefined;
  let out: fs.WriteStream | null = null;
  let outPath = '';
  let mode = 0;
  const lastPath = options.last !== undefined ? path.join(dest, ...options.last.split('/')) : undefined;
  let held: Buffer[] | undefined;

  /** Everything sits under one top-level directory, stripped as npm strips
   *  it: `package/` for what `npm pack` makes, the package's own name for
   *  some (DefinitelyTyped's `@types/*` ship under `node/`, `retry/`, …).
   *  A `..` or empty segment would write outside `dest` — refused. */
  const target = (name: string): string | null => {
    const slash = name.indexOf('/');
    const rel = slash < 0 ? '' : name.slice(slash + 1);
    if (rel.length === 0) return null;
    const parts = rel.split('/');
    if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
    return path.join(dest, ...parts);
  };

  const endBody = async (): Promise<void> => {
    inBody = false;
    if (sink === 'file' && out) {
      out.end();
      await once(out, 'finish');
      out = null;
      // A set executable bit is the only mode that matters: bin/ scripts.
      if (mode & 0o111) {
        try {
          fs.chmodSync(outPath, 0o755);
        } catch {
          /* best effort — the bit is not worth failing an install */
        }
      }
    } else if (sink === 'held') {
      held = meta;
    } else if (sink === 'dir') {
      fs.mkdirSync(outPath, { recursive: true });
    }
    if (sink === 'longname') nextName = cString(Buffer.concat(meta), 0, Infinity);
    if (sink === 'pax') nextName = paxPath(Buffer.concat(meta).toString('utf8')) ?? nextName;
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
          mode = parseInt(cString(header, 100, 8).trim() || '0', 8);
          bodyLeft = parseInt(cString(header, 124, 12).trim() || '0', 8);
          padLeft = (512 - (bodyLeft % 512)) % 512;
          meta = [];
          const file = type === '0' || type === ' ' || type === '\0';
          sink = type === 'x' ? 'pax' : type === 'L' ? 'longname' : file ? 'file' : type === '5' ? 'dir' : 'skip';
          const where = sink === 'file' || sink === 'dir' ? target(name) : null;
          if (sink === 'file' && where === null) sink = 'skip'; // not an npm path: skip, keep parsing
          if (sink === 'dir' && where === null) sink = 'skip';
          if (sink === 'file' && where === lastPath) sink = 'held';
          if (sink === 'file') {
            outPath = where!;
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            out = fs.createWriteStream(outPath);
          } else if (sink === 'dir') {
            outPath = where!;
          }
          inBody = true;
          if (bodyLeft === 0) await endBody();
          continue;
        }
        const n = Math.min(bodyLeft, pending.length - offset);
        if (n === 0) break;
        const piece = pending.subarray(offset, offset + n);
        offset += n;
        bodyLeft -= n;
        if (sink === 'file' && out && !out.write(piece)) await once(out, 'drain');
        else if (sink === 'pax' || sink === 'longname' || sink === 'held') meta.push(Buffer.from(piece));
        if (bodyLeft === 0) await endBody();
      }
      pending = pending.subarray(offset);
    }
  } finally {
    if (out && !out.writableFinished) out.destroy();
  }
  if (held && lastPath) {
    fs.mkdirSync(path.dirname(lastPath), { recursive: true });
    fs.writeFileSync(lastPath, Buffer.concat(held));
  }
}

/** How many packages the installer downloads at once. */
const TREE_CONCURRENCY = 4;

/**
 * Install one runtime's pinned dependency closure — `entries` come from a
 * generated pins module (src/generated/dshPackages.ts today; any pure-JS
 * agent CLI installed this way gets its own) — into
 * `<cacheDir>/<root with / as +>@<version>/node_modules/`, laid out as each
 * entry's `dest` says (flat at the root, nested under a consumer when the
 * closure needs two versions of one name), and return the root package's
 * directory. Destinations already present at their pinned version are
 * skipped, so an interrupted install resumes; an optional package that
 * cannot be fetched is skipped (npm's own semantics), everything else fails
 * the install.
 *
 * Each package is extracted straight into its destination with its
 * `package.json` written last, and a package counts as installed only when
 * that file names the pinned version: a package cut off mid-extraction has
 * none and is laid down again by the next install. Nothing is renamed into
 * place — see INSTALLED_MARKER for why.
 */
export async function installPackageTree(
  root: string,
  entries: readonly TreePackageEntry[],
  options: InstallOptions & { label?: string },
): Promise<string> {
  const rootEntry = entries.find((entry) => entry.name === root);
  if (!rootEntry) throw new Error(`${options.label ?? root}: ${root} is not pinned in this build, so it cannot be downloaded`);

  const label = options.label ?? root;
  const dir = path.join(options.cacheDir, `${root.replace('/', '+')}@${rootEntry.version}`);
  const target = (dest: string): string => path.join(dir, ...dest.split('/'));

  // A package whose platform gates exclude this machine: optional ones are
  // simply not for us (the wasm or other-OS variant), while a required one
  // would leave the tree unbootable — that is a pins problem to surface, not
  // a download to attempt.
  const wanted: TreePackageEntry[] = [];
  for (const entry of entries) {
    if (!packageMatchesPlatform(entry)) {
      if (!entry.optional) throw new Error(`${label}: ${entry.name}@${entry.version} is required but gated to other platforms`);
      continue;
    }
    wanted.push(entry);
  }

  // What must be laid down: every package not at its pinned version, and
  // everything nested inside one, since laying a package down replaces its
  // whole directory — its own node_modules included.
  const stale = wanted.filter((entry) => installedVersion(target(entry.dest)) !== entry.version);
  if (stale.length === 0) return target(rootEntry.dest);
  const replaced = stale.map((entry) => `${entry.dest}/`);
  const redo = new Set(wanted.filter((entry) => stale.includes(entry) || replaced.some((dest) => entry.dest.startsWith(dest))));

  // The same tarball serves every spot its package occupies (a nested
  // variant may sit under several consumers): fetch once, extract per dest.
  const byTarball = new Map<string, TreePackageEntry[]>();
  for (const entry of redo) {
    const key = `${entry.name}@${entry.version}`;
    byTarball.set(key, [...(byTarball.get(key) ?? []), entry]);
  }

  const registry = options.registry ?? DEFAULT_REGISTRY;
  const fetchFn = options.fetchFn ?? fetch;
  const started = Date.now();
  options.log(`[install] downloading ${label} (${byTarball.size} packages) from ${registry}`);
  // Phase 1: fetch every distinct tarball once, in parallel — this is the
  // network-bound part. An optional package that cannot be fetched is
  // dropped here (npm's own semantics); anything else fails the install.
  // The tarballs are kept as they came, gzipped: a whole runtime inflated
  // at once is the better part of a gigabyte held in memory, on a machine
  // that may be a small VPS.
  const tarballs = new Map<string, Buffer | null>();
  const jobs = [...byTarball.keys()];
  let next = 0;
  const download = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= jobs.length) return;
      const group = byTarball.get(jobs[index]!)!;
      const first = group[0]!;
      try {
        const url = `${registry}/${first.name}/-/${first.name.split('/').pop()}-${first.version}.tgz`;
        tarballs.set(jobs[index]!, await fetchVerifiedTarball(url, first.integrity, fetchFn));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (first.optional) {
          options.log(`[install] skipping optional ${first.name}@${first.version}: ${reason}`);
          tarballs.set(jobs[index]!, null);
          continue;
        }
        throw new Error(`${first.name} could not be installed: ${reason}`);
      }
    }
  };
  await Promise.all(Array.from({ length: TREE_CONCURRENCY }, () => download()));

  // Phase 2: lay the tarballs down serially, shallow dest first. A nested
  // entry installs inside its parent's directory, so extracting in
  // parallel would race a parent's replace against its children.
  const depth = (dest: string): number => dest.split('/').length;
  const ordered = [...redo]
    .filter((entry) => tarballs.get(`${entry.name}@${entry.version}`))
    .sort((a, b) => depth(a.dest) - depth(b.dest));
  for (const entry of ordered) {
    const tar = gunzipSync(tarballs.get(`${entry.name}@${entry.version}`)!);
    const pkgDir = target(entry.dest);
    // Retried by Node itself on the transient EBUSY / EPERM a scanner or
    // a foreign filesystem answers with.
    fs.rmSync(pkgDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    await extractTree(oneBuffer(tar), pkgDir, { last: 'package.json' });
  }

  pruneOtherVersions(options.cacheDir, `${root.replace('/', '+')}@`, path.basename(dir));
  options.log(`[install] ${label} installed at ${dir} (${((Date.now() - started) / 1000) | 0}s)`);
  return target(rootEntry.dest);
}
