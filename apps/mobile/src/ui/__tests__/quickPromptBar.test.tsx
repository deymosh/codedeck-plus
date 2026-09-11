// @vitest-environment jsdom
/**
 * Quick prompt bar (CDX-049) — the user's labeled shortcuts render directly
 * above the session input bar; a tap INSERTS the prompt text into the draft
 * (appending to what's already typed, never auto-sending), and an empty list
 * hides the bar entirely (the legacy QuickPromptBar contract).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { buildFakePhoneCore } from '../../core/__tests__/nativeCoreFixture';
import type { PhoneCore } from '../../core/phoneCore';
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

async function makeCore(
  prompts: Array<{ id: string; label: string; text: string }> = [],
): Promise<PhoneCore> {
  const { phone } = await buildFakePhoneCore({
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
                title: null,
                project: 'proj-s1',
              },
              presence: 'live',
              lastListedAt: Date.now(),
            },
          },
        },
      },
    },
    quickPrompts: { prompts },
  });
  return phone;
}

function renderSession(core: PhoneCore) {
  return render(
    <PhoneCoreProvider value={core}>
      <SessionScreen machinePubkey={MACHINE} sessionId="s1" />
    </PhoneCoreProvider>,
  );
}

describe('quick prompt bar (CDX-049)', () => {
  it('no prompts defined → no bar at all', async () => {
    const core = await makeCore();
    renderSession(core);
    expect(screen.queryByTestId('quick-prompt-bar')).toBeNull();
  });

  it('renders one labeled box per prompt, above the input bar', async () => {
    const core = await makeCore([
      { id: 'p1', label: 'Continue', text: 'Keep going.' },
      { id: 'p2', label: 'Tests', text: 'Run the tests.' },
    ]);
    renderSession(core);

    const bar = screen.getByTestId('quick-prompt-bar');
    const labels = [...bar.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toEqual(['Continue', 'Tests']);
    // Directly ABOVE the composer: the bar precedes the input bar in the DOM.
    const textarea = screen.getByPlaceholderText('Message the session…');
    expect(
      bar.compareDocumentPosition(textarea) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('tap inserts into an empty draft and APPENDS to an existing one — never sends', async () => {
    const core = await makeCore([{ id: 'p1', label: 'Continue', text: 'Keep going.' }]);
    const send = vi.spyOn(core.outbox.getState(), 'send');
    renderSession(core);

    const textarea = screen.getByPlaceholderText('Message the session…') as HTMLTextAreaElement;
    fireEvent.click(screen.getByText('Continue'));
    expect(textarea.value).toBe('Keep going.');

    // Existing draft → appended with a single separating space.
    fireEvent.change(textarea, { target: { value: 'First do X.  ' } });
    fireEvent.click(screen.getByText('Continue'));
    expect(textarea.value).toBe('First do X. Keep going.');

    expect(send).not.toHaveBeenCalled();
  });
});
