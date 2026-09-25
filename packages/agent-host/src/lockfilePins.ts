/**
 * The exact version and sha512 of every platform-specific package in
 * pnpm-lock.yaml — the packages a driver may download on demand instead of
 * the release archives shipping them (see agentInstall.ts). A package is
 * platform-specific when its lockfile entry declares `os` or `cpu`; the
 * lockfile lists those for every platform, installed here or not.
 *
 * The result is checked in as src/generated/platformPackages.ts so the built
 * host carries the pins without the lockfile; a test regenerates it and
 * fails on drift.
 */

export interface PackagePin {
  version: string;
  integrity: string;
}

/** Read the pins out of a pnpm-lock.yaml (lockfile format 9). */
export function platformPackages(lockfile: string): Record<string, PackagePin> {
  const lines = lockfile.split(/\r?\n/);
  const start = lines.indexOf('packages:');
  if (start < 0) throw new Error('pnpm-lock.yaml has no packages section');

  const pins: Record<string, PackagePin> = {};
  let entry: { name: string; version: string; integrity?: string; platform: boolean } | null = null;
  const flush = (): void => {
    if (!entry?.platform || !entry.integrity) return;
    const previous = pins[entry.name];
    if (previous && previous.version !== entry.version) {
      throw new Error(`pnpm-lock.yaml holds two versions of ${entry.name} (${previous.version}, ${entry.version})`);
    }
    pins[entry.name] = { version: entry.version, integrity: entry.integrity };
  };

  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // the next top-level section
    const key = /^ {2}'?([^\s']+)'?:\s*$/.exec(line);
    if (key?.[1]) {
      flush();
      const id = key[1];
      const at = id.lastIndexOf('@');
      entry = { name: id.slice(0, at), version: id.slice(at + 1), platform: false };
      continue;
    }
    if (!entry) continue;
    const integrity = /^ {4}resolution: \{integrity: ([^\s,}]+)/.exec(line);
    if (integrity?.[1]) entry.integrity = integrity[1];
    if (/^ {4}(os|cpu): /.test(line)) entry.platform = true;
  }
  flush();
  return pins;
}

/** The generated module's source for `pins`. */
export function renderPlatformPackages(pins: Record<string, PackagePin>): string {
  const rows = Object.keys(pins)
    .sort()
    .map((name) => {
      const pin = pins[name]!;
      return `  ${JSON.stringify(name)}: { version: ${JSON.stringify(pin.version)}, integrity: ${JSON.stringify(pin.integrity)} },`;
    });
  return [
    '// Generated from pnpm-lock.yaml by src/lockfilePins.ts — do not edit.',
    "// Regenerate with this package's `gen:platform-packages` script.",
    "import type { PackagePin } from '../lockfilePins';",
    '',
    'export const PLATFORM_PACKAGES: Readonly<Record<string, PackagePin>> = {',
    ...rows,
    '};',
    '',
  ].join('\n');
}
