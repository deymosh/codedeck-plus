import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractFile, installBinary, type PackagedBinary, withoutAgentBin } from '../agentInstall';

/** One ustar header + body, padded to 512-byte blocks. */
function tarEntry(name: string, body: Buffer | string, type = '0'): Buffer {
  const data = typeof body === 'string' ? Buffer.from(body) : body;
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0);
  header.write('0000755\0', 100);
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
