/**
 * Platform Notifier (Phase 5c) — the OS delivery half of the notification
 * seam. WHAT to notify (and when) is decided in core/notifications.ts; this
 * file only delivers:
 * - Tauri (Android/desktop): @tauri-apps/plugin-notification. On Android 13+
 *   its requestPermission() drives the POST_NOTIFICATIONS runtime prompt.
 * - Plain browser dev: the Web Notification API.
 * - Neither: silent no-op.
 */
import type { Logger, Notifier } from '../core/ports';

const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let permissionGranted: boolean | null = null;

/**
 * Ask for OS notification permission (idempotent; caches the answer for this
 * app run). Called lazily before the first delivery and explicitly by the
 * Settings stay-connected flow (the foreground service posts a notification).
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (permissionGranted !== null) return permissionGranted;
  try {
    if (isTauri()) {
      const plugin = await import('@tauri-apps/plugin-notification');
      let granted = await plugin.isPermissionGranted();
      if (!granted) {
        granted = (await plugin.requestPermission()) === 'granted';
      }
      permissionGranted = granted;
    } else if (typeof Notification !== 'undefined') {
      if (Notification.permission === 'granted') permissionGranted = true;
      else if (Notification.permission === 'denied') permissionGranted = false;
      else permissionGranted = (await Notification.requestPermission()) === 'granted';
    } else {
      permissionGranted = false;
    }
  } catch {
    permissionGranted = false;
  }
  return permissionGranted;
}

/** Per-tag bookkeeping cap — a tag rarely accumulates more than a couple of
 *  live notifications; the cap only bounds memory on pathological streams. */
const MAX_IDS_PER_TAG = 16;

/** Fire-and-forget OS notification delivery behind the core's Notifier port.
 *
 * CDX-026c cancellation: the Tauri plugin can only remove a delivered
 * notification by its 32-bit integer `id` (`removeActive([{id}])`) — there is
 * no tag/group query on the send side — so we assign our own ids and remember
 * them per cancellation tag. Ids survive only this app run: notifications
 * delivered by a previous run can't be cancelled (plugin API limit; `active()`
 * exists but is mobile-only and its returned ids are not reliable on Android
 * for externally-restored notifications). Web dev mode keeps `Notification`
 * object refs and `close()`s them. Everything is catch-and-ignore best-effort.
 */
export function createPlatformNotifier(log?: Logger): Notifier {
  // 32-bit-safe id seed; per-run uniqueness is all cancellation needs.
  let nextId = Date.now() & 0x0fffffff;
  const tauriIdsByTag = new Map<string, number[]>();
  const webRefsByTag = new Map<string, Notification[]>();

  const remember = <T>(map: Map<string, T[]>, tag: string, value: T): void => {
    const list = map.get(tag) ?? [];
    list.push(value);
    if (list.length > MAX_IDS_PER_TAG) list.shift();
    map.set(tag, list);
  };

  const deliver = async (content: { title: string; body: string; tag?: string }): Promise<void> => {
    if (!(await ensureNotificationPermission())) return;
    if (isTauri()) {
      const { sendNotification } = await import('@tauri-apps/plugin-notification');
      nextId = (nextId + 1) | 0;
      const id = nextId;
      sendNotification({ id, title: content.title, body: content.body });
      if (content.tag) remember(tauriIdsByTag, content.tag, id);
    } else if (typeof Notification !== 'undefined') {
      const n = new Notification(content.title, { body: content.body });
      if (content.tag) remember(webRefsByTag, content.tag, n);
    }
  };

  const cancelDelivered = async (tag: string): Promise<void> => {
    const ids = tauriIdsByTag.get(tag);
    tauriIdsByTag.delete(tag);
    if (ids && ids.length > 0 && isTauri()) {
      const { removeActive } = await import('@tauri-apps/plugin-notification');
      await removeActive(ids.map((id) => ({ id })));
    }
    const refs = webRefsByTag.get(tag);
    webRefsByTag.delete(tag);
    for (const n of refs ?? []) {
      try {
        n.close();
      } catch {
        // best-effort
      }
    }
  };

  return {
    notify: (content) => {
      void deliver(content).catch((err) => log?.(`[Notifier] delivery failed: ${err}`));
    },
    cancel: (tag) => {
      void cancelDelivered(tag).catch((err) => log?.(`[Notifier] cancel failed: ${err}`));
    },
  };
}
