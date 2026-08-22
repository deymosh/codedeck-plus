// @vitest-environment jsdom
/**
 * CDX-045 — the session top bar reads as ONE system of rectangular boxes, the
 * old app's language (`codedeck/src/components/UsageBadge.tsx` +
 * `src/styles/header.css`), not the rounded pills 0.9.0 shipped.
 *
 * The shape itself is CSS, and vitest runs with `css: false` (no layout engine,
 * no computed styles), so the honest host assertions are structural: usage is
 * ONE box with a row per reported window (the old two-row chip) carrying a
 * worst-window severity; the context figure is its own box rather than the
 * shared `.badge` pill primitive; and the remaining header chips carry the
 * local square class alongside their semantic badge class. The rendered corner
 * radius is a device oracle (run-sheet §13 step 18).
 *
 * `usageFormat.ts` is deliberately untouched by CDX-045 — its text/tooltip
 * output is asserted in usageFormat.test.ts and is reused verbatim here.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { RemoteSessionInfo, SessionListMessage, UsageData } from '@codedeck/protocol';
import { createPhoneCore, type PhoneCore } from '../../core/createPhoneCore';
import { memoryKV, type PhoneTransport } from '../../core/ports';
import { PhoneCoreProvider } from '../coreContext';
import { SessionScreen } from '../screens/SessionScreen';

afterEach(cleanup);

// virtua (TranscriptView) needs ResizeObserver; the attention chevrons read
// matchMedia. jsdom has neither — neither is under test here.
beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    class RO {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    (globalThis as Record<string, unknown>)['ResizeObserver'] = RO;
  }
  (window as unknown as Record<string, unknown>)['matchMedia'] = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
});

const MACHINE = 'a'.repeat(64);

const nullTransport: PhoneTransport = {
  subscribe: () => ({ close: () => {} }),
  publish: async () => true,
};

const sessionInfo = (over: Partial<RemoteSessionInfo> = {}): RemoteSessionInfo => ({
  id: 's1',
  slug: 's1',
  cwd: '/home/x/s1',
  lastActivity: '2026-08-08T10:00:00.000Z',
  lineCount: 0,
  title: null,
  project: 'proj-s1',
  ...over,
});

/** A snapshot with both subscription windows reported at the given percentages. */
const usageData = (fiveHour: number, sevenDay: number): UsageData => ({
  available: true,
  subscriptionType: 'max',
  fiveHour: { utilization: fiveHour, resetsAt: null },
  sevenDay: { utilization: sevenDay, resetsAt: null },
  fetchedAt: '2026-08-08T10:00:00.000Z',
});

async function makeCore(
  info: Partial<RemoteSessionInfo> = {},
  usage?: UsageData,
): Promise<PhoneCore> {
  const core = await createPhoneCore({ kv: memoryKV(), transport: nullTransport });
  core.machines.getState().registerMachine({ pubkeyHex: MACHINE, name: 'laptop' });
  const heartbeat: SessionListMessage = {
    type: 'sessions',
    machine: 'laptop',
    sessions: [sessionInfo(info)],
    protocolVersion: 10,
  };
  core.machines.getState().applySessionList(MACHINE, heartbeat, Date.now());
  if (usage) core.machines.getState().applyUsage(MACHINE, 's1', usage);
  return core;
}

function renderSession(core: PhoneCore) {
  return render(
    <PhoneCoreProvider value={core}>
      <SessionScreen machinePubkey={MACHINE} sessionId="s1" />
    </PhoneCoreProvider>,
  );
}

describe('session header chrome — rectangular boxes (CDX-045)', () => {
  it('usage is ONE box with a row per reported window (the old two-row chip)', async () => {
    const core = await makeCore({}, usageData(42, 61));
    renderSession(core);

    // Pre-fix: two INDEPENDENT sibling pills sat in the header, one per window.
    const box = screen.getByTestId('usage-box');
    const rows = screen.getAllByTestId('usage-badge');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.textContent)).toEqual(['5h 42%', '7d 61%']);
    for (const row of rows) expect(box.contains(row)).toBe(true);
  });

  it('the box takes the worst window: ok < 75 ≤ warn < 90 ≤ critical', async () => {
    for (const [fiveHour, sevenDay, severity] of [
      [42, 61, 'ok'],
      [42, 78, 'warn'], // the WORST window decides, not the first
      [81, 12, 'warn'],
      [42, 95, 'critical'],
    ] as const) {
      const core = await makeCore({}, usageData(fiveHour, sevenDay));
      renderSession(core);
      expect(screen.getByTestId('usage-box').getAttribute('data-severity')).toBe(severity);
      cleanup();
    }
  });

  it('Settings → "Show usage badge" OFF hides the usage box; ON restores it (CDX-048)', async () => {
    const core = await makeCore({}, usageData(42, 61));
    core.settings.getState().setShowUsageBadge(false);
    renderSession(core);
    expect(screen.queryByTestId('usage-box')).toBeNull();
    cleanup();

    core.settings.getState().setShowUsageBadge(true);
    renderSession(core);
    expect(screen.getByTestId('usage-box')).toBeTruthy();
  });

  it('no usage snapshot → no usage box at all (nothing empty is rendered)', async () => {
    const core = await makeCore();
    renderSession(core);
    expect(screen.queryByTestId('usage-box')).toBeNull();
    expect(screen.queryAllByTestId('usage-badge')).toHaveLength(0);
  });

  it('the context figure is its own box, not the shared pill primitive', async () => {
    const core = await makeCore({
      contextPercentage: 42,
      contextWindow: 200_000,
      model: 'claude-opus-5',
    });
    renderSession(core);

    const ctx = screen.getByTestId('ctx-badge');
    // CDX-087: the model tag leads the badge and the "ctx " prefix is gone —
    // this is the old app's `O5 · 42%` rectangle, with the used/total figure
    // this app additionally has.
    expect(ctx.textContent).toBe('O5 · 42% · 84k/200k');
    // The shared `.badge` primitive is what carries --radius-pill; the context
    // box must not be built from it (it used to be). Class names are hashed by
    // the CSS-modules transform, so match the local-name segment.
    expect(ctx.className).not.toMatch(/\bbadge/i);
    expect(ctx.className).toMatch(/ctxBox/);
  });

  // CDX-087: the founder's report was "somewhere we actually lost the model
  // indicator". The header select was removed on purpose (CDX-044 — the model
  // is chosen once, at session start); the read-only label went with it by
  // accident when the old app's rectangle was ported context-only.
  it('the model tag renders for an explicitly-chosen model', async () => {
    const core = await makeCore({ model: 'claude-haiku-4-5-20251001', contextPercentage: 7 });
    renderSession(core);
    expect(screen.getByTestId('model-tag').textContent).toBe('H4.5');
    expect(screen.getByTestId('ctx-badge').textContent).toBe('H4.5 · 7%');
  });

  it('a 1M-context variant still tags as its base model', async () => {
    // The old app had no table row for these, so `claude-opus-5[1m]` rendered as
    // `opus-5[1m]`. The 1M-ness is legible in the context figure beside it.
    const core = await makeCore({
      model: 'claude-opus-5[1m]',
      contextPercentage: 9,
      contextWindow: 1_000_000,
    });
    renderSession(core);
    expect(screen.getByTestId('ctx-badge').textContent).toBe('O5 · 9% · 90k/1M');
  });

  it('a session whose model the bridge never reported degrades to ? and says why', async () => {
    const core = await makeCore({ contextPercentage: 42 });
    renderSession(core);
    expect(screen.getByTestId('model-tag').textContent).toBe('?');
    // Honest rather than guessing. The bridge capturing init.model is what makes
    // this rare — before that, EVERY default-model session landed here.
    expect(screen.getByTestId('ctx-badge').getAttribute('title')).toMatch(/not reported/i);
  });

  it('the remaining header chips are squared off while keeping their semantic color', async () => {
    const core = await makeCore({ state: 'running', permissionMode: 'acceptEdits' });
    renderSession(core);

    // `boxed` is the local square-off class; the semantic badge class stays, so
    // running is still emphasized and waiting states still warn.
    const stateChip = screen.getByText('running');
    expect(stateChip.className).toMatch(/boxed/);
    expect(stateChip.className).toMatch(/badgeRunning/);

    // CDX-046 made the mode chip a tappable cycle button (label EDITS, not the
    // raw enum value) — still squared off, still on the badge primitive.
    const modeChip = screen.getByTestId('mode-button');
    expect(modeChip.textContent).toBe('EDITS');
    expect(modeChip.className).toMatch(/boxed/);
    expect(modeChip.className).toMatch(/badge/);

    // The connection chip too — the whole bar, not a subset.
    const connChip = screen.getByText(core.connection.getState().status);
    expect(connChip.className).toMatch(/boxed/);
    expect(connChip.className).toMatch(/badge/);
  });
});

describe('session header — full stored title surface (CDX-059)', () => {
  it('renders the stored title IN FULL — the 80-char rule finally has a device observable', async () => {
    // Exactly what titleFromFirstMessage / the bridge runner store for a
    // >80-char first message: 77 chars + '...' — 80 total. The sidebar card
    // CSS-truncates at ~30 chars; this surface must not.
    const stored = 'R'.repeat(77) + '...';
    const core = await makeCore({ title: stored });
    renderSession(core);

    const el = screen.getByTestId('session-full-title');
    expect(el.textContent).toBe(stored);
    expect(el.textContent).toHaveLength(80);
    // The observable itself: the stored ellipsis at the exact boundary.
    expect(el.textContent!.endsWith('...')).toBe(true);
  });

  it('a short title renders verbatim; no title renders nothing (no empty span)', async () => {
    const core = await makeCore({ title: 'Fix the login bug' });
    renderSession(core);
    expect(screen.getByTestId('session-full-title').textContent).toBe('Fix the login bug');
    cleanup();

    const untitled = await makeCore({ title: null });
    renderSession(untitled);
    expect(screen.queryByTestId('session-full-title')).toBeNull();
  });
});
