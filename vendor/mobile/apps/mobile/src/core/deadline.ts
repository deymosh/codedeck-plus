/**
 * Deadlines and cancellation — the primitives every bounded stage shares.
 *
 * Moved verbatim out of `ui/imageFile.ts` (CDX-086), which is where CDX-064 and
 * CDX-068 first needed them. They live in `core/` rather than `ui/` because
 * `core/dmAttachments.ts` is the pure, DOM-free layer and must not reach up into
 * the UI tree for them.
 *
 * The rule these exist to enforce: EVERY stage of a network operation carries a
 * deadline and honours a cancel. CDX-068 bounded the file read only, which left
 * the Blossom PUT, the reference publish and the chunk fallback each able to hang
 * forever — and the composer's spinner could only clear when the whole chain
 * settled, so it did not.
 */

/** `DOMException name: message` when available — the banner's diagnosis. */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.name && err.name !== 'Error' ? `${err.name}: ${err.message}` : err.message;
  }
  return String(err);
}

/** Named so `describeError` renders it as `TimeoutError: <what> timed out …`,
 *  i.e. the banner distinguishes a stall from a rejection. */
export function timeoutError(label: string, ms: number): Error {
  const err = new Error(`${label} timed out after ${ms} ms`);
  err.name = 'TimeoutError';
  return err;
}

/**
 * Reject with a named TimeoutError if `work` has not settled inside `ms`.
 * `onTimeout` is the stalled operation's teardown (FileReader.abort,
 * AbortController.abort) — it runs BEFORE the rejection so nothing is left
 * holding the dead stream. A late settle from `work` lands on an already-settled
 * promise and is discarded, so an aborted reader's `onabort` rejection can never
 * surface as an unhandled rejection (the CDX-060 trap).
 */
export function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(timeoutError(label, ms));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

// --- Cancellation (CDX-086) ---------------------------------------------------

/**
 * Named so it is distinguishable from a real failure at every catch site: a
 * cancel must not raise an error banner, must not be retried, and must not keep
 * the user's attachment staged as though something went wrong.
 */
export function cancelledError(label: string): Error {
  const err = new Error(`${label} cancelled`);
  err.name = 'CancelledError';
  return err;
}

/** True for our own cancel and for a DOMException from an AbortController. */
export function isCancelled(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'CancelledError' || err.name === 'AbortError';
}

/** Throw if the caller has cancelled. Call before every irreversible step. */
export function throwIfCancelled(signal: AbortSignal | undefined, label: string): void {
  if (signal?.aborted) throw cancelledError(label);
}

/**
 * Milliseconds left of `budgetMs` since `startedAt`, floored at 0. Lets a
 * multi-attempt stage share ONE wall-clock budget instead of granting each
 * attempt a fresh one — N attempts × a per-attempt timeout is how an
 * "bounded" operation still takes minutes.
 */
export function remainingBudget(startedAt: number, budgetMs: number, now: () => number): number {
  return Math.max(0, budgetMs - (now() - startedAt));
}
