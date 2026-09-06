---
name: cut-release
description: Cut a CodeDeck+ release — a single vMAJOR.MINOR.PATCH tag that publishes one GitHub Release with the signed APK, the bridge npm tarball, and the bridge container image. Use when asked to cut, tag, or ship a release.
---

# Cutting a CodeDeck+ release

One annotated `vX.Y.Z` tag drives everything. `.github/workflows/release.yml`
does the building; this runbook is the human side. `X.Y.Z` is a placeholder for
the version actually being cut.

## One-time repository setup (before the first real release)

The APK signing step needs four repository **secrets** (same names the
maintainer uses elsewhere):

| Secret | Value |
|---|---|
| `SIGNING_KEY` | base64 of the release keystore (`base64 -w0 release.keystore`) |
| `KEY_ALIAS` | key alias inside that keystore |
| `KEY_STORE_PASSWORD` | keystore password |
| `KEY_PASSWORD` | key password |

Optional, to bundle the nostr-vpn mesh engine into the APK (otherwise the app
ships without mesh, exactly like a local build with no checkout):

| Name | Value |
|---|---|
| `vars.NVPN_REPO` | `owner/repo` of the nostr-vpn source |
| `secrets.NVPN_REPO_TOKEN` | a PAT that can read it |

The bridge image publishes to `ghcr.io/<owner>/codedeck-plus-bridge` using the
built-in `GITHUB_TOKEN` — no extra secret, but the first push may need
Packages write enabled for Actions in repo settings.

## Steps

1. **Land everything on `master` first.** The release workflow builds from the
   tagged commit; `ci.yml` does not run on tags, so `master` must already be
   green. Merge the open PRs that belong in this version.

2. **Bump the version in the tree — in a commit, before tagging.** One number
   for the whole monorepo (unified versioning: every artifact of release N is
   version N, even a component unchanged since N-1 — the version is a
   compatibility snapshot, not a per-component changelog; wire compatibility is
   `protocolVersion`, tracked separately). Set `X.Y.Z` in:
   - `package.json` (root), every `apps/*/package.json` and `packages/*/package.json`
   - `apps/mobile/src-tauri/tauri.conf.json` `version`
   - `apps/mobile/src-tauri/Cargo.toml` `version` + the `codedeck-mobile` entry
     in `Cargo.lock` (one line; CI's `cargo test --locked` fails if they disagree)

   The Android `versionCode` is **derived** from `version`
   (`major·1_000_000 + minor·1_000 + patch`), so bumping `version` is enough — do
   not pin `bundle.android.versionCode` in `tauri.conf.json` (a pin turns the
   monotonic-integer guarantee into manual bookkeeping).

   Land this bump on `master` (a small dedicated PR is fine) so the repo always
   states its own current version. `release.yml` re-stamps the same number at
   build time with `--allow-same-version`, so the CI stamp is a **no-op safety
   net** — it only does real work for a `workflow_dispatch` run given an
   arbitrary version input, never the mechanism a real tag relies on.

   Semver. A pre-release gets a hyphen suffix (`v1.2.0-rc1`) — published as a
   GitHub *prerelease*, and `:latest` does not move.

3. **Verify locally** (see the `verify-changes` skill):

   ```
   ./codedeck check
   ```

4. **Create an annotated tag on the release commit:**

   ```
   git tag -a vX.Y.Z -m "<one-line summary>"
   git cat-file -t vX.Y.Z      # must print: tag
   ```

   Lightweight tags are rejected by convention here — release tooling expects a
   real tag object with a tagger and date.

5. **STOP. Get the user's explicit go-ahead before pushing the tag.** Pushing it
   triggers a public GitHub Release.

6. **Push the tag:**

   ```
   git push origin vX.Y.Z
   ```

7. **Watch the run:** `gh run watch` (or `gh run list --workflow=release.yml`).
   Jobs: `meta` → (`bridge-npm`, `bridge-image`, `android-apk` in parallel) →
   `release`. The `release` job creates the GitHub Release with
   `generate_release_notes: true`, so the changelog is the merged-PR list since
   the previous tag — another reason to land work as PRs, not direct pushes.

8. **Confirm the release** has all three artifacts, each on the `vX.Y.Z`
   convention: `codedeck-vX.Y.Z.apk` and `codedeck-bridge-vX.Y.Z.tgz` attached,
   and the `ghcr.io/<owner>/codedeck-plus-bridge:vX.Y.Z` image pushed (+
   `:latest` for a non-prerelease).

## Dry run without tagging

`workflow_dispatch` on `release.yml` runs the same pipeline; pass `version`
(e.g. `v1.2.3`) and optionally tick `prerelease`. Useful to shake out a signing
or toolchain problem before committing to a real tag.

## If a release build fails

Fix forward: land the fix on `master`, delete the bad tag
(`git push origin :vX.Y.Z` and delete any half-created GitHub Release), and
re-tag the new commit. Do not force-push a moved tag over a published release.
