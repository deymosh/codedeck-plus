// @vitest-environment jsdom
/**
 * Phase 5 (CDX-029): session composer image attach — the clip button is gated on the
 * machine advertising the `images` capability (sessions heartbeat →
 * machines store), staging shows the strip, and Send routes the processed
 * image + draft through api.uploadImageBlossom, clearing both on success.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { RemoteSessionInfo, SessionListMessage } from '@codedeck/protocol';
import { createPhoneCore, type PhoneCore } from '../../core/createPhoneCore';
import { memoryKV, type PhoneTransport } from '../../core/ports';
import { PhoneCoreProvider } from '../coreContext';
import { SessionScreen } from '../screens/SessionScreen';
import * as dmImages from '../../platform/dmImages';
import * as imageFile from '../imageFile';

vi.mock('../../platform/dmImages', () => ({
  DEFAULT_BLOSSOM_SERVER: 'https://blossom.descendant.io',
  resolvePlatformFetch: vi.fn(async () => fetch),
  uploadDmImage: vi.fn(),
  fetchDecryptedImage: vi.fn(async () => null),
}));

// Keep the real sendSessionImage; only the DOM-bound file processing (FileReader
// + Image decode, which jsdom cannot do) is stubbed.
vi.mock('../imageFile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../imageFile')>()),
  processImageFile: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.mocked(dmImages.uploadDmImage).mockReset();
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
const HASH = 'c'.repeat(64);
const REF = {
  url: `https://blossom.descendant.io/${HASH}`,
  key: 'a'.repeat(64),
  iv: 'b'.repeat(24),
};

const nullTransport: PhoneTransport = {
  subscribe: () => ({ close: () => {} }),
  publish: async () => true,
};

const sessionInfo = (id: string): RemoteSessionInfo => ({
  id,
  slug: id,
  cwd: `/home/x/${id}`,
  lastActivity: '2026-08-08T10:00:00.000Z',
  lineCount: 0,
  title: null,
  project: `proj-${id}`,
});

async function makeCore(capabilities: string[]): Promise<PhoneCore> {
  const core = await createPhoneCore({ kv: memoryKV(), transport: nullTransport });
  core.machines.getState().registerMachine({ pubkeyHex: MACHINE, name: 'laptop' });
  const heartbeat: SessionListMessage = {
    type: 'sessions',
    machine: 'laptop',
    sessions: [sessionInfo('s1')],
    protocolVersion: 10,
    capabilities,
  };
  core.machines.getState().applySessionList(MACHINE, heartbeat, Date.now());
  return core;
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

  it('Send uploads via Blossom and publishes upload-image with the draft text, then clears both', async () => {
    const core = await makeCore(['images']);
    vi.mocked(imageFile.processImageFile).mockResolvedValue({
      base64: 'QUJD',
      mimeType: 'image/png',
      filename: 'cat.png',
      sizeBytes: 3,
    });
    vi.mocked(dmImages.uploadDmImage).mockResolvedValue(REF);
    const uploadSpy = vi.spyOn(core.api, 'uploadImageBlossom').mockResolvedValue({ verdict: 'accepted' });
    const chunkSpy = vi.spyOn(core.api, 'uploadImageChunk').mockResolvedValue({ verdict: 'accepted' });
    renderSession(core);

    const file = new File([new Uint8Array([1, 2, 3])], 'cat.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('session-file-input'), { target: { files: [file] } });
    fireEvent.change(screen.getByPlaceholderText('Message the session…'), {
      target: { value: 'what is this?' },
    });
    fireEvent.click(screen.getByText('Send'));

    await waitFor(() => expect(uploadSpy).toHaveBeenCalledOnce());
    expect(uploadSpy).toHaveBeenCalledWith(MACHINE, {
      sessionId: 's1',
      hash: HASH,
      url: REF.url,
      key: REF.key,
      iv: REF.iv,
      filename: 'cat.png',
      mimeType: 'image/png',
      text: 'what is this?',
      sizeBytes: 3,
    });
    expect(chunkSpy).not.toHaveBeenCalled();
    // Upload used the phone's own key.
    const [, secretKey] = vi.mocked(dmImages.uploadDmImage).mock.calls[0]!;
    expect(secretKey).toBe(core.identity.getState().keypair.secretKey);
    await waitFor(() => expect(screen.queryByTestId('session-attach-strip')).toBeNull());
    expect(
      (screen.getByPlaceholderText('Message the session…') as HTMLTextAreaElement).value,
    ).toBe('');
  });

  /**
   * CDX-068 — the composer must always be escapable. Pre-fix a file read that
   * stalled (a `content://` provider that fires neither onload nor onerror)
   * never reached `sendWithImage`'s `finally`, so `uploading` stayed true
   * forever: spinner pinned, ✕ `disabled={uploading}`, Send disabled. The only
   * way out was leaving the screen.
   */
  it('a read that never comes back: ✕ stays live, clears the wedge, and the abandoned send writes nothing back', async () => {
    const core = await makeCore(['images']);
    let failRead: (err: Error) => void = () => {};
    vi.mocked(imageFile.processImageFile).mockImplementation(
      () =>
        new Promise<never>((_resolve, reject) => {
          failRead = reject;
        }),
    );
    const uploadSpy = vi.spyOn(core.api, 'uploadImageBlossom').mockResolvedValue({ verdict: 'accepted' });
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
    // already dropped, no draft wipe, and nothing was ever published.
    failRead(new Error('Failed to read file (TimeoutError: File.arrayBuffer timed out after 30000 ms)'));
    await waitFor(() =>
      expect((screen.getByText('Send') as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.queryByTestId('session-upload-failed')).toBeNull();
    expect(
      (screen.getByPlaceholderText('Message the session…') as HTMLTextAreaElement).value,
    ).toBe('describe this');
    expect(uploadSpy).not.toHaveBeenCalled();
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

  it('total failure shows the inline error and keeps draft + staged image', async () => {
    const core = await makeCore(['images']);
    vi.mocked(imageFile.processImageFile).mockResolvedValue({
      base64: 'QUJD',
      mimeType: 'image/png',
      filename: 'cat.png',
      sizeBytes: 3,
    });
    vi.mocked(dmImages.uploadDmImage).mockRejectedValue(new Error('Failed to fetch'));
    vi.spyOn(core.api, 'uploadImageChunk').mockResolvedValue({ verdict: 'rejected' });
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
});

/**
 * `PhoneCore.sendSessionImageNative` (F2b) is optional — present only on the
 * native composition. `SessionScreen` picks the whole-dispatch path over the
 * local Blossom-then-chunk orchestration purely on this method's presence,
 * so grafting it onto an otherwise-local `createPhoneCore()` core is enough
 * to exercise the branch without standing up the full native composition.
 */
describe('native session image send (PhoneCore.sendSessionImageNative present)', () => {
  it('dispatches the whole image with no BridgeApi upload call, then clears the composer', async () => {
    const core = await makeCore(['images']);
    vi.mocked(imageFile.processImageFile).mockResolvedValue({
      base64: 'QUJD',
      mimeType: 'image/png',
      filename: 'cat.png',
      sizeBytes: 3,
    });
    const sendNative = vi.fn().mockResolvedValue(undefined);
    core.sendSessionImageNative = sendNative;
    const uploadSpy = vi.spyOn(core.api, 'uploadImageBlossom');
    const chunkSpy = vi.spyOn(core.api, 'uploadImageChunk');
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
    expect(Array.from(params.image as Uint8Array)).toEqual([65, 66, 67]); // 'QUJD' → 'ABC'

    expect(uploadSpy).not.toHaveBeenCalled();
    expect(chunkSpy).not.toHaveBeenCalled();
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
    core.sendSessionImageNative = vi.fn().mockRejectedValue(new Error('dispatch failed'));
    const uploadSpy = vi.spyOn(core.api, 'uploadImageBlossom');
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
    expect(uploadSpy).not.toHaveBeenCalled();
  });
});

/**
 * CDX-086 — the coverage hole that let the founder's bug ship.
 *
 * Every pre-existing mock in this file resolves IMMEDIATELY, and the only stall
 * ever injected was on `processImageFile` — the one stage CDX-068 had already
 * bounded. So nothing exercised a slow or never-resolving NETWORK stage, and no
 * test asserted that the spinner clears while the strip is still mounted. Both
 * of the founder's symptoms lived in exactly that gap.
 */
describe('a network stage that never settles (CDX-086)', () => {
  const stageImage = (): void => {
    vi.mocked(imageFile.processImageFile).mockResolvedValue({
      base64: 'QUJD',
      mimeType: 'image/png',
      filename: 'cat.png',
      sizeBytes: 3,
    });
  };
  const attachAndSend = (): void => {
    const file = new File([new Uint8Array([1, 2, 3])], 'cat.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('session-file-input'), { target: { files: [file] } });
    fireEvent.click(screen.getByText('Send'));
  };

  it('the ✕ genuinely cancels: a resolving upload publishes NOTHING afterwards', async () => {
    const core = await makeCore(['images']);
    stageImage();
    let releaseUpload: (ref: typeof REF) => void = () => {};
    let capturedSignal: AbortSignal | undefined;
    vi.mocked(dmImages.uploadDmImage).mockImplementation(
      (_bytes, _key, _server, opts) => {
        capturedSignal = opts?.signal;
        return new Promise((resolve) => {
          releaseUpload = resolve;
        });
      },
    );
    const uploadSpy = vi.spyOn(core.api, 'uploadImageBlossom');
    const chunkSpy = vi.spyOn(core.api, 'uploadImageChunk');
    renderSession(core);

    attachAndSend();
    await waitFor(() => expect(screen.getByTestId('session-attach-strip').textContent)
      .toContain('uploading…'));

    // The founder's move: give up and hit ✕ while it says uploading.
    fireEvent.click(screen.getByLabelText('Remove attachment'));
    expect(screen.queryByTestId('session-attach-strip')).toBeNull();
    // The in-flight request is genuinely aborted, not merely ignored.
    expect(capturedSignal?.aborted).toBe(true);

    // Now let the upload come back late, as it did on device.
    releaseUpload(REF);
    await new Promise((r) => setTimeout(r, 20));

    // PRE-FIX THIS IS WHERE THE IMAGE WENT OUT ANYWAY — "then it turns out that
    // the image is included". Nothing may publish after a cancel.
    expect(uploadSpy).not.toHaveBeenCalled();
    expect(chunkSpy).not.toHaveBeenCalled();
  });

  it('an UNCONFIRMED reference clears the composer, says so, and never chunks', async () => {
    const core = await makeCore(['images']);
    stageImage();
    vi.mocked(dmImages.uploadDmImage).mockResolvedValue(REF);
    vi.spyOn(core.api, 'uploadImageBlossom').mockResolvedValue({
      verdict: 'unconfirmed',
      detail: 'publish timed out',
    });
    const chunkSpy = vi.spyOn(core.api, 'uploadImageChunk');
    renderSession(core);

    attachAndSend();

    // A late relay OK is delivery, not failure: no re-upload, composer clears,
    // and the user is told what "unconfirmed" means for them.
    const notice = await screen.findByTestId('session-upload-unconfirmed');
    expect(notice.textContent).toMatch(/never confirmed/i);
    expect(chunkSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('session-attach-strip')).toBeNull());
  });

  it('a REJECTED reference keeps the attachment, and a retry does not re-upload the bytes', async () => {
    const core = await makeCore(['images']);
    stageImage();
    vi.mocked(dmImages.uploadDmImage).mockResolvedValue(REF);
    vi.spyOn(core.api, 'uploadImageBlossom').mockResolvedValue({
      verdict: 'rejected',
      detail: 'rate-limited: you are noting too much',
    });
    const chunkSpy = vi.spyOn(core.api, 'uploadImageChunk');
    renderSession(core);

    attachAndSend();
    const banner = await screen.findByTestId('session-upload-failed');
    expect(banner.textContent).toMatch(/no relay would carry/);
    // The bytes ARE on the server — chunking them again is pure waste.
    expect(chunkSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('session-attach-strip')).toBeTruthy();

    // Retry: the ref is remembered, so the PUT does not happen a second time.
    expect(vi.mocked(dmImages.uploadDmImage)).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() =>
      expect(vi.mocked(core.api.uploadImageBlossom)).toHaveBeenCalledTimes(2),
    );
    expect(vi.mocked(dmImages.uploadDmImage)).toHaveBeenCalledTimes(1);
  });
});
