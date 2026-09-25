/**
 * Finding an agent's CLI binary the same way on every OS. A driver resolves
 * its binary as explicit path → its env var → PATH → well-known install
 * directories; this module is the PATH and directory half.
 *
 * PATH is walked here rather than asking `which`, which Windows lacks. On
 * Windows only `<name>.exe` counts: the `.cmd` shims npm installs cannot be
 * spawned without a shell, and a driver spawns the path it gets directly.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** `name` as an executable file name: `name.exe` on Windows, `name` elsewhere. */
export function exeName(name: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${name}.exe` : name;
}

/** The first `exeName(name)` that exists in one of `dirs`, or null. */
export function findInDirs(
  dirs: readonly string[],
  name: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const file = exeName(name, platform);
  for (const dir of dirs) {
    const candidate = path.join(dir, file);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/** The first `exeName(name)` on `env.PATH` (`Path` on Windows), or null. */
export function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  // Windows environment names are case-insensitive, and Node keeps the
  // spelling the variable was created with (usually `Path`).
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  const value = key ? env[key] : undefined;
  if (!value) return null;
  const separator = platform === 'win32' ? ';' : ':';
  const dirs = value.split(separator).filter((d) => d.length > 0);
  return findInDirs(dirs, name, platform);
}
