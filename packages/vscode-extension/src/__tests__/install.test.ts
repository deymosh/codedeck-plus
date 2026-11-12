import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { binaryName, ensureBridge } from '../install.js';

/**
 * A release archive laid out as the release workflow lays it out (a top
 * directory named after the archive, the binary inside), in this platform's
 * format, made with the same system tar the installer unpacks with.
 */
function makeArchive(dir: string, version: string): { name: string; bytes: Buffer } {
  const windows = process.platform === 'win32';
  const root = `codedeck-bridge-${version}-test`;
  const name = `${root}.${windows ? 'zip' : 'tar.xz'}`;
  mkdirSync(path.join(dir, root, 'agent-host', 'dist'), { recursive: true });
  writeFileSync(path.join(dir, root, binaryName(process.platform)), `bridge ${version}`);
  writeFileSync(path.join(dir, root, 'agent-host', 'dist', 'main.js'), '');
  const tar = windows ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const args = windows ? ['-a', '-cf', name, root] : ['-cJf', name, root];
  const made = spawnSync(tar, args, { cwd: dir });
  if (made.status !== 0) throw new Error(`tar failed: ${made.stderr}`);
  return { name, bytes: readFileSync(path.join(dir, name)) };
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

describe('ensureBridge', () => {
  let work: string;
  let server: Server;
  let base: string;
  const served = new Map<string, Buffer>();
  const hits: string[] = [];

  beforeAll(async () => {
    work = mkdtempSync(path.join(os.tmpdir(), 'codedeck-install-'));
    server = createServer((req, res) => {
      const body = served.get(req.url ?? '');
      hits.push(req.url ?? '');
      if (!body) return void res.writeHead(404).end();
      res.writeHead(200, { 'content-length': body.length }).end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
    rmSync(work, { recursive: true, force: true });
  });

  function release(version: string): { url: string; asset: { name: string; sha256: string }; bytes: Buffer } {
    const dir = path.join(work, `src-${version}`);
    mkdirSync(dir, { recursive: true });
    const { name, bytes } = makeArchive(dir, version);
    served.set(`/${version}/${name}`, bytes);
    return { url: `${base}/${version}/${name}`, asset: { name, sha256: sha256(bytes) }, bytes };
  }

  it('installs a verified archive once, and drops the previous release', async () => {
    const storage = path.join(work, 'storage-ok');
    const old = release('v1.0.0');
    const progress: number[] = [];
    const first = await ensureBridge({ ...old, version: 'v1.0.0', storage, onProgress: (n) => progress.push(n) });
    expect(readFileSync(first, 'utf8')).toBe('bridge v1.0.0');
    expect(existsSync(path.join(path.dirname(first), 'agent-host', 'dist', 'main.js'))).toBe(true);
    expect(progress.at(-1)).toBe(old.bytes.length);

    const before = hits.length;
    expect(await ensureBridge({ ...old, version: 'v1.0.0', storage })).toBe(first);
    expect(hits.length, 'an installed release is not downloaded again').toBe(before);

    const next = release('v1.1.0');
    const second = await ensureBridge({ ...next, version: 'v1.1.0', storage });
    expect(readFileSync(second, 'utf8')).toBe('bridge v1.1.0');
    expect(readdirSync(path.join(storage, 'bridge'))).toEqual(['v1.1.0']);
  });

  it('refuses an archive whose sha256 differs, and installs nothing', async () => {
    const storage = path.join(work, 'storage-tampered');
    const { url, asset } = release('v2.0.0');
    const wrong = { ...asset, sha256: sha256(Buffer.from('something else')) };
    await expect(ensureBridge({ url, asset: wrong, version: 'v2.0.0', storage })).rejects.toThrow(/does not match this release/);
    expect(readdirSync(path.join(storage, 'bridge')), 'no download or unpacked tree is left behind').toEqual([]);
  });

  it('reports a failed download', async () => {
    const storage = path.join(work, 'storage-404');
    const asset = { name: 'codedeck-bridge-v3.0.0-test.zip', sha256: '0'.repeat(64) };
    await expect(ensureBridge({ url: `${base}/missing`, asset, version: 'v3.0.0', storage })).rejects.toThrow(/HTTP 404/);
    expect(readdirSync(path.join(storage, 'bridge'))).toEqual([]);
  });
});
