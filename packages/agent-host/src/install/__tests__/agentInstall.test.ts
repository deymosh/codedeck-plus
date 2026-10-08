import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractFile,
  extractTree,
  installBinary,
  installedBinary,
  installedPackageTree,
  installPackageTree,
  type PackagedBinary,
  removeBinary,
  removePackageTree,
  withoutAgentBin,
} from '../agentInstall';
import type { TreePackageEntry } from '../lockfilePins';

/** One ustar header + body, padded to 512-byte blocks. */
function tarEntry(name: string, body: Buffer | string, type = '0', mode = 0o755): Buffer {
  const data = typeof body === 'string' ? Buffer.from(body) : body;
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0);
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write(type, 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  header.fill(' ', 148, 156);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, pad]);
}

function paxEntry(longName: string): Buffer {
  const record = (len: number): string => `${len} path=${longName}\n`;
  let len = record(0).length;
  while (record(len).length !== len) len = record(len).length;
  return tarEntry('PaxHeader', record(len), 'x');
}

const tarball = (...entries: Buffer[]): Buffer => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
const sha512 = (data: Buffer): string => `sha512-${createHash('sha512').update(data).digest('base64')}`;

async function* chunks(data: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size);
}

describe('extractFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes the wanted entry, skipping others, whatever the chunking', async () => {
    const big = Buffer.alloc(70_001, 7);
    const tar = Buffer.concat([
      tarEntry('package/README.md', 'readme'),
      tarEntry('package/bin/tool', big),
      tarEntry('package/LICENSE', 'mit'),
      Buffer.alloc(1024),
    ]);
    for (const size of [1, 511, 512, 4096, tar.length]) {
      const dest = path.join(dir, `tool-${size}`);
      expect(await extractFile(chunks(tar, size), 'package/bin/tool', dest)).toBe(true);
      expect(fs.readFileSync(dest).equals(big)).toBe(true);
    }
  });

  it('follows a pax long name', async () => {
    const long = `package/${'d/'.repeat(60)}tool`;
    const tar = Buffer.concat([paxEntry(long), tarEntry('package/truncated', 'x'.repeat(10)), Buffer.alloc(1024)]);
    const dest = path.join(dir, 'tool');
    expect(await extractFile(chunks(tar, 300), long, dest)).toBe(true);
    expect(fs.readFileSync(dest, 'utf8')).toBe('x'.repeat(10));
  });

  it('reports a missing entry', async () => {
    const tar = Buffer.concat([tarEntry('package/other', 'x'), Buffer.alloc(1024)]);
    expect(await extractFile(chunks(tar, 512), 'package/tool', path.join(dir, 'tool'))).toBe(false);
  });
});

describe('installBinary', () => {
  let cache: string;
  const binary: PackagedBinary = { pkg: '@scope/tool-linux-x64', file: 'bin/tool', label: 'Tool' };
  const payload = Buffer.from('#!/bin/sh\necho tool\n');
  const tgz = tarball(tarEntry('package/package.json', '{}'), tarEntry('package/bin/tool', payload));
  const pins = { '@scope/tool-linux-x64': { version: '2.0.0', integrity: sha512(tgz) } };
  const log = (): void => {};

  beforeEach(() => {
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'install-'));
  });
  afterEach(() => fs.rmSync(cache, { recursive: true, force: true }));

  it('downloads the pinned version once, then serves it from the cache', async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request) => new Response(tgz));
    const options = { cacheDir: cache, registry: 'https://registry.test', pins, log, fetchFn: fetchFn as unknown as typeof fetch };

    const first = await installBinary(binary, options);
    expect(first).toBe(path.join(cache, '@scope+tool-linux-x64@2.0.0', 'bin', 'tool'));
    expect(fs.readFileSync(first).equals(payload)).toBe(true);
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe('https://registry.test/@scope/tool-linux-x64/-/tool-linux-x64-2.0.0.tgz');

    expect(await installBinary(binary, options)).toBe(first);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(path.dirname(first))).toEqual(['tool']); // no temporary files left
  });

  it('rejects a download that does not match its pin', async () => {
    const tampered = tarball(tarEntry('package/bin/tool', 'evil'));
    const fetchFn = (async () => new Response(tampered)) as unknown as typeof fetch;
    await expect(installBinary(binary, { cacheDir: cache, pins, log, fetchFn })).rejects.toThrow(/does not match its pinned sha512/);
    expect(fs.readdirSync(path.join(cache, '@scope+tool-linux-x64@2.0.0'), { recursive: true })).toEqual(['bin']);
  });

  it('installs again over a binary an interrupted install left without its marker', async () => {
    const target = path.join(cache, '@scope+tool-linux-x64@2.0.0', 'bin', 'tool');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'truncated');
    const fetchFn = vi.fn(async () => new Response(tgz));
    const options = { cacheDir: cache, pins, log, fetchFn: fetchFn as unknown as typeof fetch };
    expect(await installBinary(binary, options)).toBe(target);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(target).equals(payload)).toBe(true);
    // A marker for another pin (the same version republished) does not count either.
    fs.writeFileSync(path.join(cache, '@scope+tool-linux-x64@2.0.0', '.installed'), 'sha512-other');
    await installBinary(binary, options);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('refuses a package this build does not pin', async () => {
    await expect(installBinary({ ...binary, pkg: 'unpinned' }, { cacheDir: cache, pins, log })).rejects.toThrow(/not pinned/);
  });

  it('removes other versions of the package once the new one is in', async () => {
    const old = path.join(cache, '@scope+tool-linux-x64@1.0.0');
    const unrelated = path.join(cache, '@scope+other@1.0.0');
    fs.mkdirSync(old);
    fs.mkdirSync(unrelated);
    const fetchFn = (async () => new Response(tgz)) as unknown as typeof fetch;
    await installBinary(binary, { cacheDir: cache, pins, log, fetchFn });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it('reports an HTTP failure', async () => {
    const fetchFn = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    await expect(installBinary(binary, { cacheDir: cache, pins, log, fetchFn })).rejects.toThrow(/Tool could not be installed: HTTP 404/);
  });

  it('is found installed without a download, and removed with every version and its link', async () => {
    expect(installedBinary(binary, { cacheDir: cache, pins })).toBeNull();
    const fetchFn = (async () => new Response(tgz)) as unknown as typeof fetch;
    const target = await installBinary(binary, { cacheDir: cache, pins, log, fetchFn });
    expect(installedBinary(binary, { cacheDir: cache, pins })).toBe(target);
    expect(installedBinary(binary, { cacheDir: cache, pins: {} })).toBeNull();

    fs.mkdirSync(path.join(cache, '@scope+tool-linux-x64@1.0.0'));
    fs.mkdirSync(path.join(cache, '@scope+other@1.0.0'));
    removeBinary(binary, cache);
    expect(fs.readdirSync(cache).filter((n) => n !== 'bin')).toEqual(['@scope+other@1.0.0']);
    if (process.platform !== 'win32') expect(fs.readdirSync(path.join(cache, 'bin'))).toEqual([]);
    expect(installedBinary(binary, { cacheDir: cache, pins })).toBeNull();
  });
});

// Symlinks need a privilege on Windows, so the installer does not make them there.
describe.skipIf(process.platform === 'win32')('the stable links in <cache>/bin', () => {
  let cache: string;
  const log = (): void => {};
  const binary: PackagedBinary = { pkg: 'tool-linux-x64', file: 'bin/tool', label: 'Tool' };
  const build = (text: string) => tarball(tarEntry('package/bin/tool', text));

  beforeEach(() => {
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'links-'));
  });
  afterEach(() => fs.rmSync(cache, { recursive: true, force: true }));

  it('points at the installed version, follows a moved pin, and is restored when missing', async () => {
    const v1 = build('one');
    const v2 = build('two');
    const fetchOf = (tgz: Buffer) => (async () => new Response(tgz)) as unknown as typeof fetch;
    const link = path.join(cache, 'bin', 'tool');

    await installBinary(binary, { cacheDir: cache, log, fetchFn: fetchOf(v1), pins: { 'tool-linux-x64': { version: '1.0.0', integrity: sha512(v1) } } });
    expect(fs.readFileSync(link, 'utf8')).toBe('one');

    const pins2 = { 'tool-linux-x64': { version: '2.0.0', integrity: sha512(v2) } };
    await installBinary(binary, { cacheDir: cache, log, fetchFn: fetchOf(v2), pins: pins2 });
    expect(fs.readFileSync(link, 'utf8')).toBe('two');
    expect(fs.readlinkSync(link)).toBe(path.join('..', 'tool-linux-x64@2.0.0', 'bin', 'tool'));

    fs.rmSync(link);
    await installBinary(binary, { cacheDir: cache, log, pins: pins2 }); // a cache hit: no fetch
    expect(fs.readFileSync(link, 'utf8')).toBe('two');
  });
});

describe('extractTree', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-tree-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes every file under dest, stripping the package/ prefix, whatever the chunking', async () => {
    const tar = Buffer.concat([
      tarEntry('package/', '', '5'),
      tarEntry('package/package.json', '{"version":"1.0.0"}', '0', 0o644),
      tarEntry('package/lib/', '', '5'),
      tarEntry('package/lib/bin.js', 'console.log(1)'),
      tarEntry('package/LICENSE', 'mit', '0', 0o644),
      Buffer.alloc(1024),
    ]);
    for (const size of [1, 300, 512, 4096, tar.length]) {
      const dest = path.join(dir, `tree-${size}`);
      await extractTree(chunks(tar, size), dest);
      expect(fs.readFileSync(path.join(dest, 'package.json'), 'utf8')).toBe('{"version":"1.0.0"}');
      expect(fs.readFileSync(path.join(dest, 'lib', 'bin.js'), 'utf8')).toBe('console.log(1)');
      expect(fs.readFileSync(path.join(dest, 'LICENSE'), 'utf8')).toBe('mit');
    }
  });

  it('writes the file named last after every other one', async () => {
    const tar = Buffer.concat([
      tarEntry('package/package.json', '{"version":"1.0.0"}', '0', 0o644),
      tarEntry('package/lib/bin.js', 'console.log(1)'),
      Buffer.alloc(1024),
    ]);
    // Every block of the archive has been read, the other file written —
    // and still no package.json.
    let seenBeforeEnd: boolean | undefined;
    async function* watched(): AsyncGenerator<Buffer> {
      yield* chunks(tar.subarray(0, tar.length - 1024), 512);
      seenBeforeEnd = fs.existsSync(path.join(dir, 'package.json'));
      yield tar.subarray(tar.length - 1024);
    }
    await extractTree(watched(), dir, { last: 'package.json' });
    expect(seenBeforeEnd).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).toBe('{"version":"1.0.0"}');
    expect(fs.readFileSync(path.join(dir, 'lib', 'bin.js'), 'utf8')).toBe('console.log(1)');
  });

  it('strips whatever top-level directory the package ships under, as npm does', async () => {
    // DefinitelyTyped's packages are packed under their own name, not package/.
    const tar = Buffer.concat([
      tarEntry('node/package.json', '{"version":"22.0.0"}', '0', 0o644),
      tarEntry('node/fs.d.ts', 'declare module "fs";', '0', 0o644),
      Buffer.alloc(1024),
    ]);
    await extractTree(chunks(tar, 512), dir, { last: 'package.json' });
    expect(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).toBe('{"version":"22.0.0"}');
    expect(fs.readFileSync(path.join(dir, 'fs.d.ts'), 'utf8')).toBe('declare module "fs";');
  });

  it('skips an entry that would leave the package, and keeps going', async () => {
    const tar = Buffer.concat([
      tarEntry('package/../evil', 'no'),
      tarEntry('package/ok', 'yes'),
      Buffer.alloc(1024),
    ]);
    await extractTree(chunks(tar, 512), dir);
    expect(fs.existsSync(path.join(dir, 'evil'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'ok'), 'utf8')).toBe('yes');
  });

  it('keeps a file executable only when its tar mode is', async () => {
    const tar = Buffer.concat([
      tarEntry('package/run.sh', '#!/bin/sh\n', '0', 0o755),
      tarEntry('package/plain.txt', 'x', '0', 0o644),
      Buffer.alloc(1024),
    ]);
    await extractTree(chunks(tar, 512), dir);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(dir, 'run.sh')).mode & 0o111).not.toBe(0);
      expect(fs.statSync(path.join(dir, 'plain.txt')).mode & 0o111).toBe(0);
    }
  });

  it('follows a pax long name', async () => {
    const long = `package/${'d/'.repeat(60)}tool`;
    const tar = Buffer.concat([paxEntry(long), tarEntry('package/truncated', 'x'.repeat(10)), Buffer.alloc(1024)]);
    await extractTree(chunks(tar, 300), dir);
    expect(fs.readFileSync(path.join(dir, ...long.slice('package/'.length).split('/')), 'utf8')).toBe('x'.repeat(10));
  });
});

describe('installPackageTree', () => {
  let cache: string;
  const log = vi.fn();

  /** A minimal npm package tarball: package.json + lib/bin.js for the root. */
  const packageTarball = (name: string, version: string): Buffer =>
    tarball(
      tarEntry('package/package.json', JSON.stringify({ name, version }), '0', 0o644),
      ...(name === '@deepseek-ai/dsh' ? [tarEntry('package/lib/bin.js', 'bin!')] : [tarEntry('package/index.js', 'ok', '0', 0o644)]),
    );

  const tgzOf = new Map<string, Buffer>([
    ['@deepseek-ai/dsh', packageTarball('@deepseek-ai/dsh', '1.0.0')],
    ['commander', packageTarball('commander', '15.0.0')],
    ['shared-old', packageTarball('shared-old', '0.6.4')],
  ]);
  const entries: TreePackageEntry[] = [
    { name: '@deepseek-ai/dsh', version: '1.0.0', integrity: sha512(tgzOf.get('@deepseek-ai/dsh')!), dest: 'node_modules/@deepseek-ai/dsh' },
    { name: 'commander', version: '15.0.0', integrity: sha512(tgzOf.get('commander')!), dest: 'node_modules/commander' },
    // A second version of a name, nested under its consumer like pnpm laid it out.
    { name: 'shared-old', version: '0.6.4', integrity: sha512(tgzOf.get('shared-old')!), dest: 'node_modules/commander/node_modules/shared-old' },
    { name: 'sunos-only', version: '1.0.0', integrity: 'sha512-whatever', dest: 'node_modules/sunos-only', optional: true, os: ['sunos'] },
  ];
  const registryOf = (bodies: Map<string, Buffer | number>) =>
    vi.fn(async (url: string | URL | Request) => {
      const name = [...bodies.keys()].find((n) => String(url).includes(`/${n}/-`));
      const body = name !== undefined ? bodies.get(name) : undefined;
      if (typeof body === 'number') return new Response('nope', { status: body });
      return body !== undefined ? new Response(body) : new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;

  beforeEach(() => {
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'install-tree-'));
    log.mockClear();
  });
  afterEach(() => fs.rmSync(cache, { recursive: true, force: true }));

  it('lays every entry out at its dest, serving a repeat call from the cache', async () => {
    const fetchFn = registryOf(tgzOf);
    const root = await installPackageTree('@deepseek-ai/dsh', entries, { cacheDir: cache, registry: 'https://registry.test', log, fetchFn, label: 'DSH' });
    expect(root).toBe(path.join(cache, '@deepseek-ai+dsh@1.0.0', 'node_modules', '@deepseek-ai', 'dsh'));
    expect(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))).toEqual({ name: '@deepseek-ai/dsh', version: '1.0.0' });
    expect(fs.readFileSync(path.join(root, 'lib', 'bin.js'), 'utf8')).toBe('bin!');
    expect(fs.readFileSync(path.join(root, '..', '..', 'commander', 'index.js'), 'utf8')).toBe('ok');
    expect(
      JSON.parse(fs.readFileSync(path.join(root, '..', '..', 'commander', 'node_modules', 'shared-old', 'package.json'), 'utf8')).version,
    ).toBe('0.6.4');
    // The sunos-only optional is gated away on any machine CI runs; it must
    // be neither fetched nor laid down.
    expect(fs.existsSync(path.join(cache, '@deepseek-ai+dsh@1.0.0', 'node_modules', 'sunos-only'))).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(3);

    await installPackageTree('@deepseek-ai/dsh', entries, { cacheDir: cache, log, fetchFn, label: 'DSH' });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(fs.readdirSync(path.join(cache, '@deepseek-ai+dsh@1.0.0'))).toEqual(['node_modules']); // no staging left
  });

  it('replaces a package left at the wrong version', async () => {
    const stale = path.join(cache, '@deepseek-ai+dsh@1.0.0', 'node_modules', 'commander');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'package.json'), '{"version":"14.0.0"}');
    const fetchFn = registryOf(tgzOf);
    await installPackageTree('@deepseek-ai/dsh', entries, { cacheDir: cache, log, fetchFn, label: 'DSH' });
    expect(JSON.parse(fs.readFileSync(path.join(stale, 'package.json'), 'utf8')).version).toBe('15.0.0');
  });

  it('lays down again a package an interrupted install left without its package.json', async () => {
    const fetchFn = registryOf(tgzOf);
    await installPackageTree('@deepseek-ai/dsh', entries, { cacheDir: cache, log, fetchFn, label: 'DSH' });
    const commander = path.join(cache, '@deepseek-ai+dsh@1.0.0', 'node_modules', 'commander');
    fs.rmSync(path.join(commander, 'package.json'));
    fs.rmSync(path.join(commander, 'index.js'));
    await installPackageTree('@deepseek-ai/dsh', entries, { cacheDir: cache, log, fetchFn, label: 'DSH' });
    expect(fs.readFileSync(path.join(commander, 'index.js'), 'utf8')).toBe('ok');
    expect(JSON.parse(fs.readFileSync(path.join(commander, 'package.json'), 'utf8')).version).toBe('15.0.0');
  });

  it('puts back what was nested inside a package it lays down again', async () => {
    const fetchFn = registryOf(tgzOf);
    await installPackageTree('@deepseek-ai/dsh', entries, { cacheDir: cache, log, fetchFn, label: 'DSH' });
    const commander = path.join(cache, '@deepseek-ai+dsh@1.0.0', 'node_modules', 'commander');
    fs.writeFileSync(path.join(commander, 'package.json'), '{"version":"14.0.0"}');
    await installPackageTree('@deepseek-ai/dsh', entries, { cacheDir: cache, log, fetchFn, label: 'DSH' });
    // shared-old was at its version, but lived inside commander's directory.
    expect(JSON.parse(fs.readFileSync(path.join(commander, 'node_modules', 'shared-old', 'package.json'), 'utf8')).version).toBe('0.6.4');
  });

  it('skips an optional package the registry will not serve', async () => {
    const withOptional = [
      ...entries.slice(0, 3),
      { name: 'maybe-here', version: '1.0.0', integrity: 'sha512-x', dest: 'node_modules/maybe-here', optional: true } as TreePackageEntry,
    ];
    await installPackageTree('@deepseek-ai/dsh', withOptional, { cacheDir: cache, log, fetchFn: registryOf(tgzOf), label: 'DSH' });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/skipping optional maybe-here@1.0.0/));
    expect(fs.existsSync(path.join(cache, '@deepseek-ai+dsh@1.0.0', 'node_modules', 'maybe-here'))).toBe(false);
  });

  it('fails the install when a required tarball does not match its pin', async () => {
    const tampered = new Map([['@deepseek-ai/dsh', packageTarball('@deepseek-ai/dsh', '9.9.9')], ['commander', tgzOf.get('commander')!], ['shared-old', tgzOf.get('shared-old')!]]);
    await expect(
      installPackageTree('@deepseek-ai/dsh', entries, { cacheDir: cache, log, fetchFn: registryOf(tampered), label: 'DSH' }),
    ).rejects.toThrow(/@deepseek-ai\/dsh could not be installed: the tarball does not match its pinned sha512/);
  });

  it('refuses a root this build does not pin', async () => {
    await expect(installPackageTree('unpinned', entries, { cacheDir: cache, log })).rejects.toThrow(/unpinned is not pinned/);
  });

  it('is found installed only when complete, and removed', async () => {
    expect(installedPackageTree('@deepseek-ai/dsh', entries, cache)).toBeNull();
    const root = await installPackageTree('@deepseek-ai/dsh', entries, { cacheDir: cache, log, fetchFn: registryOf(tgzOf), label: 'DSH' });
    expect(installedPackageTree('@deepseek-ai/dsh', entries, cache)).toBe(root);
    expect(installedPackageTree('unpinned', entries, cache)).toBeNull();

    // A package cut off mid-install has no package.json: not installed.
    fs.rmSync(path.join(cache, '@deepseek-ai+dsh@1.0.0', 'node_modules', 'commander', 'package.json'));
    expect(installedPackageTree('@deepseek-ai/dsh', entries, cache)).toBeNull();

    fs.mkdirSync(path.join(cache, 'opencode-linux-x64@1.0.0'));
    removePackageTree('@deepseek-ai/dsh', cache);
    expect(fs.readdirSync(cache)).toEqual(['opencode-linux-x64@1.0.0']);
  });

  it('prunes older versions of the tree once the new one is in', async () => {
    const old = path.join(cache, '@deepseek-ai+dsh@0.9.0');
    const unrelated = path.join(cache, 'opencode-linux-x64@1.0.0');
    fs.mkdirSync(old);
    fs.mkdirSync(unrelated);
    await installPackageTree('@deepseek-ai/dsh', entries, { cacheDir: cache, log, fetchFn: registryOf(tgzOf), label: 'DSH' });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(unrelated)).toBe(true);
  });
});

describe('withoutAgentBin', () => {
  it("drops only <cache>/bin from PATH, keeping the variable's own name", () => {
    const cache = path.resolve('/srv/agents');
    const other = path.resolve('/usr/bin');
    const env = { Path: [other, path.join(cache, 'bin'), `${path.join(cache, 'bin')}${path.sep}`].join(path.delimiter), HOME: '/h' };
    expect(withoutAgentBin(env, cache)).toEqual({ Path: other, HOME: '/h' });
    expect(withoutAgentBin({ HOME: '/h' }, cache)).toEqual({ HOME: '/h' });
  });
});

describe.skipIf(process.platform === 'win32')('withoutAgentBin through a symlinked home', () => {
  it('drops <cache>/bin when PATH names it by its real location', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
    try {
      const data = path.join(root, 'data');
      fs.mkdirSync(path.join(data, 'agents', 'bin'), { recursive: true });
      fs.symlinkSync(data, path.join(root, '.codedeck'));
      const env = { PATH: `/usr/bin:${path.join(data, 'agents', 'bin')}` };
      expect(withoutAgentBin(env, path.join(root, '.codedeck', 'agents')).PATH).toBe('/usr/bin');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
