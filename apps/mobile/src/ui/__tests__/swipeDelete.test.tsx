// @vitest-environment jsdom
/**
 * Phase 3 swipe-to-delete UI: the ported swipe hook on Sidebar session cards
 * (sub-threshold snaps back, vertical scroll never triggers, ≥80px commits
 * with the slide-out) and the UndoToast (delete shows it, Undo restores the
 * card in the sidebar).
 *
 * The undo WINDOW itself — the 4s timer, the optimistic remove, restoring on
 * undo, closing the session for real once the window lapses — is
 * `client_runtime::Core`'s job now (`Intent::DeleteSession`/`UndoDelete`,
 * `on_undo_timer`; see `crates/client-runtime`'s own tests for that FSM,
 * including the regression test for the undo toast clearing itself when the
 * window expires untapped). What this file still owns is the swipe gesture
 * and the toast's render/wiring — so each scenario scripts the fake core's
 * `deleteSession`/`undoDelete` dispatch to do what Rust would, then asserts
 * the UI reacted correctly.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { buildFakePhoneCore, tick } from '../../core/__tests__/nativeCoreFixture';
import type { PhoneCore } from '../../core/phoneCore';
import { PhoneCoreProvider } from '../coreContext';
import { Sidebar } from '../Sidebar';
import { UndoToast } from '../UndoToast';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const MACHINE = 'a'.repeat(64);

async function makeCore(): Promise<{ phone: PhoneCore; fake: Awaited<ReturnType<typeof buildFakePhoneCore>>['fake'] }> {
  const { phone, fake } = await buildFakePhoneCore({
    machines: {
      machines: {
        [MACHINE]: {
          pubkeyHex: MACHINE,
          name: 'laptop',
          capabilities: [],
          folders: [],
          roots: [],
          machineOffline: false,
          sessions: {
            s1: {
              info: {
                id: 's1',
                slug: 's1',
                cwd: '/home/x/s1',
                lastActivity: '2026-08-08T10:00:00.000Z',
                lineCount: 0,
                title: 'One',
                project: 'proj-s1',
              },
              presence: 'live',
              lastListedAt: Date.now(),
            },
          },
        },
      },
    },
  });

  // Scripts the optimistic-delete + undo-toast half of `Intent::DeleteSession`
  // and `undoDelete`'s restore, the way `client_runtime::Core` really behaves
  // — the fixture itself stays dumb (see nativeCoreFixture.ts's module doc).
  const machineView = fake.views.machines.machines[MACHINE]!;
  const savedSession = machineView.sessions['s1']!;
  fake.onDispatch((intent) => {
    if (typeof intent === 'object' && 'deleteSession' in intent) {
      const { sessionId, label } = intent.deleteSession;
      const { [sessionId]: _removed, ...rest } = machineView.sessions;
      fake.setView('machines', {
        machines: { [MACHINE]: { ...machineView, sessions: rest } },
      });
      fake.setView('ui', { ...fake.views.ui, undoToast: { machine: MACHINE, sessionId, label: label ?? '' } });
    } else if (intent === 'undoDelete') {
      fake.setView('machines', {
        machines: { [MACHINE]: { ...machineView, sessions: { ...machineView.sessions, s1: savedSession } } },
      });
      fake.setView('ui', { ...fake.views.ui, undoToast: null });
    }
  });

  return { phone, fake };
}

const noop = (): void => {};

function renderSidebar(core: PhoneCore) {
  return render(
    <PhoneCoreProvider value={core}>
      <Sidebar onOpenSettings={noop} onOpenPairing={noop} />
      <UndoToast />
    </PhoneCoreProvider>,
  );
}

const touch = (x: number, y: number) => ({ touches: [{ clientX: x, clientY: y }] });

/** Swipe horizontally from (200, 50) by dx, then release. */
function swipe(el: Element, dx: number): void {
  fireEvent.touchStart(el, touch(200, 50));
  fireEvent.touchMove(el, touch(200 + dx, 50));
  fireEvent.touchEnd(el);
}

describe('swipe-to-delete on session cards', () => {
  it('sub-threshold swipe snaps back — no delete, no toast', async () => {
    const { phone } = await makeCore();
    vi.useFakeTimers();
    renderSidebar(phone);

    const card = screen.getByTestId('session-card');
    swipe(card, -50);

    expect((card as HTMLElement).style.transform).toBe('translateX(0)');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByTestId('session-card')).toBeTruthy();
    expect(screen.queryByTestId('undo-toast')).toBeNull();
  });

  it('vertical scroll never triggers the swipe', async () => {
    const { phone } = await makeCore();
    vi.useFakeTimers();
    renderSidebar(phone);

    const card = screen.getByTestId('session-card');
    fireEvent.touchStart(card, touch(200, 50));
    fireEvent.touchMove(card, touch(160, 150)); // dy dominates dx
    fireEvent.touchEnd(card);

    expect((card as HTMLElement).style.transform).toBe('');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByTestId('session-card')).toBeTruthy();
    expect(screen.queryByTestId('undo-toast')).toBeNull();
  });

  it('≥80px swipe slides out, deletes the card, and shows the undo toast', async () => {
    const { phone, fake } = await makeCore();
    vi.useFakeTimers();
    renderSidebar(phone);

    const card = screen.getByTestId('session-card');
    swipe(card, -100);

    // Slide-out armed, delete not fired yet.
    expect((card as HTMLElement).style.transform).toBe('translateX(-100%)');
    expect(fake.dispatched).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(screen.queryByTestId('session-card')).toBeNull();
    expect(fake.dispatched).toContainEqual({
      deleteSession: { machine: MACHINE, sessionId: 's1', label: 'One' },
    });
    const toast = screen.getByTestId('undo-toast');
    expect(toast.textContent).toContain('Deleted "One"');
  });

  it('Undo within the window brings the card back into the sidebar', async () => {
    const { phone, fake } = await makeCore();
    vi.useFakeTimers();
    renderSidebar(phone);

    swipe(screen.getByTestId('session-card'), -120);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.queryByTestId('session-card')).toBeNull();

    fireEvent.click(screen.getByText('Undo'));
    await act(async () => {
      await tick();
    });

    expect(screen.getByTestId('session-card').textContent).toContain('One');
    expect(screen.queryByTestId('undo-toast')).toBeNull();
    expect(fake.dispatched).toContain('undoDelete');
  });
});
