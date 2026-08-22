# CodeDeck release runbook (CDX-013)

Four artifacts, four pipelines, one rule: **CI builds, humans publish.** Every
workflow uploads its artifact on a tag push and refuses to publish unless it is
re-dispatched manually with an explicit confirm phrase AND the matching secret
exists. Nothing publishes from a tag alone.

Current version: **0.9.0** across every package (pre-release of the 1.0
cutover; the whole monorepo is stamped in lockstep until 1.0, after which
packages may drift apart per-package).

## Version bump rules (semver per package)

- One shared `0.9.x` line until the 1.0 cutover; bump the affected package(s)
  + the root in the same commit.
- Bump locations per artifact:
  - **mobile**: `apps/mobile/package.json`, `apps/mobile/src-tauri/Cargo.toml`,
    `apps/mobile/src-tauri/tauri.conf.json` (all three in lockstep) + Android
    `versionCode` (`tauri.conf.json > bundle > android` — MUST be strictly
    monotonic; Zapstore sorts by it).
  - **bridge CLI**: `apps/bridge-cli/package.json` (this is the npm version —
    npm rejects re-publishing an existing one).
  - **VSCode ext**: `apps/bridge-vscode/package.json` (Marketplace rejects
    re-publishing an existing one).
  - **relay**: `apps/relay/package.json` + the NIP-11 `version` in
    `apps/relay/config/override.ts`.
- Protocol changes bump `PROTOCOL_VERSION` in `packages/protocol` — that is a
  compatibility fence, not a release version; see `docs/PROTOCOL.md`.

## Tag conventions

| Artifact | Tag | Workflow |
|---|---|---|
| npm CLI `@codedeck/bridge` | `bridge-vX.Y.Z` | `.github/workflows/release-bridge.yml` |
| VSCode extension | `vscode-vX.Y.Z` | `.github/workflows/release-vscode.yml` |
| Android APK | `mobile-vX.Y.Z` | `.github/workflows/release-android.yml` |
| Relay deploy | (no tag — dispatch only) | `.github/workflows/deploy-relay.yml` |

## 1. `@codedeck/bridge` → npm

1. Bump the version, commit, tag `bridge-vX.Y.Z`, push the tag.
2. CI builds (typecheck + tests + esbuild bundle + CLI smoke) and uploads
   `codedeck-bridge-X.Y.Z.tgz` as an artifact. Inspect it (`npm pack` output:
   `out/main.js` bundle + systemd unit + README; core/protocol/qrcode are
   bundled in, only the Agent SDK is a runtime dependency).
3. **HUMAN GATE**: run the `release-bridge` workflow via *Run workflow* with
   `confirm_publish` = `publish-npm`. Requires the repo secret **`NPM_TOKEN`**
   (npm automation token with publish rights to the `@codedeck` scope).
4. Verify: `npx @codedeck/bridge@X.Y.Z version`.

## 2. VSCode extension → Marketplace

1. Bump the version, commit, tag `vscode-vX.Y.Z`, push the tag.
2. CI builds and uploads `codedeck-bridge-vscode-X.Y.Z.vsix` (~490KB; the
   2.1MB bundle inside is expected — SDK + core compiled in, only `vscode`
   external).
3. Sanity-smoke the artifact locally: `code --install-extension <vsix>` →
   status bar shows "CodeDeck: no phones" (see TODO CDX-010's run-sheet).
4. **HUMAN GATE**: dispatch `release-vscode` with `confirm_publish` =
   `publish-marketplace`. Requires the **`VSCE_PAT`** secret (Azure DevOps PAT
   for the `codedeck` publisher). First publish also needs the publisher to
   exist on the Marketplace.

## 3. Android APK → Zapstore

1. Bump versions (see rules above — Android `versionCode` monotonic!), commit,
   tag `mobile-vX.Y.Z`, push the tag (or dispatch `release-android`).
2. CI builds the RELEASE aarch64 APK (minified, stripped) and enforces the
   size gate: app `.so` ≤ 50MB, APK ≤ 100MB (measured baseline 2026-08-06:
   24.3MB `.so`, 45.6MB APK; the debug `.so` was 226MB — the gate exists so a
   stripping regression fails loudly).
3. **Signing**: with the four repo secrets set the artifact comes out signed —
   `ANDROID_KEYSTORE_BASE64` (base64 of the keystore), `ANDROID_KEYSTORE_PASSWORD`,
   `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. Without them the APK is
   **unsigned** and must be signed locally (`apksigner sign --ks …`). Local
   builds sign automatically when `src-tauri/gen/android/keystore.properties`
   exists (gitignored; fields `storeFile`/`storePassword`/`keyAlias`/`keyPassword`).

   **KEYSTORE DECISION (owner, 2026-08-06 — do not "fix" this back):** despite
   the new appId, CodeDeck Next is signed with the **EXISTING CodeDeck release
   keystore** (`codedeck/src-tauri/gen/android/codedeck-release.keystore`,
   alias `codedeck`, cert SHA-256 `c5d0cba4…bbfbc5`). *Rationale:* that cert is
   already covered by the live kind-30509 NIP-C1 proof on the relay under the
   publishing identity `f07e0b1a…c367`, so the Zapstore publish needs **no
   `zsp identity --link-key` step at all**. An earlier draft of this section
   said to mint a new keystore; that was reversed before the first publish.
   *Consequence, accepted:* both apps now share one signing identity
   permanently — the key cannot be rotated for one without the other, and a
   compromise of it affects both. The appIds still differ, so the two apps
   remain independent installs.
4. Mesh engine note: CI only bundles `libnostr_vpn_app_core.so` when the
   `NVPN_REPO` repo variable + `NVPN_REPO_TOKEN` secret point at the nostr-vpn
   checkout; otherwise the APK ships without mesh support (gradle logs a
   warning and skips). Local builds pick up the workspace-root `nostr-vpn`
   checkout automatically.
5. **HUMAN GATE — Zapstore publish** (never from CI). From `apps/mobile`:
   1. Credentials live in the gitignored **`.env.zapstore`** (a `bunker://…`
      NIP-46 URL with an embedded secret — `.env.zapstore.*` rotation backups
      are gitignored too; treat both as key material).
   2. Temp-inject `release_source` / `version` / `release_notes` into
      `zapstore.yaml`; revert after publishing (runbook:
      `kubo/docs/zapstore-publish.md`).
   3. **MANDATORY signer proof BEFORE publishing**:
      `zsp publish -q zapstore.yaml --offline` — every event must resolve to
      the listing owner's pubkey. A signer mismatch FORKS the listing instead
      of updating it. `-q` is required (the interactive prompt hangs
      non-interactive shells), and `-q` also mutes success output — never
      trust silence, check the events landed.
   4. `zsp publish -q` — then fetch the CDN blob back and `cmp` it
      byte-identical to the local APK.
   5. First publish owes fresh screenshots (`zapstore.yaml` `images` is
      empty on purpose — the old listing's shots show the old UI).
6. Coexistence: this is a NEW listing/appId. The old `com.codedeck.app`
   listing stays as-is; both apps install side by side during the transition.

## 4. Relay → Cloudflare (`relay2.descendant.io`)

**This is the CDX-007 vehicle. It touches LIVE infra on the descendant.io
zone — dispatch it only with explicit owner confirmation.**

- `deploy-relay.yml` is **workflow_dispatch only**; the dispatcher must type
  `deploy-relay2` and the **`CLOUDFLARE_API_TOKEN`** secret must be set
  (Workers + D1 + KV edit rights). It runs relay tests, a dry-run build, D1
  migrations (`--remote`), then `wrangler deploy --minify`.
- Post-deploy secrets (one-time, `wrangler secret put`): `RELAY_ADMIN_TOKEN`
  (register-agent bearer), plus `API_TOKEN`/`ACCOUNT_ID`/`KV_ID_EVENTS` for
  the KV bulk path. `RESTRICTED_WRITES` stays default ("true") on relay2.
- After the first deploy, register the bridge + phone pubkeys via
  `POST /api/register-agent` (or let the bridge's pairing auto-register do it
  — needs `relayRegisterEndpoint`/`relayRegisterToken` in the bridge config;
  https is enforced for the token since CDX-013).

## Secrets inventory (GitHub repo)

| Secret | Used by | Notes |
|---|---|---|
| `NPM_TOKEN` | release-bridge | npm automation token, `@codedeck` scope |
| `VSCE_PAT` | release-vscode | Marketplace publisher PAT |
| `ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD` | release-android | The **existing CodeDeck** keystore (alias `codedeck`, cert `c5d0cba4…bbfbc5`) — see the keystore decision in §3, NOT a new one |
| `CLOUDFLARE_API_TOKEN` | deploy-relay | Workers/D1/KV edit |
| `NVPN_REPO_TOKEN` (+ `NVPN_REPO` variable) | release-android | optional mesh engine |

Zapstore's `.env.zapstore` is deliberately NOT a CI secret — publishing is a
local, human step.

## Migration note (old → new CodeDeck)

Clean break, by design (protocol v10 changed kinds/seq/sync; the install base
is the owner + a friend):

- The new app is a different Android appId — old and new **coexist** on the
  same phone during transition.
- **Fresh pairing is required**: old pairings, session history, and settings
  do not carry over. Pair each bridge again from the new app.
- The new bridge (CLI or extension) only speaks v10; keep the old extension
  around only as long as the old app is in use.
- The relay accepts both generations' kinds during the transition (the old
  system used different kinds entirely; no collision).

## Soak / device gates before 1.0

- `scripts/soak.mjs` — laptop soak rig (wrangler dev + bridge-cli + phone
  simulator); see `TODO.md` CDX-013 for the smoke numbers and the over-mesh
  device soak owed to the device batch.
- The device-verify run-sheet (`docs/CDX-009-3B-DEVICE-VERIFY.md`) must be
  cleared before calling 1.0.
