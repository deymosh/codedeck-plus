// @vitest-environment jsdom
/**
 * Phase 5 (CDX-029): session composer image attach — the clip button is gated
 * on the machine advertising the `images` capability (sessions heartbeat →
 * machines store), staging shows the strip, and Send dispatches
 * `Intent::SendSessionImage` with the processed image + draft, clearing both
 * on success.
 *
 * The Blossom-upload-then-chunk-fallback orchestration this file used to
 * exercise directly (`BridgeApiLike.uploadImageBlossom`/`uploadImageChunk`,
 * an abortable in-flight PUT, an "unconfirmed" relay verdict) is Rust's job
 * now, entirely behind the single `sendSessionImageNative` dispatch — see
 * `Intent::SendSessionImage`'s own tests in `crates/client-runtime` for that
 * coverage. What is left worth testing here is: the capability gate, staging/
 * clearing the strip, the exact dispatch payload, and that a file READ
 * failure (still a DOM-bound, phone-side concern — `imageFile.ts`) leaves the
 * composer recoverable — CDX-068/CDX-086 never touched the network stage.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { buildFakePhoneCore } from '../../core/__tests__/nativeCoreFixture';
import { PhoneCoreProvider } from '../coreContext';
import { SessionScreen } from '../screens/SessionScreen';
import type { PhoneCore } from '../../core/phoneCore';
import * as imageFile from '../imageFile';

// Keep the real sendWithImage orchestration; only the DOM-bound file
// processing (FileReader + Image decode, which jsdom cannot do) is stubbed.
vi.mock('../imageFile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../imageFile')>()),
  processImageFile: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.mocked(imageFile.processImageFile).mockReset();
});

// virtua (TranscriptView) needs ResizeObserver; jsdom has none. Phase 8:
// SessionScreen's attention chevrons read matchMedia — give jsdom one
// (fine pointer; chevrons/swiping aren't under test here).
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

async function makeCore(capabilities: string[]): Promise<PhoneCore> {
  const { phone } = await buildFakePhoneCore({
    machines: {
      machines: {
        [MACHINE]: {
          pubkeyHex: MACHINE,
          name: 'laptop',
          capabilities,
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

describe('attach button capability gating', () => {
  it('machine advertising `images` → clip button + hidden file input render', async () => {
    const core = await makeCore(['images']);
    renderSession(core);
    expect(screen.getByLabelText('Attach image')).toBeTruthy();
    expect(screen.getByTestId('session-file-input')).toBeTruthy();
  });

  it('machine without `images` → no attach affordance at all', async () => {
    const core = await makeCore(['something-else']);
    renderSession(core);
    expect(screen.queryByLabelText('Attach image')).toBeNull();
    expect(screen.queryByTestId('session-file-input')).toBeNull();
  });
});

describe('staged attachment → send', () => {
  it('staging shows the strip; ✕ clears it', async () => {
    const core = await makeCore(['images']);
    renderSession(core);

    const file = new File([new Uint8Array([1, 2, 3])], 'cat.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('session-file-input'), { target: { files: [file] } });

    const strip = screen.getByTestId('session-attach-strip');
    expect(strip.textContent).toContain('cat.png');
    expect(strip.textContent).toContain('KB');

    fireEvent.click(screen.getByLabelText('Remove attachment'));
    expect(screen.queryByTestId('session-attach-strip')).toBeNull();
  });

  it('Send dispatches Intent::SendSessionImage with the draft text, then clears both', async () => {
    const core = await makeCore(['images']);
    vi.mocked(imageFile.processImageFile).mockResolvedValue({
      base64: 'QUJD',
      mimeType: 'image/png',
      filename: 'cat.png',
      sizeBytes: 3,
    });
    const sendNative = vi.spyOn(core, 'sendSessionImageNative').mockResolvedValue(undefined);
    renderSession(core);

    const file = new File([new Uint8Array([1, 2, 3])], 'cat.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('session-file-input'), { target: { files: [file] } });
    fireEvent.change(screen.getByPlaceholderText('Message the session…'), {
      target: { value: 'what is this?' },
    });
    fireEvent.click(screen.getByText('Send'));

    await waitFor(() => expect(sendNative).toHaveBeenCalledOnce());
    const [params] = sendNative.mock.calls[0]!;
    expect(params.machine).toBe(MACHINE);
    expect(params.sessionId).toBe('s1');
    expect(params.text).toBe('what is this?');
    expect(params.filename).toBe('cat.png');
    expect(params.mimeType).toBe('image/png');
    expect(Array.from(params.image)).toEqual([65, 66, 67]); // 'QUJD' → 'ABC'

    await waitFor(() => expect(screen.queryByTestId('session-attach-strip')).toBeNull());
    expect(
      (screen.getByPlaceholderText('Message the session…') as HTMLTextAreaElement).value,
    ).toBe('');
  });

  it('a dispatch failure shows the inline error and keeps draft + staged image', async () => {
    const core = await makeCore(['images']);
    vi.mocked(imageFile.processImageFile).mockResolvedValue({
      base64: 'QUJD',
      mimeType: 'image/png',
      filename: 'cat.png',
      sizeBytes: 3,
    });
    vi.spyOn(core, 'sendSessionImageNative').mockRejectedValue(new Error('dispatch failed'));
    renderSession(core);

    const file = new File([new Uint8Array([1, 2, 3])], 'cat.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('session-file-input'), { target: { files: [file] } });
    fireEvent.change(screen.getByPlaceholderText('Message the session…'), {
      target: { value: 'keep me' },
    });
    fireEvent.click(screen.getByText('Send'));

    const banner = await screen.findByTestId('session-upload-failed');
    expect(banner.textContent).toContain('Image upload failed');
    expect(screen.getByTestId('session-attach-strip')).toBeTruthy(); // still staged
    expect(
      (screen.getByPlaceholderText('Message the session…') as HTMLTextAreaElement).value,
    ).toBe('keep me');
  });

  /**
   * CDX-068 — the composer must always be escapable. Pre-fix a file read that
   * stalled (a `content://` provider that fires neither onload nor onerror)
   * never reached `sendWithImage`'s `finally`, so `uploading` stayed true
   * forever: spinner pinned, ✕ `disabled={uploading}`, Send disabled. The only
   * way out was leaving the screen. Purely a `processImageFile` (DOM read)
   * concern — untouched by where the send dispatch ends up.
   */
  it('a read that never comes back: ✕ stays live, clears the wedge, and the abandoned send dispatches nothing', async () => {
    const core = await makeCore(['images']);
    let failRead: (err: Error) => void = () => {};
    vi.mocked(imageFile.processImageFile).mockImplementation(
      () =>
        new Promise<never>((_resolve, reject) => {
          failRead = reject;
        }),
    );
    const sendNative = vi.spyOn(core, 'sendSessionImageNative').mockResolvedValue(undefined);
    renderSession(core);

    const file = new File([new Uint8Array([1, 2, 3])], 'cat.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('session-file-input'), { target: { files: [file] } });
    fireEvent.change(screen.getByPlaceholderText('Message the session…'), {
      target: { value: 'describe this' },
    });
    fireEvent.click(screen.getByText('Send'));

    // Wedged mid-read: spinner up, Send disabled — but ✕ must NOT be.
    await waitFor(() =>
      expect(screen.getByTestId('session-attach-strip').textContent).toContain('uploading…'),
    );
    expect((screen.getByText('Send') as HTMLButtonElement).disabled).toBe(true);
    const remove = screen.getByLabelText('Remove attachment') as HTMLButtonElement;
    expect(remove.disabled).toBe(false); // pre-fix: true, and true forever

    fireEvent.click(remove);
    expect(screen.queryByTestId('session-attach-strip')).toBeNull();
    await waitFor(() => expect((screen.getByText('Send') as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByLabelText('Attach image') as HTMLButtonElement).disabled).toBe(false);

    // The abandoned read finally dies: no banner about an attachment the user
    // already dropped, no draft wipe, and nothing was ever dispatched.
    failRead(new Error('Failed to read file (TimeoutError: File.arrayBuffer timed out after 30000 ms)'));
    await waitFor(() =>
      expect((screen.getByText('Send') as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.queryByTestId('session-upload-failed')).toBeNull();
    expect(
      (screen.getByPlaceholderText('Message the session…') as HTMLTextAreaElement).value,
    ).toBe('describe this');
    expect(sendNative).not.toHaveBeenCalled();
  });

  it('a timed-out read surfaces the named timeout in the banner and leaves the composer usable', async () => {
    const core = await makeCore(['images']);
    vi.mocked(imageFile.processImageFile).mockRejectedValue(
      new Error(
        'Failed to read file (TimeoutError: File.arrayBuffer timed out after 30000 ms; FileReader fallback: TimeoutError: FileReader.readAsArrayBuffer timed out after 5000 ms)',
      ),
    );
    renderSession(core);

    const file = new File([new Uint8Array([1, 2, 3])], 'cat.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('session-file-input'), { target: { files: [file] } });
    fireEvent.change(screen.getByPlaceholderText('Message the session…'), {
      target: { value: 'keep me' },
    });
    fireEvent.click(screen.getByText('Send'));

    const banner = await screen.findByTestId('session-upload-failed');
    expect(banner.textContent).toContain('Image upload failed: Failed to read file');
    expect(banner.textContent).toContain('TimeoutError'); // diagnosable, not a bare stall
    // Composer is live again, the attachment is still staged, and it can go.
    expect((screen.getByText('Send') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('session-attach-strip')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Remove attachment'));
    expect(screen.queryByTestId('session-attach-strip')).toBeNull();
    expect(
      (screen.getByPlaceholderText('Message the session…') as HTMLTextAreaElement).value,
    ).toBe('keep me');
  });
});
