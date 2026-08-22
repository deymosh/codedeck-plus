/**
 * useAttentionDirection (Phase 8) — do any sessions BEFORE/AFTER the current
 * one in the carousel order need attention? Drives the ‹/› hint chevrons in
 * the session header on touch devices (ported from the old SessionHeader's
 * useAttentionDirection).
 *
 * Uses the SAME ordered list as the swipe carousel (getOrderedSessionKeys)
 * and the SAME predicate as the sidebar's attention dot
 * (core/sessionNeedsAttention over machine state + unreadSessions) — the
 * chevron always points at something the sidebar would also mark.
 */
import { useMemo } from 'react';
import { sessionNeedsAttention } from '../core/sessionNeedsAttention';
import { sessionKeyOf } from '../core/stores/ui';
import { useMachines, useUi } from './coreContext';
import type { SessionKey } from './getOrderedSessionKeys';

export interface AttentionDirection {
  left: boolean;
  right: boolean;
}

const NONE: AttentionDirection = { left: false, right: false };

/** Pure core: scan before/after `currentIndex` with the given predicate. */
export function attentionDirection(
  orderedKeys: readonly SessionKey[],
  currentIndex: number,
  needsAttention: (key: SessionKey) => boolean,
): AttentionDirection {
  if (currentIndex < 0 || orderedKeys.length <= 1) return NONE;

  let left = false;
  for (let i = 0; i < currentIndex; i++) {
    if (needsAttention(orderedKeys[i]!)) {
      left = true;
      break;
    }
  }

  let right = false;
  for (let i = currentIndex + 1; i < orderedKeys.length; i++) {
    if (needsAttention(orderedKeys[i]!)) {
      right = true;
      break;
    }
  }

  return left || right ? { left, right } : NONE;
}

export function useAttentionDirection(
  orderedKeys: readonly SessionKey[],
  currentKey: SessionKey,
): AttentionDirection {
  const machines = useMachines((st) => st.machines);
  const unreadSessions = useUi((st) => st.unreadSessions);

  return useMemo(() => {
    const currentIndex = orderedKeys.findIndex(
      (k) => k.machine === currentKey.machine && k.sessionId === currentKey.sessionId,
    );
    return attentionDirection(orderedKeys, currentIndex, (key) =>
      sessionNeedsAttention(
        machines[key.machine]?.sessions[key.sessionId]?.info.state,
        unreadSessions.has(sessionKeyOf(key.machine, key.sessionId)),
      ),
    );
  }, [orderedKeys, currentKey.machine, currentKey.sessionId, machines, unreadSessions]);
}
