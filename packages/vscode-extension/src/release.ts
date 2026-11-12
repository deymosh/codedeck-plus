/**
 * The release this extension was built with: which bridge archive to fetch
 * for each platform and the sha256 it must have. The release workflow writes
 * it from the archives it has just built and bakes it into the bundle, so an
 * archive is trusted only if it is byte for byte the one built in the same
 * run as the extension. A build without it (a developer's) has no release
 * and runs the bridge named by `codedeck.bridgePath`.
 */

export interface ReleaseAsset {
  /** The archive's file name on the GitHub Release. */
  name: string;
  /** Its sha256, lowercase hex. */
  sha256: string;
}

export interface Release {
  /** The release tag, e.g. `v1.4.0`. */
  version: string;
  /** `owner/repo` on GitHub. */
  repository: string;
  /** Keyed by {@link platformKey}. */
  assets: Record<string, ReleaseAsset>;
}

/** The platforms a release builds a bridge for, as its archives name them. */
export const PLATFORMS = ['linux-x86_64', 'linux-aarch64', 'macos-aarch64', 'windows-x86_64'] as const;

/**
 * Which archive runs on this machine, or `undefined` when no release builds
 * one for it. Windows on Arm runs the x86_64 build under its emulation.
 */
export function platformKey(platform: string, arch: string): string | undefined {
  switch (`${platform}-${arch}`) {
    case 'linux-x64':
      return 'linux-x86_64';
    case 'linux-arm64':
      return 'linux-aarch64';
    case 'darwin-arm64':
      return 'macos-aarch64';
    case 'win32-x64':
    case 'win32-arm64':
      return 'windows-x86_64';
    default:
      return undefined;
  }
}

const VERSION = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ARCHIVE = /^[\w.+-]+\.(tar\.xz|zip)$/;

/**
 * The release manifest, checked field by field. Anything malformed is
 * `undefined`: the extension then has no release to install, rather than a
 * half-trusted one.
 */
export function parseRelease(raw: unknown): Release | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { version, repository, assets } = raw as Record<string, unknown>;
  if (typeof version !== 'string' || !VERSION.test(version)) return undefined;
  if (typeof repository !== 'string' || !REPOSITORY.test(repository)) return undefined;
  if (typeof assets !== 'object' || assets === null) return undefined;
  const parsed: Record<string, ReleaseAsset> = {};
  for (const key of PLATFORMS) {
    const asset = (assets as Record<string, unknown>)[key];
    if (typeof asset !== 'object' || asset === null) return undefined;
    const { name, sha256 } = asset as Record<string, unknown>;
    if (typeof name !== 'string' || !ARCHIVE.test(name)) return undefined;
    if (typeof sha256 !== 'string' || !SHA256.test(sha256)) return undefined;
    parsed[key] = { name, sha256 };
  }
  return { version, repository, assets: parsed };
}

/** Where the GitHub Release serves an archive. */
export function downloadUrl(release: Release, asset: ReleaseAsset): string {
  return `https://github.com/${release.repository}/releases/download/${release.version}/${asset.name}`;
}
