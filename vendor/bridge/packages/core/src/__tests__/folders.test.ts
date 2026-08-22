/**
 * workspace/folders: session cwd confinement (incl. the segment-vs-prefix
 * trap), project-folder listing, createProjectFolder validation (escape
 * rejection), and multi-root behaviour.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, existsSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createProjectFolder,
  listAllWorkspaceFolders,
  listWorkspaceFolders,
  resolveSessionCwd,
  resolveSessionCwdMulti,
} from '../workspace/folders';

describe('workspace/folders', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'codedeck-ws-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  describe('resolveSessionCwd', () => {
    it('resolves an existing subdirectory inside the root', () => {
      mkdirSync(path.join(root, 'proj'));
      expect(resolveSessionCwd(root, 'proj')).toBe(path.join(root, 'proj'));
      expect(resolveSessionCwd(root, undefined)).toBe(root);
    });

    it('rejects traversal outside the root and falls back to the root', () => {
      const logs: string[] = [];
      expect(resolveSessionCwd(root, '../../etc', (m) => logs.push(m))).toBe(root);
      expect(resolveSessionCwd(root, '/etc', (m) => logs.push(m))).toBe(root);
      expect(logs.some((l) => l.includes('outside the workspace'))).toBe(true);
    });

    it('segment comparison: a sibling with the same prefix is NOT inside', () => {
      // /ws/app vs /ws/app-2 — string-prefix logic would wrongly accept this.
      const app = path.join(root, 'app');
      mkdirSync(app);
      mkdirSync(path.join(root, 'app-2'));
      expect(resolveSessionCwd(app, '../app-2')).toBe(app);
    });

    it('a non-existent cwd without create falls back to the root', () => {
      expect(resolveSessionCwd(root, 'ghost')).toBe(root);
    });

    it('create:true makes the directory and git-inits it', () => {
      const resolved = resolveSessionCwd(root, 'newproj', () => {}, { create: true });
      expect(resolved).toBe(path.join(root, 'newproj'));
      expect(existsSync(resolved)).toBe(true);
      expect(existsSync(path.join(resolved, '.git'))).toBe(true);
    });

    // --- CDX-013: ported from the old bridge's security.test.ts ---

    it('allows the root itself via "." (ported)', () => {
      expect(resolveSessionCwd(root, '.')).toBe(root);
    });

    it('falls back to the root when the requested cwd is a FILE (ported)', () => {
      writeFileSync(path.join(root, 'notes.md'), 'hi');
      expect(resolveSessionCwd(root, 'notes.md')).toBe(root);
    });

    it('refuses to create OUTSIDE the workspace even with create enabled, and mkdirs nothing (ported)', () => {
      const escape = '../codedeck-escape-proof';
      const target = path.resolve(root, escape);
      expect(resolveSessionCwd(root, escape, () => {}, { create: true })).toBe(root);
      expect(existsSync(target)).toBe(false);
      expect(resolveSessionCwd(root, '/tmp/codedeck-abs-escape', () => {}, { create: true })).toBe(root);
      expect(existsSync('/tmp/codedeck-abs-escape')).toBe(false);
    });

    it('leaves an existing repo alone rather than re-initialising it (ported)', () => {
      const proj = path.join(root, 'existing');
      mkdirSync(proj);
      mkdirSync(path.join(proj, '.git'));
      writeFileSync(path.join(proj, '.git', 'sentinel'), 'x');
      const resolved = resolveSessionCwd(root, 'existing', () => {}, { create: true });
      expect(resolved).toBe(proj);
      expect(existsSync(path.join(proj, '.git', 'sentinel'))).toBe(true);
    });

    it('a non-existent cwd without create is NOT created on disk (ported, full assert)', () => {
      expect(resolveSessionCwd(root, 'ghost2')).toBe(root);
      expect(existsSync(path.join(root, 'ghost2'))).toBe(false);
    });
  });

  describe('listWorkspaceFolders', () => {
    it('lists children plus marker-carrying nested projects, skipping noise', () => {
      mkdirSync(path.join(root, 'proj1'));
      writeFileSync(path.join(root, 'proj1', 'package.json'), '{}');
      mkdirSync(path.join(root, 'container', 'nested', '.git'), { recursive: true });
      mkdirSync(path.join(root, 'container', 'src'), { recursive: true });
      mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
      mkdirSync(path.join(root, '.hidden'));

      expect(listWorkspaceFolders(root)).toEqual(['container', 'container/nested', 'proj1']);
    });

    it('a self-contained project does not have its modules listed', () => {
      mkdirSync(path.join(root, 'app', 'src-tauri', '.git'), { recursive: true });
      writeFileSync(path.join(root, 'app', 'package.json'), '{}');
      expect(listWorkspaceFolders(root)).toEqual(['app']);
    });

    it('follows symlinked project directories', () => {
      const real = path.join(root, 'real');
      mkdirSync(real);
      symlinkSync(real, path.join(root, 'linked'));
      expect(listWorkspaceFolders(root)).toContain('linked');
    });

    it('an unreadable root yields an empty list, never a throw', () => {
      expect(listWorkspaceFolders(path.join(root, 'does-not-exist'))).toEqual([]);
    });

    // --- CDX-013: ported from the old bridge's security.test.ts ---

    it('drops a broken/dangling symlink (ported)', () => {
      mkdirSync(path.join(root, 'good'));
      symlinkSync(path.join(root, 'gone'), path.join(root, 'dangling'));
      const listed = listWorkspaceFolders(root);
      expect(listed).toContain('good');
      expect(listed).not.toContain('dangling');
    });

    it('every listed entry resolves back to a directory inside the workspace via resolveSessionCwd (ported contract)', () => {
      mkdirSync(path.join(root, 'proj1'));
      writeFileSync(path.join(root, 'proj1', 'package.json'), '{}');
      mkdirSync(path.join(root, 'container', 'nested', '.git'), { recursive: true });
      for (const entry of listWorkspaceFolders(root)) {
        const resolved = resolveSessionCwd(root, entry);
        expect(resolved.startsWith(root)).toBe(true);
        expect(existsSync(resolved)).toBe(true);
      }
    });
  });

  describe('createProjectFolder', () => {
    it('creates a folder, git-inits it, and returns the relative path', () => {
      const res = createProjectFolder(root, 'my-app');
      expect(res).toEqual({ ok: true, path: 'my-app' });
      expect(existsSync(path.join(root, 'my-app', '.git'))).toBe(true);
    });

    it('accepts nested relative paths', () => {
      const res = createProjectFolder(root, 'group/my-app');
      expect(res).toEqual({ ok: true, path: path.join('group', 'my-app') });
      expect(existsSync(path.join(root, 'group', 'my-app'))).toBe(true);
    });

    it('refuses absolute paths and traversal escapes (fail closed, no fallback)', () => {
      expect(createProjectFolder(root, '/etc/evil').ok).toBe(false);
      expect(createProjectFolder(root, '../evil').ok).toBe(false);
      expect(createProjectFolder(root, 'a/../../evil').ok).toBe(false);
      expect(createProjectFolder(root, '').ok).toBe(false);
      expect(createProjectFolder(root, '   ').ok).toBe(false);
      // Nothing escaped the root.
      expect(existsSync(path.join(path.dirname(root), 'evil'))).toBe(false);
    });

    it('an existing directory is an idempotent success; an existing file is an error', () => {
      mkdirSync(path.join(root, 'existing'));
      expect(createProjectFolder(root, 'existing')).toEqual({ ok: true, path: 'existing' });
      writeFileSync(path.join(root, 'file.txt'), 'x');
      const res = createProjectFolder(root, 'file.txt');
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain('file');
    });
  });

  describe('multi-root', () => {
    let rootB: string;

    beforeEach(async () => {
      rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'codedeck-ws-b-'));
    });

    afterEach(async () => {
      await fs.rm(rootB, { recursive: true, force: true });
    });

    it('resolveSessionCwdMulti finds a directory in a later root', () => {
      mkdirSync(path.join(rootB, 'only-in-b'));
      expect(resolveSessionCwdMulti([root, rootB], 'only-in-b')).toBe(path.join(rootB, 'only-in-b'));
    });

    it('a duplicate name resolves to the FIRST root (matches the folder list dedup)', () => {
      mkdirSync(path.join(root, 'dup'));
      mkdirSync(path.join(rootB, 'dup'));
      expect(resolveSessionCwdMulti([root, rootB], 'dup')).toBe(path.join(root, 'dup'));
    });

    it('falls back to the first root for unknown/escaping requests', () => {
      expect(resolveSessionCwdMulti([root, rootB], 'ghost')).toBe(root);
      expect(resolveSessionCwdMulti([root, rootB], '../../etc')).toBe(root);
      expect(resolveSessionCwdMulti([root, rootB], undefined)).toBe(root);
    });

    it('create:true creates under the first containing root', () => {
      const resolved = resolveSessionCwdMulti([root, rootB], 'fresh', () => {}, { create: true });
      expect(resolved).toBe(path.join(root, 'fresh'));
      expect(existsSync(resolved)).toBe(true);
    });

    // CDX-031: the heartbeat now advertises the roots themselves (absolute),
    // because `folders` lists what is INSIDE them and can never name one. That
    // only works if an absolute root round-trips back through cwd resolution.
    it('an ABSOLUTE root path resolves to that exact root — how the phone reaches root 2..N', () => {
      expect(resolveSessionCwdMulti([root, rootB], rootB)).toBe(rootB);
      expect(resolveSessionCwdMulti([root, rootB], root)).toBe(root);
    });

    it('an absolute path outside every root still falls back — no new escape', () => {
      // Containment is checked per root on path segments, so an absolute
      // request is confined exactly like a relative one.
      const outside = path.join(os.tmpdir(), 'codedeck-not-a-root-at-all');
      mkdirSync(outside, { recursive: true });
      try {
        expect(resolveSessionCwdMulti([root, rootB], outside)).toBe(root);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('listAllWorkspaceFolders lists what is INSIDE the roots, never a root itself', () => {
      // The CDX-031 defect in one assertion: two flat project roots passed
      // straight to --workspace advertise NOTHING, which is why the device's
      // picker showed only "Default" + "New folder…".
      expect(listAllWorkspaceFolders([root, rootB])).toEqual([]);
      expect(listAllWorkspaceFolders([root, rootB])).not.toContain(path.basename(rootB));
    });

    it('listAllWorkspaceFolders unions roots and dedupes in root order', () => {
      mkdirSync(path.join(root, 'shared'));
      mkdirSync(path.join(root, 'a-only'));
      mkdirSync(path.join(rootB, 'shared'));
      mkdirSync(path.join(rootB, 'b-only'));
      expect(listAllWorkspaceFolders([root, rootB])).toEqual(['a-only', 'shared', 'b-only']);
    });
  });
});
