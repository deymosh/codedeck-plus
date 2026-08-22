/**
 * The ONE copy of the default relay list. The old system had four disagreeing
 * lists across two repos; every component (phone, VSCode bridge, CLI bridge)
 * must import from here and additionally allow user-added relays.
 */

/** Primary transport: the self-hosted CodeDeck relay (Cloudflare Workers,
 *  restricted writes — paired pubkeys are registered via its admin API). */
export const PRIMARY_RELAY = 'wss://relay2.descendant.io';

/** Public fallback used for pairing (a fresh phone key is not yet registered on
 *  the private relay) and as a redundancy path. */
export const PAIRING_RELAY = 'wss://relay.primal.net';

/**
 * CDX-042: a SECOND public relay, so a clean install has redundancy.
 *
 * PRIMARY_RELAY is undeployed (gated on CDX-007) and the phone scrubs it from
 * its defaults (CDX-021 / DEAD_DEFAULT_RELAYS), which left exactly one live
 * relay in a fresh install — device-verified 2026-08-08: a second relay had to
 * be added by hand before the phone could reach the bridge, and a single relay
 * outage takes the app fully offline out of the box. Two live public relays is
 * the floor for a first run that works.
 *
 * ── THE VETTING RULE, and it is not optional ──────────────────────────────
 * Publish-test the EPHEMERAL kind 24515 specifically, not just kind 1 (24515
 * carries live session output and ephemeral kinds are what relays gate first),
 * and probe REPEATEDLY OVER TIME from a fresh key. A cold probe is worthless
 * here: it is precisely what cleared the two relays below before they failed.
 *
 * Rejected candidates, each for a reason worth remembering:
 *
 * - `wss://nos.lol` (CDX-057) — do not "helpfully" switch it back. During
 *   device-verify run 3 it rejected publishes with `pow: 28 bits needed. (12)`,
 *   confirmed twice, while primal accepted the same events. Cold probes passed
 *   every kind, so the gate is intermittent and NIP-11 does not advertise it.
 * - `wss://relay.damus.io` (CDX-081) — shipped as this constant in 0.9.0/0.9.1
 *   and it was the wrong choice. The founder's live bridge log for 2026-08-09
 *   was **450 rate-limit rejections out of 496 lines**
 *   (`rate-limited: you are noting too much`) with ZERO primal failures, so the
 *   redundancy CDX-042 added was not real. Reproduced from a brand-new
 *   throwaway key: **2 of 10** rounds accepted. It is not reputation, it is
 *   volume — damus is hostile to writes at any rate.
 * - `wss://nostr.bitcoiner.social` — 3/3 on a cold probe, then
 *   `Policy violated and pubkey is not in our web of trust.` on a later round.
 *   A WoT-gated relay is disqualified BY CONSTRUCTION: a first pairing is a
 *   brand-new key with no web of trust, which is exactly when it would fail.
 * - `wss://relay.snort.social` — 10/10 on stored and replaceable kinds but
 *   **8/10 on 24515**, with connection timeouts. This is the failure the
 *   ephemeral-kind rule exists to catch.
 * - `relay.nostr.band`, `offchain.pub`, `relayable.org` — 0/3, unreachable.
 *
 * Chosen: `nostr.oxtr.dev`, clean 30/30 (all three kinds × 10 rounds over ~7
 * minutes) alongside primal's 30/30. `wss://nostr.mom` also scored 30/30 and is
 * the pre-vetted spare — swap to it without re-probing if oxtr degrades.
 * Evidence: `docs/evidence/cdx-084-089/cdx-081-relay-probe-10rounds.log`, and
 * the probe itself is checked in beside it.
 *
 * Changing this constant? `LEGACY_DEFAULT_RELAY_SETS` in the phone's settings
 * store must gain the OUTGOING default in the same commit, or every install
 * that merely took the old default is read as customised and stranded on the
 * relay you just removed.
 */
export const FALLBACK_RELAY = 'wss://nostr.oxtr.dev';

export const DEFAULT_RELAYS: readonly string[] = [PRIMARY_RELAY, PAIRING_RELAY, FALLBACK_RELAY];

/**
 * CDX-100: Marmot-only relays, added to the PHONE's default list (never the
 * bridge's — the bridge speaks no MLS kind).
 *
 * Marmot lives on its own relay island. Measured 2026-08-10: the hermit/rocket
 * agent fleet publishes its kind-30443 KeyPackages to nos.lol + these two, and
 * to NOTHING the app shipped with — primal, oxtr and relay2 all returned zero
 * 30443s for those authors, so `startChat` answered "Peer has no published
 * Marmot KeyPackage" for a peer whose KeyPackage was live the whole time. Any
 * White Noise / MDK peer will be reachable the same way: on Marmot relays.
 *
 * nos.lol is deliberately NOT here — CDX-057's intermittent `pow: 28 bits`
 * gate disqualified it as a default, and either whitenoise relay reaches the
 * same peers.
 *
 * These are strfry relays with a kind allowlist, which has ONE consequence
 * worth knowing before adding more of them: a REQ carrying a non-allowed kind
 * is not filtered, it is CLOSED (`bad req: filter validation failed: kind not
 * allowed: 4515`). That is safe here — nostr-tools fires the aggregate
 * `onclose` only when EVERY relay in a subscription has closed, and a close
 * counts as that relay's EOSE — so CodeDeck's own subscriptions simply run on
 * the other relays. Verified allowed: 1059, 30443, 445, 10051 (444 is refused,
 * correctly: a bare welcome must never be on a relay).
 */
export const MARMOT_RELAYS: readonly string[] = [
  'wss://relay.us.whitenoise.chat',
  'wss://relay.eu.whitenoise.chat',
];

/** Admin endpoint for registering a newly-paired pubkey on the private relay. */
export const DEFAULT_RELAY_REGISTER_ENDPOINT =
  'https://relay2.descendant.io/api/register-agent';
