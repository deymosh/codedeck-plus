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
  installPackageTree,
  renameIntoPlace,
  type PackagedBinary,
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

describe('renameIntoPlace', () => {
  it('retries a rename a filesystem refuses for a moment, and then takes it', async () => {
    const codes: Array<string | undefined> = ['EACCES', 'EPERM', 'EBUSY', undefined];
    let calls = 0;
    const rename = (): void => {
      const code = codes[calls++];
      if (code !== undefined) throw Object.assign(new Error(`${code}: permission denied`), { code });
    };
    const logs: string[] = [];
    await renameIntoPlace('/staging/a', '/tree/a', { rename, log: (line) => logs.push(line) });
    expect(calls).toBe(4);
    // Said once, so a slow install on such a filesystem is explicable.
    expect(logs).toEqual(['[install] /tree/a was busy (EPERM); retrying']);
  });

  it('fails at once for a rename that is a real error', async () => {
    const failing = (): void => {
      throw Object.assign(new Error('ENOTEMPTY: directory not empty'), { code: 'ENOTEMPTY' });
    };
    await expect(renameIntoPlace('/a', '/b', { rename: failing })).rejects.toThrow(/ENOTEMPTY/);
  });

  it('gives up after enough attempts on one that never takes', async () => {
    let attempts = 0;
    const never = (): void => {
      attempts++;
      throw Object.assign(new Error('EACCES: still busy'), { code: 'EACCES' });
    };
    await expect(renameIntoPlace('/a', '/b', { rename: never })).rejects.toThrow(/still busy/);
    expect(attempts).toBe(8);
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
