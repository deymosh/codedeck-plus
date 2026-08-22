/**
 * Workspace folder management: session cwd resolution, project-folder listing,
 * and phone-initiated project creation.
 *
 * `resolveSessionCwd` and `listWorkspaceFolders` are ported from the old
 * bridge's core.ts (CDB-033 / CDB-035, battle-tested). New for v10:
 * `createProjectFolder` (the `create-folder` command) and multi-root support —
 * the host advertises `workspaceRoots[]` and every function here has a
 * multi-root variant that tries roots in order.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Resolve the working directory for a new session (ported, CDB-033).
 *
 * The phone may ask for a subdirectory, and that is untrusted input, so it is
 * confined to the workspace root: the resolved path must be the root or beneath
 * it, and must already exist as a directory. Anything else logs and falls back
 * to the root rather than failing the request — a stale bookmark on the phone
 * should not make sessions un-creatable.
 */
export function resolveSessionCwd(
  root: string,
  requested: string | undefined,
  log: (m: string) => void = () => {},
  opts: { create?: boolean } = {},
): string {
  const rootReal = path.resolve(root);
  if (!requested) return rootReal;

  const resolved = path.resolve(rootReal, requested);
  // Compare on path segments, never string prefix: `/ws/app-2` must not count as inside `/ws/app`.
  const rel = path.relative(rootReal, resolved);
  const inside = resolved === rootReal || (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel));
  if (!inside) {
    log(`[Workspace] Rejected session cwd outside the workspace: ${requested} → using ${rootReal}`);
    return rootReal;
  }
  try {
    if (!fs.statSync(resolved).isDirectory()) {
      log(`[Workspace] Session cwd is not a directory: ${resolved} → using ${rootReal}`);
      return rootReal;
    }
    return resolved;
  } catch {
    // Doesn't exist yet.
    if (!opts.create) {
      log(`[Workspace] Session cwd does not exist: ${resolved} → using ${rootReal}`);
      return rootReal;
    }
  }

  // `create` is the "start a new project from the phone" path. Without it you could only ever root
  // a session in a directory that already existed, so a new project had to be created on the laptop
  // first — which defeats the point of starting one from the phone.
  //
  // It is `git init`-ed on creation, not left bare, because GSD's own new-project runs `git init`
  // when the directory isn't a repo — and doing that HERE, in a directory we just made, is safe,
  // whereas letting GSD do it at a multi-project root is a hazard. It also means the phone's
  // Start GSD button (gated on `hasGit`) is live immediately instead of dead on arrival.
  try {
    fs.mkdirSync(resolved, { recursive: true });
    log(`[Workspace] Created session cwd: ${resolved}`);
  } catch (e) {
    log(`[Workspace] Could not create session cwd ${resolved}: ${e} → using ${rootReal}`);
    return rootReal;
  }
  gitInitQuiet(resolved, log);
  return resolved;
}

/**
 * Multi-root cwd resolution: try every workspace root in order and use the
 * first that contains `requested` as an existing directory. When nothing
 * matches and `create` is set, the folder is created under the first root that
 * contains the requested path. Falls back to the first root.
 */
export function resolveSessionCwdMulti(
  roots: readonly string[],
  requested: string | undefined,
  log: (m: string) => void = () => {},
  opts: { create?: boolean } = {},
): string {
  const first = path.resolve(roots[0] ?? process.cwd());
  if (!requested) return first;

  const containingRoots: string[] = [];
  for (const root of roots) {
    const rootReal = path.resolve(root);
    const resolved = path.resolve(rootReal, requested);
    const rel = path.relative(rootReal, resolved);
    const inside = resolved === rootReal || (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel));
    if (!inside) continue;
    containingRoots.push(rootReal);
    try {
      if (fs.statSync(resolved).isDirectory()) return resolved;
    } catch {
      // not there — keep looking
    }
  }

  if (opts.create && containingRoots.length > 0) {
    // Create under the first root the request is confined to.
    return resolveSessionCwd(containingRoots[0]!, requested, log, opts);
  }

  log(`[Workspace] Session cwd not found in any workspace root: ${requested} → using ${first}`);
  return first;
}

/** Directories that are never a project, only build/dependency noise (ported). */
const FOLDER_SCAN_SKIP = new Set([
  'node_modules', 'target', 'dist', 'build', 'out', 'venv', '__pycache__', 'vendor',
]);

/** Bounds the session-list event: a workspace with a pathological number of folders must not
 *  bloat an event the phone needs for every session update (ported). */
export const FOLDER_SCAN_LIMIT = 200;

/** Manifests that mark a directory as a project in its own right. Deliberately build-file-ish:
 *  `src/`, `docs/` and friends carry none of these, a genuine project carries at least one.
 *  `.git` is NOT here on purpose — see PROJECT_MARKERS (ported). */
const SELF_CONTAINED_MARKERS = [
  '.planning', 'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml',
  'pubspec.yaml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'Gemfile',
];

/** What makes a *nested* directory worth listing. A repo nested inside a container counts even
 *  without a build file — but being a repo says nothing about whether a folder is a container,
 *  because a monorepo of sub-projects is a repo too (ported). */
const PROJECT_MARKERS = ['.git', ...SELF_CONTAINED_MARKERS];

/**
 * List one workspace root's project folders for the phone's "Project folder"
 * picker (ported, CDB-035). Returns paths relative to `root`, so every entry is
 * directly usable as `create-session.cwd`.
 *
 * Depth: every immediate child, plus one level deeper — but a nested directory
 * is only listed when it carries a project marker of its own.
 */
export function listWorkspaceFolders(root: string, log: (m: string) => void = () => {}): string[] {
  const isProjectDir = (parent: string, entry: fs.Dirent): boolean => {
    if (entry.name.startsWith('.')) return false;          // dotfiles can't be picked anyway
    if (FOLDER_SCAN_SKIP.has(entry.name)) return false;
    if (entry.isDirectory()) return true;
    // Symlinked projects are common in a workspace; resolve them rather than dropping them.
    if (!entry.isSymbolicLink()) return false;
    try {
      return fs.statSync(path.join(parent, entry.name)).isDirectory();
    } catch {
      return false; // broken symlink
    }
  };

  const hasAny = (dir: string, markers: string[]): boolean =>
    markers.some((marker) => fs.existsSync(path.join(dir, marker)));

  try {
    const rootReal = path.resolve(root);
    const found: string[] = [];

    for (const entry of fs.readdirSync(rootReal, { withFileTypes: true })) {
      if (!isProjectDir(rootReal, entry)) continue;
      const childPath = path.join(rootReal, entry.name);
      found.push(entry.name);

      // A folder with its own build file IS the project — its subdirectories are modules of it,
      // and listing them buries the folder people actually want.
      if (hasAny(childPath, SELF_CONTAINED_MARKERS)) continue;
      try {
        for (const nested of fs.readdirSync(childPath, { withFileTypes: true })) {
          if (!isProjectDir(childPath, nested)) continue;
          if (!hasAny(path.join(childPath, nested.name), PROJECT_MARKERS)) continue;
          found.push(`${entry.name}/${nested.name}`);
        }
      } catch {
        // Unreadable child — the parent is still listed, which is the useful part.
      }
    }

    found.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    if (found.length > FOLDER_SCAN_LIMIT) {
      log(`[Workspace] Workspace has ${found.length} folders — listing the first ${FOLDER_SCAN_LIMIT}`);
      return found.slice(0, FOLDER_SCAN_LIMIT);
    }
    return found;
  } catch (e) {
    // An unreadable workspace must cost the picker its list, never a session.
    log(`[Workspace] Could not list workspace folders in ${root}: ${e}`);
    return [];
  }
}

/**
 * Union of every root's folder list (multi-root), deduplicated in root order
 * (a duplicate relative path resolves to the FIRST root — matching
 * resolveSessionCwdMulti). Capped at FOLDER_SCAN_LIMIT overall.
 */
export function listAllWorkspaceFolders(
  roots: readonly string[],
  log: (m: string) => void = () => {},
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of roots) {
    for (const folder of listWorkspaceFolders(root, log)) {
      if (seen.has(folder)) continue;
      seen.add(folder);
      out.push(folder);
      if (out.length >= FOLDER_SCAN_LIMIT) return out;
    }
  }
  return out;
}

export type CreateFolderResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

/**
 * Create a new project folder under a workspace root (v10 `create-folder`).
 *
 * `name` is untrusted phone input: it must be a relative path that resolves
 * inside the root — absolute paths and `..` escapes are refused (fail closed,
 * never fall back to a different location like resolveSessionCwd does: an
 * explicit create must never create somewhere the user didn't ask for).
 * Idempotent: an existing directory is a success. The new folder is
 * `git init`-ed (best effort) so GSD and the committed-badge work immediately.
 */
export function createProjectFolder(
  root: string,
  name: string,
  log: (m: string) => void = () => {},
): CreateFolderResult {
  const rootReal = path.resolve(root);
  const trimmed = name.trim();
  if (!trimmed) {
    return { ok: false, error: 'folder name is empty' };
  }
  if (path.isAbsolute(trimmed)) {
    return { ok: false, error: 'folder path must be relative to the workspace root' };
  }

  const resolved = path.resolve(rootReal, trimmed);
  // Segment-based containment, same trap as resolveSessionCwd: `..` escapes and
  // `/ws/app-2`-style prefix collisions must both fail.
  const rel = path.relative(rootReal, resolved);
  const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  if (!inside) {
    log(`[Workspace] Refused create-folder escaping the workspace root: ${name}`);
    return { ok: false, error: 'folder path escapes the workspace root' };
  }

  try {
    const st = fs.statSync(resolved);
    if (st.isDirectory()) {
      return { ok: true, path: rel }; // already there — idempotent success
    }
    return { ok: false, error: 'a file with that name already exists' };
  } catch {
    // doesn't exist — create it
  }

  try {
    fs.mkdirSync(resolved, { recursive: true });
    log(`[Workspace] Created project folder: ${resolved}`);
  } catch (e) {
    return { ok: false, error: `could not create folder: ${e}` };
  }
  gitInitQuiet(resolved, log);
  return { ok: true, path: rel };
}

/** `git init` a directory unless it already is a repo. Failure is tolerated —
 *  a directory without a repo is still usable (ported). */
function gitInitQuiet(dir: string, log: (m: string) => void): void {
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) {
      execFileSync('git', ['-C', dir, 'init', '--quiet'], { timeout: 10_000 });
      log(`[Workspace] git init ${dir}`);
    }
  } catch (e) {
    log(`[Workspace] git init failed in ${dir}: ${e} (continuing)`);
  }
}
