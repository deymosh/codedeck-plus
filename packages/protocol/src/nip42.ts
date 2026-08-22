/**
 * NIP-42 AUTH signer, shared by the bridge and the phone — both answer relay
 * AUTH challenges with their OWN existing identity keypair (the same pubkey
 * already used for pairing/publishing), so a private/Haven relay only needs
 * ONE allowlisted pubkey per side. No separate auth-only credential.
 *
 * nostr-tools already builds the `kind: 22242` event template
 * (`makeAuthEvent`: relay URL + challenge) and calls this signer with it —
 * this only finalizes (signs) it. Safe to hand to `automaticallyAuth`
 * unconditionally: a relay that never sends an AUTH challenge (any public
 * relay) never calls the signer at all.
 */
import { finalizeEvent } from 'nostr-tools/pure';
import type { EventTemplate, VerifiedEvent } from 'nostr-tools/core';

/** Matches nostr-tools' `AbstractPoolConstructorOptions['automaticallyAuth']`
 *  and `SubscribeManyParams['onauth']` shape — kept local so this package
 *  doesn't need nostr-tools' internal (non-exported) option types. */
export type RelayAuthSigner = (event: EventTemplate) => Promise<VerifiedEvent>;

export function createRelayAuthSigner(secretKey: Uint8Array): (relayUrl: string) => RelayAuthSigner {
  return () => async (event: EventTemplate): Promise<VerifiedEvent> => finalizeEvent(event, secretKey);
}
