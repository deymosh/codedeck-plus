/**
 * relayTransport — the real `PhoneTransport` over nostr-tools' SimplePool
 * (Phase 3b).
 *
 * Deliberately THIN: the connection-epoch guard, per-class filters, dedup and
 * FSM wiring all live in the core's `PhoneNostrClient` — this module only
 * adapts SimplePool's surface to the `PhoneTransport` port:
 * - `enablePing: true` (WS-level liveness — part of the bug-A fix; a dead
 *   socket is detected instead of silently rotting),
 * - `enableReconnect: false` — reconnect policy belongs to the connection FSM,
 *   not the pool; a dying subscription must surface as ONE `onClose` so the
 *   FSM can back off honestly,
 * - `idleTimeout` neutralized (CDX-020) — with `enablePing` on, nostr-tools
 *   2.24.1 closes the relay on its OWN timer a couple of minutes after every
 *   connect and takes every live REQ with it. See platform/poolOptions.ts for
 *   the full mechanism; the constant is shared with the bridge's fix (CDX-055),
 * - subscription `onclose` is forwarded ONLY for non-deliberate deaths: after
 *   `sub.close()` / `transport.close()` the transport never calls back (the
 *   nostr-tools "pool.destroy fires onclose" trap dies here AND in the
 *   client's epoch guard — belt and braces),
 * - `setRelays` replaces the list for future subscribe/publish calls (the
 *   client resubscribes right after),
 * - `publish` resolves true when at least one relay accepted the event.
 *
 * The pool is injectable (`PoolLike`) so subscription bookkeeping and close
 * idempotence are unit-tested without sockets; the real-socket smoke runs in
 * the device-test phases.
 */
import { SimplePool } from 'nostr-tools/pool';
import type { EventTemplate, NostrEvent, VerifiedEvent } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import { createRelayAuthSigner } from '@codedeck/protocol';
import type {
  Logger,
  PhoneTransport,
  PublishConfirmOptions,
  PublishResult,
  PublishVerdict,
  TransportSubscription,
  TransportSubscriptionParams,
} from '../core/ports';
import { remainingBudget } from '../core/deadline';
import { transportPoolOptions } from './poolOptions';

/**
 * CDX-086 — confirmation policy. Budget is under the outbox sweep's
 * OUTBOX_CONFIRM_TIMEOUT_MS (30 s) so a confirmation can never outlive the row
 * it is confirming; attempts is ~3 × nostr-tools' 4.4 s publishTimeout.
 */
export const PUBLISH_CONFIRM_BUDGET_MS = 12_000;
export const PUBLISH_CONFIRM_ATTEMPTS = 3;

/** Severity order — the softest surviving verdict across relays wins. */
const RANK: Record<PublishVerdict, number> = {
  accepted: 0,
  unconfirmed: 1,
  rejected: 2,
  unreachable: 3,
};

/**
 * Decode ONE relay's outcome. Every branch here decodes a specific nostr-tools
 * 2.24.1 behaviour, so it is written against them explicitly:
 *
 * - a fulfilled value is the relay's OK `reason` (usually ''), EXCEPT that
 *   `ensureRelay` failure resolves with the STRING `"connection failure: …"`
 *   rather than rejecting. That string is why the old boolean called an
 *   unreachable relay a success.
 * - `relay.publish` rejects with exactly `new Error('publish timed out')` after
 *   publishTimeout, and the frame WAS written to the socket first.
 * - anything else rejected is the relay refusing: `rate-limited:`, `blocked:`,
 *   `pow:`, `SendingOnClosedConnection`.
 */
function classify(outcome: PromiseSettledResult<string>): PublishResult {
  if (outcome.status === 'fulfilled') {
    const value = String(outcome.value ?? '');
    if (/^connection failure:/i.test(value)) {
      return { verdict: 'unreachable', detail: value };
    }
    return { verdict: 'accepted', ...(value ? { detail: value } : {}) };
  }
  const reason = String(outcome.reason ?? '');
  if (/publish timed out/i.test(reason)) return { verdict: 'unconfirmed', detail: reason };
  return { verdict: 'rejected', detail: reason };
}

/**
 * Resolve on the FIRST acceptance rather than waiting for every relay.
 * `Promise.allSettled` made every publish pay the slowest relay's 4.4 s timeout,
 * which is what turned a 115-chunk fallback into minutes.
 *
 * Every attempt gets a rejection handler attached UP FRONT (the two-arg `.then`,
 * not a bare `await`): resolving early abandons the siblings, and an abandoned
 * rejection is an unhandled rejection — the CDX-060 trap, which vitest fails the
 * whole run on.
 */
async function raceForAcceptance(
  attempts: Promise<string>[],
  budgetMs: number,
): Promise<PublishResult> {
  return new Promise<PublishResult>((resolve) => {
    let pending = attempts.length;
    let best: PublishResult = { verdict: 'unreachable', detail: 'no relay settled' };
    let done = false;
    const settle = (result: PublishResult): void => {
      if (done) return;
      done = true;
      resolve(result);
    };
    const timer = setTimeout(
      () => settle(best.verdict === 'unreachable' ? { verdict: 'unconfirmed', detail: 'budget elapsed' } : best),
      Math.max(0, budgetMs),
    );
    for (const attempt of attempts) {
      attempt.then(
        (value) => note({ status: 'fulfilled', value }),
        (reason: unknown) => note({ status: 'rejected', reason }),
      );
    }
    function note(outcome: PromiseSettledResult<string>): void {
      const result = classify(outcome);
      if (RANK[result.verdict] < RANK[best.verdict]) best = result;
      // An acceptance is final — no reason to wait on a slow sibling.
      if (result.verdict === 'accepted') {
        clearTimeout(timer);
        settle(result);
        return;
      }
      if (--pending === 0) {
        clearTimeout(timer);
        settle(best);
      }
    }
  });
}

/** The slice of SimplePool the transport uses (injectable for tests). */
export interface PoolLike {
  subscribe(
    relays: string[],
    filter: Filter,
    params: {
      onevent: (event: NostrEvent) => void;
      oneose?: () => void;
      onclose?: (reasons: Array<{ url: string; reason: string }>) => void;
      /** See the `onauth` derivation in createRelayTransport for why this
       *  needs to be passed to EVERY subscribe call, not just supplied at
       *  pool construction. */
      onauth?: (event: EventTemplate) => Promise<VerifiedEvent>;
    },
  ): { close(reason?: string): void };
  publish(relays: string[], event: NostrEvent): Promise<string>[];
  destroy(): void;
}

export interface RelayTransportDeps {
  relays: readonly string[];
  /** Defaults to a real SimplePool built from `transportPoolOptions()`:
   *  enablePing on, pool-level auto-reconnect OFF (reconnects are the
   *  connection FSM's job), idle-close neutralized (CDX-020). */
  pool?: PoolLike;
  log?: Logger;
  /** The phone's own identity secret key — used ONLY to answer NIP-42 AUTH
   *  challenges (e.g. a Haven relay), via @codedeck/protocol#createRelayAuthSigner.
   *  Same identity already used for pairing; no separate credential. Omit to
   *  skip AUTH entirely — relays that don't challenge are unaffected either
   *  way. Ignored when `pool` is supplied directly (tests own that pool's
   *  construction). */
  secretKey?: Uint8Array;
}

export function createRelayTransport(deps: RelayTransportDeps): PhoneTransport & {
  /** Exposed for tests/diagnostics. */
  readonly openSubscriptionCount: number;
} {
  const automaticallyAuth = deps.secretKey ? createRelayAuthSigner(deps.secretKey) : undefined;
  const pool: PoolLike = deps.pool ?? new SimplePool(transportPoolOptions(automaticallyAuth));
  const log = deps.log;

  // `automaticallyAuth` above only makes ensureRelay() set relay.onauth,
  // which fires REACTIVELY on an ["AUTH", challenge] message. It does NOT
  // make nostr-tools retry a REQ a relay rejected with `auth-required: ...`
  // — that retry ("await the full AUTH round-trip, then re-send the SAME
  // REQ on the now-authed connection") is a separate path gated on
  // `params.onauth` being passed to the specific subscribe/subscribeMany
  // call (see abstract-pool.ts). Without it, a NIP-42 relay's `auth-required`
  // just looks like a dropped subscription — the FSM reconnects into a
  // brand-new, again-unauthenticated socket forever. Flat signer: our
  // createRelayAuthSigner ignores its relayUrl argument (same identity
  // regardless of which relay asks), so any URL derives the same function.
  const flatAuth: ((event: EventTemplate) => Promise<VerifiedEvent>) | undefined = automaticallyAuth
    ? (automaticallyAuth('') ?? undefined)
    : undefined;

  let relays = [...deps.relays];
  let closed = false;
  const open = new Set<{ closed: boolean }>();

  /** Local, so `publish` can delegate without depending on `this` binding. */
  const publishConfirmed = async (
    event: NostrEvent,
    opts?: PublishConfirmOptions,
  ): Promise<PublishResult> => {
    if (closed) return { verdict: 'unreachable', detail: 'transport closed' };
    const budgetMs = opts?.budgetMs ?? PUBLISH_CONFIRM_BUDGET_MS;
    const maxAttempts = Math.max(1, opts?.attempts ?? PUBLISH_CONFIRM_ATTEMPTS);
    const startedAt = Date.now();
    let last: PublishResult = { verdict: 'unreachable', detail: 'no relays configured' };

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (opts?.signal?.aborted) return last;
      if (attempt > 0 && remainingBudget(startedAt, budgetMs, Date.now) <= 0) break;

      // The SAME signed event every time — see PublishConfirmOptions.attempts.
      const attempts = pool.publish([...relays], event);
      if (attempts.length === 0) return last;
      last = await raceForAcceptance(attempts, remainingBudget(startedAt, budgetMs, Date.now));
      // Both of these mean the bridge has it (or almost certainly does).
      if (last.verdict === 'accepted' || last.verdict === 'unconfirmed') return last;
    }

    log?.(`[RelayTransport] publish ${last.verdict}: ${last.detail ?? '(no detail)'}`);
    return last;
  };

  return {
    get openSubscriptionCount(): number {
      return open.size;
    },

    subscribe(filter: Filter, params: TransportSubscriptionParams): TransportSubscription {
      if (closed) {
        log?.('[RelayTransport] subscribe after close() ignored');
        return { close: () => {} };
      }
      const state = { closed: false };
      open.add(state);
      const sub = pool.subscribe([...relays], filter, {
        ...(flatAuth ? { onauth: flatAuth } : {}),
        onevent: (event) => {
          if (state.closed || closed) return;
          params.onEvent(event);
        },
        oneose: () => {
          if (state.closed || closed) return;
          params.onEose?.();
        },
        onclose: (reasons) => {
          // Deliberate close (ours or transport-wide) never surfaces upward.
          if (state.closed || closed) return;
          state.closed = true;
          open.delete(state);
          params.onClose?.(reasons);
        },
      });
      return {
        close: () => {
          if (state.closed) return;
          state.closed = true;
          open.delete(state);
          try {
            sub.close();
          } catch (err) {
            log?.(`[RelayTransport] subscription close failed: ${err}`);
          }
        },
      };
    },

    publishConfirmed,

    async publish(event: NostrEvent): Promise<boolean> {
      if (closed) return false;
      // One attempt, same boolean contract as before — EXCEPT that an
      // all-unreachable publish now correctly reports false. It used to report
      // true, because nostr-tools resolves a connection failure with a string
      // instead of rejecting, and `allSettled` counted that as fulfilled.
      const result = await publishConfirmed(event, { attempts: 1 });
      return result.verdict === 'accepted' || result.verdict === 'unconfirmed';
    },

    setRelays(urls: readonly string[]): void {
      relays = [...urls];
      log?.(`[RelayTransport] relay list now: ${relays.join(', ')}`);
      // Existing subscriptions keep their old relay set; the client
      // resubscribes immediately after setRelays (PhoneNostrClient.setRelays).
    },

    close(): void {
      if (closed) return;
      // Order matters (the pool.destroy-fires-onclose trap): mark everything
      // deliberately closed BEFORE destroying so no callback escapes.
      closed = true;
      for (const state of open) state.closed = true;
      open.clear();
      try {
        pool.destroy();
      } catch (err) {
        log?.(`[RelayTransport] pool destroy failed: ${err}`);
      }
    },
  };
}
