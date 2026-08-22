/**
 * Nostr event kinds for the CodeDeck protocol (v10 redesign).
 *
 * Traffic is split by storage class so the phone's stored-event subscription is
 * low-frequency only. This is what structurally fixes the old since-filter
 * starvation bug: high-frequency live output no longer advances the stored-event
 * cursor past the session-list heartbeat.
 */

/** Session-list heartbeat. NIP-33 parameterized replaceable (d = machine name).
 *  Replaceable: the relay keeps exactly one — subscribers always fetch current,
 *  never with a `since` filter. */
export const SESSION_LIST_KIND = 30515;

/** Phone → bridge commands. Stored, so a briefly-offline bridge still receives
 *  them on resubscribe. NIP-40 expiration: COMMAND_EXPIRY_SECONDS. */
export const COMMAND_KIND = 4515;

/** Bridge → phone stored responses: sync chunks, acks, pairing/control replies.
 *  Stored so a briefly-offline phone still receives them. NIP-40 expiration:
 *  RESPONSE_EXPIRY_SECONDS. */
export const RESPONSE_KIND = 4516;

/** Bridge → phone live output/status/usage. Ephemeral (20000–29999): relays
 *  broadcast but never store. Loss is acceptable by design — the transcript sync
 *  protocol recovers anything missed. */
export const LIVE_KIND = 24515;

/** NIP-40 expiration applied to COMMAND_KIND events (seconds). */
export const COMMAND_EXPIRY_SECONDS = 60 * 60;

/** NIP-40 expiration applied to RESPONSE_KIND events (seconds). */
export const RESPONSE_EXPIRY_SECONDS = 60 * 60;

/** All kinds a CodeDeck relay must accept from registered agents. */
export const CODEDECK_KINDS = [
  SESSION_LIST_KIND,
  COMMAND_KIND,
  RESPONSE_KIND,
  LIVE_KIND,
] as const;
