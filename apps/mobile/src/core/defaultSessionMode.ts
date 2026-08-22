/**
 * Default session mode applier (CDX-047) — the bridge starts every session in
 * plan mode (packages/core runner: `permissionMode ?? 'plan'`), and
 * create-session has no mode field on the wire. A non-plan "default mode for
 * new sessions" preference is therefore applied by sending a mode command
 * when the session's `session-ready` arrives.
 *
 * Rules (owned by the unit tests):
 * - fires at most ONCE per new session (a replayed/duplicated session-ready
 *   must not re-send);
 * - only when the preference DIFFERS from the mode the session came up in;
 * - session-ready is only ever the answer to this phone's create-session, so
 *   no extra "did we create it" bookkeeping is needed.
 */
import type { PermissionMode, RemoteSessionInfo } from '@codedeck/protocol';

export interface DefaultModeApplierDeps {
  /** The preference at apply time (settings store read, not a snapshot). */
  defaultMode(): PermissionMode;
  /** BridgeApi.modeChange. */
  sendMode(machine: string, sessionId: string, mode: PermissionMode): void;
}

export type DefaultModeApplier = (
  machine: string,
  session: Pick<RemoteSessionInfo, 'id' | 'permissionMode'>,
) => void;

export function createDefaultModeApplier(deps: DefaultModeApplierDeps): DefaultModeApplier {
  const applied = new Set<string>();
  return (machine, session) => {
    const key = `${machine} ${session.id}`;
    if (applied.has(key)) return;
    applied.add(key);
    const want = deps.defaultMode();
    const startedIn = session.permissionMode ?? 'plan';
    if (want !== startedIn) deps.sendMode(machine, session.id, want);
  };
}
