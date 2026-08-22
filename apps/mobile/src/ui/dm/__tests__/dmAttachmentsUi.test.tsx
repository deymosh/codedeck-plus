// @vitest-environment jsdom
/**
 * CDX-011: DM image attachments UI — attach → preview strip → Send uploads
 * (mocked platform seam) and appends the ref line to the REAL dm store send;
 * received refs render as inline images with tap-to-open and degrade to a
 * link when fetch/decrypt fails; upload failure keeps the attachment + text.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { NostrEvent } from 'nostr-tools/core';
import type { PhoneCore } from '../../../core/createPhoneCore';
import { createPhoneCore } from '../../../core/createPhoneCore';
import { buildImageRef } from '../../../core/dmAttachments';
import { generateKeypair } from '../../../core/crypto';
import { memoryKV, type KV, type PhoneTransport } from '../../../core/ports';
import { PhoneCoreProvider } from '../../coreContext';
import { DmChatScreen } from '../DmChatScreen';
import * as dmImages from '../../../platform/dmImages';

vi.mock('../../../platform/dmImages', () => ({
  DEFAULT_BLOSSOM_SERVER: 'https://blossom.descendant.io',
  uploadDmImage: vi.fn(),
  fetchDecryptedImage: vi.fn(async () => null),
}));

afterEach(() => {
  cleanup();
  vi.mocked(dmImages.uploadDmImage).mockReset();
  vi.mocked(dmImages.fetchDecryptedImage).mockReset();
});

const PEER = generateKeypair().pubkeyHex; // must be a real curve point (NIP-44 seal)
const REF = { url: 'https://blossom.descendant.io/' + 'c'.repeat(64), key: 'a'.repeat(64), iv: 'b'.repeat(24) };

async function makeCore(kv: KV = memoryKV()): Promise<{ core: PhoneCore; published: NostrEvent[] }> {
  const published: NostrEvent[] = [];
  const transport: PhoneTransport = {
    subscribe: () => ({ close: () => {} }),
    publish: async (event) => {
      published.push(event);
      return true;
    },
  };
  const core = await createPhoneCore({ kv, transport });
  return { core, published };
}

/** Seed a received message via the persisted-dm path (hydrated at core boot). */
async function kvWithMessage(content: string): Promise<KV> {
  const kv = memoryKV();
  await kv.set(
    'dm',
    JSON.stringify({
      conversations: {
        [PEER]: { peerPubkey: PEER, protocol: 'nip17', lastMessageAt: 1000, unreadCount: 0, lastPreview: content },
      },
      messages: {
        [PEER]: [
          { id: 'm1', peerPubkey: PEER, senderPubkey: PEER, content, at: 1000, status: 'delivered' },
        ],
      },
      profiles: {},
    }),
  );
  return kv;
}

function renderChat(core: PhoneCore) {
  return render(
    <PhoneCoreProvider value={core}>
      <DmChatScreen peerPubkey={PEER} />
    </PhoneCoreProvider>,
  );
}

describe('received attachments render inline', () => {
  it('an encrypted ref becomes an inline image; tap opens the overlay', async () => {
    vi.mocked(dmImages.fetchDecryptedImage).mockResolvedValue('blob:decrypted-1');
    const { core } = await makeCore(await kvWithMessage(`dinner pic\n${buildImageRef(REF)}`));
    renderChat(core);

    const img = await screen.findByTestId('dm-inline-image');
    expect(img.getAttribute('src')).toBe('blob:decrypted-1');
    expect(dmImages.fetchDecryptedImage).toHaveBeenCalledWith(REF);
    expect(screen.getByText('dinner pic')).toBeTruthy();

    fireEvent.click(img);
    expect(screen.getByTestId('dm-image-overlay')).toBeTruthy();
    fireEvent.click(screen.getByTestId('dm-image-overlay'));
    expect(screen.queryByTestId('dm-image-overlay')).toBeNull();
  });

  it('fetch/decrypt failure degrades to a tappable link (never a broken image)', async () => {
    vi.mocked(dmImages.fetchDecryptedImage).mockResolvedValue(null);
    const { core } = await makeCore(await kvWithMessage(buildImageRef(REF)));
    renderChat(core);
    const link = await screen.findByTestId('dm-image-fallback');
    expect(link.getAttribute('href')).toBe(REF.url);
    expect(screen.queryByTestId('dm-inline-image')).toBeNull();
  });
});

describe('attachment send path', () => {
  it('attach → preview strip → Send uploads and appends the ref line to the sent DM', async () => {
    vi.mocked(dmImages.uploadDmImage).mockResolvedValue(REF);
    const { core, published } = await makeCore();
    renderChat(core);

    // The attach button is a DIRECT child of the one-flex-row bar (invariant).
    const bar = screen.getByTestId('dm-bottom-bar');
    expect(bar.children).toHaveLength(4);
    expect(bar.children[0]!.getAttribute('aria-label')).toBe('Attach image');

    const file = new File([new Uint8Array([1, 2, 3])], 'cat.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('dm-file-input'), { target: { files: [file] } });
    expect(screen.getByTestId('dm-attach-strip')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'look' } });
    fireEvent.click(screen.getByText('Send'));

    await waitFor(() => {
      const msgs = core.dm.getState().messages[PEER] ?? [];
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.content).toBe(`look\n${buildImageRef(REF)}`);
    });
    // Upload got the file's bytes + the phone's secret key.
    const [bytes, secretKey] = vi.mocked(dmImages.uploadDmImage).mock.calls[0]!;
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(secretKey).toBe(core.identity.getState().keypair.secretKey);
    // The wrap actually left through the transport, strip cleared.
    expect(published.length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByTestId('dm-attach-strip')).toBeNull());
  });

  it('image-only send works (Send enabled by the staged attachment)', async () => {
    vi.mocked(dmImages.uploadDmImage).mockResolvedValue(REF);
    const { core } = await makeCore();
    renderChat(core);
    const file = new File([new Uint8Array([7])], 'x.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('dm-file-input'), { target: { files: [file] } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => {
      expect((core.dm.getState().messages[PEER] ?? [])[0]?.content).toBe(buildImageRef(REF));
    });
  });

  it('upload failure keeps the attachment staged, shows the error, Retry resends with the text', async () => {
    vi.mocked(dmImages.uploadDmImage)
      .mockRejectedValueOnce(new Error('Blossom upload failed: 502'))
      .mockResolvedValueOnce(REF);
    const { core } = await makeCore();
    renderChat(core);
    const file = new File([new Uint8Array([5])], 'x.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('dm-file-input'), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hold on' } });
    fireEvent.click(screen.getByText('Send'));

    const banner = await screen.findByTestId('dm-upload-failed');
    expect(banner.textContent).toContain('Blossom upload failed: 502');
    expect(screen.getByTestId('dm-attach-strip')).toBeTruthy(); // still staged
    expect(core.dm.getState().messages[PEER] ?? []).toHaveLength(0); // nothing sent

    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => {
      expect((core.dm.getState().messages[PEER] ?? [])[0]?.content).toBe(
        `hold on\n${buildImageRef(REF)}`,
      );
    });
    await waitFor(() => expect(screen.queryByTestId('dm-attach-strip')).toBeNull());
  });
});

/**
 * CDX-086 — DM parity with the session composer. This path shared four of the
 * same defects and its ✕ was strictly worse: `disabled={uploading}` is the exact
 * CDX-068 wedge the session composer was rescued from months earlier.
 */
describe('DM upload is escapable and cancellable (CDX-086)', () => {
  it('the ✕ stays live during an upload and nothing is sent when it later resolves', async () => {
    const { core } = await makeCore();
    let release: (ref: { url: string; key: string; iv: string }) => void = () => {};
    let capturedSignal: AbortSignal | undefined;
    vi.mocked(dmImages.uploadDmImage).mockImplementation((_b, _k, _s, opts) => {
      capturedSignal = opts?.signal;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const sendSpy = vi.spyOn(core.dm.getState(), 'send');

    render(
      <PhoneCoreProvider value={core}>
        <DmChatScreen peerPubkey={PEER} />
      </PhoneCoreProvider>,
    );

    const file = new File([new Uint8Array([1, 2, 3])], 'cat.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('dm-file-input'), { target: { files: [file] } });
    fireEvent.click(screen.getByText('Send'));

    const remove = await waitFor(() => screen.getByLabelText('Remove attachment'));
    // Pre-fix this button was disabled while uploading, so a stalled upload had
    // no exit but leaving the screen.
    expect((remove as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(remove);
    expect(capturedSignal?.aborted).toBe(true);

    release({ url: 'https://b/' + 'c'.repeat(64), key: 'a'.repeat(64), iv: 'b'.repeat(24) });
    await new Promise((r) => setTimeout(r, 20));
    // A cancelled upload must not deliver the DM afterwards.
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
