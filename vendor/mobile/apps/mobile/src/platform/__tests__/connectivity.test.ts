/**
 * connectivity tests — injected event-target fakes + virtual timers prove the
 * native-signal wiring without a browser or a device.
 */
import { describe, it, expect } from 'vitest';
import {
  attachConnectivity,
  DEFAULT_TAURI_RESUME_EVENTS,
  type NativeConnectivitySource,
} from '../connectivity';
import { createConnectionStore, type ConnectionEvent } from '../../core/stores/connection';
import { serviceNotificationText } from '../foregroundService';
import type { Timers } from '../../core/ports';

class FakeTarget {
  listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type: string): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) l();
  }
  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

/** Minimal virtual clock over the core's Timers port. */
class VirtualTimers implements Timers {
  private nowMs = 0;
  private nextId = 1;
  private tasks = new Map<number, { at: number; fn: () => void }>();
  set(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.nowMs + ms, fn });
    return id;
  }
  clear(handle: unknown): void {
    this.tasks.delete(handle as number);
  }
  pending(): number {
    return this.tasks.size;
  }
  advance(ms: number): void {
    const target = this.nowMs + ms;
    // Fire in due order, allowing rescheduling (chained ticks).
    for (;;) {
      const due = [...this.tasks.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.nowMs = due[1].at;
      this.tasks.delete(due[0]);
      due[1].fn();
    }
    this.nowMs = target;
  }
}

interface Harness {
  events: ConnectionEvent[];
  win: FakeTarget;
  doc: FakeTarget;
  timers: VirtualTimers;
  ticks: number;
  dailies: number;
}

/** Controllable fake of the plugin's ConnectivityManager source (CDX-027). */
function fakeNative(opts: { supported?: boolean; online?: boolean; failWatch?: boolean } = {}) {
  let emit: ((online: boolean) => void) | null = null;
  const counters = { gets: 0, watches: 0, unwatches: 0 };
  const source: NativeConnectivitySource = {
    get: async () => {
      counters.gets++;
      return { supported: opts.supported ?? true, online: opts.online ?? true };
    },
    watch: async (onChange) => {
      if (opts.failWatch) throw new Error('watch failed');
      counters.watches++;
      emit = onChange;
      return () => {
        counters.unwatches++;
        emit = null;
      };
    },
  };
  return {
    source,
    counters,
    emit: (online: boolean) => emit?.(online),
    watching: () => emit !== null,
  };
}

/** Let the native get()/watch() promise chain settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function attach(overrides: {
  visibility?: () => string;
  online?: () => boolean;
  tauriListen?: (event: string, handler: () => void) => Promise<() => void>;
  native?: NativeConnectivitySource;
  dispatch?: (e: ConnectionEvent) => void;
  withDaily?: boolean;
} = {}) {
  const h: Harness = {
    events: [],
    win: new FakeTarget(),
    doc: new FakeTarget(),
    timers: new VirtualTimers(),
    ticks: 0,
    dailies: 0,
  };
  const handle = attachConnectivity({
    dispatch: (e) => {
      h.events.push(e);
      overrides.dispatch?.(e);
    },
    windowTarget: h.win,
    documentTarget: h.doc,
    visibilityState: overrides.visibility ?? (() => 'visible'),
    isOnline: overrides.online ?? (() => true),
    ...(overrides.native ? { native: overrides.native } : {}),
    ...(overrides.tauriListen ? { tauriListen: overrides.tauriListen } : {}),
    timers: h.timers,
    onTick: () => h.ticks++,
    tickIntervalMs: 1_000,
    ...(overrides.withDaily !== false ? { onDaily: () => h.dailies++ } : {}),
    dailyIntervalMs: 10_000,
  });
  return { h, handle };
}

describe('attachConnectivity', () => {
  it('forwards online/offline window events', () => {
    const { h } = attach();
    h.win.fire('offline');
    h.win.fire('online');
    expect(h.events).toEqual([{ type: 'offline' }, { type: 'online' }]);
  });

  it('reports boot-time offline immediately', () => {
    const { h } = attach({ online: () => false });
    expect(h.events).toEqual([{ type: 'offline' }]);
  });

  it('forwards visibilitychange with the current visibility', () => {
    let vis = 'visible';
    const { h } = attach({ visibility: () => vis });
    vis = 'hidden';
    h.doc.fire('visibilitychange');
    vis = 'visible';
    h.doc.fire('visibilitychange');
    expect(h.events).toEqual([
      { type: 'visibility', visible: false },
      { type: 'visibility', visible: true },
    ]);
  });

  it('maps Tauri resume/focus events to FSM resume', async () => {
    const handlers = new Map<string, () => void>();
    const { h } = attach({
      tauriListen: (event, handler) => {
        handlers.set(event, handler);
        return Promise.resolve(() => handlers.delete(event));
      },
    });
    await Promise.resolve(); // let the listen promises settle
    expect([...handlers.keys()]).toEqual([...DEFAULT_TAURI_RESUME_EVENTS]);
    handlers.get('tauri://resume')!();
    handlers.get('tauri://focus')!();
    expect(h.events).toEqual([{ type: 'resume' }, { type: 'resume' }]);
  });

  it('a rejected tauriListen (event unsupported) is swallowed', async () => {
    const { h } = attach({ tauriListen: () => Promise.reject(new Error('nope')) });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.events).toEqual([]);
  });

  it('drives the periodic tick and the daily tick on the Timers port', () => {
    const { h } = attach();
    h.timers.advance(3_000);
    expect(h.ticks).toBe(3);
    expect(h.dailies).toBe(0);
    h.timers.advance(7_000); // t=10s: daily fires once
    expect(h.ticks).toBe(10);
    expect(h.dailies).toBe(1);
    h.timers.advance(10_000);
    expect(h.dailies).toBe(2);
  });

  it('detach removes listeners, cancels timers, and stops tauri handlers', async () => {
    const handlers = new Map<string, () => void>();
    const { h, handle } = attach({
      tauriListen: (event, handler) => {
        handlers.set(event, handler);
        return Promise.resolve(() => handlers.delete(event));
      },
    });
    await Promise.resolve();
    handle.detach();
    handle.detach(); // idempotent
    expect(h.win.count('online')).toBe(0);
    expect(h.win.count('offline')).toBe(0);
    expect(h.doc.count('visibilitychange')).toBe(0);
    expect(handlers.size).toBe(0); // unlistened
    h.timers.advance(60_000);
    expect(h.ticks).toBe(0);
    expect(h.dailies).toBe(0);
    expect(h.events).toEqual([]);
  });

  it('an unlisten resolving AFTER detach is immediately unlistened', async () => {
    let resolveListen: ((unlisten: () => void) => void) | null = null;
    let unlistened = 0;
    const { handle } = attach({
      tauriListen: () =>
        new Promise<() => void>((resolve) => {
          resolveListen ??= resolve;
        }),
    });
    handle.detach();
    resolveListen!(() => unlistened++);
    await Promise.resolve();
    await Promise.resolve();
    expect(unlistened).toBe(1);
  });
});

describe('native connectivity source (CDX-027)', () => {
  it('supported native source replaces the window listeners and its events reach dispatch', async () => {
    const native = fakeNative({ supported: true, online: true });
    const { h } = attach({ native: native.source });
    await settle();

    // Handover complete: window online/offline listeners are gone, the
    // native snapshot truth was dispatched.
    expect(h.win.count('online')).toBe(0);
    expect(h.win.count('offline')).toBe(0);
    expect(native.watching()).toBe(true);
    expect(h.events).toEqual([{ type: 'online' }]);

    // Browser events are dead (Android WebView never fires them anyway).
    h.win.fire('offline');
    expect(h.events).toEqual([{ type: 'online' }]);

    // Native changes flow through.
    native.emit(false);
    native.emit(true);
    expect(h.events).toEqual([{ type: 'online' }, { type: 'offline' }, { type: 'online' }]);
  });

  it('a native boot snapshot of offline dispatches offline at handover', async () => {
    const native = fakeNative({ supported: true, online: false });
    const { h } = attach({ native: native.source });
    await settle();
    expect(h.events).toEqual([{ type: 'offline' }]);
  });

  it('an unsupported snapshot (desktop) keeps the browser fallback', async () => {
    const native = fakeNative({ supported: false });
    const { h } = attach({ native: native.source });
    await settle();
    expect(native.counters.watches).toBe(0);
    expect(h.win.count('online')).toBe(1);
    h.win.fire('offline');
    expect(h.events).toEqual([{ type: 'offline' }]);
  });

  it('a failing watch keeps the browser fallback attached', async () => {
    const native = fakeNative({ supported: true, failWatch: true });
    const { h } = attach({ native: native.source });
    await settle();
    expect(h.win.count('online')).toBe(1);
    h.win.fire('online');
    expect(h.events).toEqual([{ type: 'online' }]);
  });

  it('detach unwatches the native source and silences later emits', async () => {
    const native = fakeNative({ supported: true, online: true });
    const { h, handle } = attach({ native: native.source });
    await settle();
    handle.detach();
    handle.detach(); // idempotent
    expect(native.counters.unwatches).toBe(1);
    native.emit(false);
    expect(h.events).toEqual([{ type: 'online' }]); // nothing after detach
  });

  it('a snapshot resolving AFTER detach never watches; a watch resolving after detach is unwatched', async () => {
    // get() lands after detach → watch must never start.
    let resolveGet: ((snap: { supported: boolean; online: boolean }) => void) | null = null;
    let watches = 0;
    const lateGet: NativeConnectivitySource = {
      get: () =>
        new Promise((resolve) => {
          resolveGet = resolve;
        }),
      watch: async () => {
        watches++;
        return () => {};
      },
    };
    const first = attach({ native: lateGet });
    first.handle.detach();
    resolveGet!({ supported: true, online: true });
    await settle();
    expect(watches).toBe(0);
    expect(first.h.events).toEqual([]);

    // watch() lands after detach → immediately unwatched, no dispatch.
    let resolveWatch: ((unwatch: () => void) => void) | null = null;
    let unwatched = 0;
    const lateWatch: NativeConnectivitySource = {
      get: async () => ({ supported: true, online: true }),
      watch: () =>
        new Promise((resolve) => {
          resolveWatch = resolve;
        }),
    };
    const second = attach({ native: lateWatch });
    await settle(); // get() resolved; watch() pending
    second.handle.detach();
    resolveWatch!(() => unwatched++);
    await settle();
    expect(unwatched).toBe(1);
    expect(second.h.events).toEqual([]);
  });

  it('drives a REAL connection FSM to offline (no backoff burn) and back', async () => {
    const connTimers = new VirtualTimers();
    const opened: number[] = [];
    let closes = 0;
    const store = createConnectionStore({
      timers: connTimers,
      now: () => 0,
      random: () => 0.5,
      handlers: {
        openSocket: () => opened.push(opened.length),
        closeSocket: () => closes++,
        refreshAndReconcile: () => {},
      },
    });
    const native = fakeNative({ supported: true, online: true });
    attach({ native: native.source, dispatch: (e) => store.getState().dispatch(e) });
    await settle();

    store.getState().dispatch({ type: 'connect-requested' });
    store.getState().dispatch({ type: 'socket-open', at: 0 });
    expect(store.getState().status).toBe('connected');

    // Airplane mode: the native source is the ONLY thing that can say so.
    native.emit(false);
    expect(store.getState().status).toBe('offline');
    expect(serviceNotificationText(store.getState().status)).toBe('No network — waiting');
    // No retry timer burns against the dead radio.
    expect(connTimers.pending()).toBe(0);
    void closes;

    // Radio back: reconnect immediately, not on a backoff schedule.
    native.emit(true);
    expect(store.getState().status).toBe('connecting');
    expect(opened.length).toBeGreaterThanOrEqual(2);
  });
});
