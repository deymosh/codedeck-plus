/**
 * DM bubble content (CDX-011) — parses the message for attachment refs /
 * bare image URLs (core/dmAttachments.parseDmContent) and renders them as
 * inline images with tap-to-open; everything else stays plain text. The old
 * app rendered the raw ref line as text — this is the promised improvement.
 *
 * Encrypted refs are fetched + AES-GCM-decrypted through the platform seam
 * (cached object URLs). Any failure (offline, CORS, bad key) degrades to a
 * tappable link — never a broken-image icon, never a throw.
 */
import { useEffect, useState } from 'react';
import {
  parseDmContent,
  type EncryptedImageRef,
} from '../../core/dmAttachments';
import { fetchDecryptedImage } from '../../platform/dmImages';
import styles from './dm.module.css';

function ImageOverlay({ src, onClose }: { src: string; onClose(): void }) {
  return (
    <div className={styles.imageOverlay} onClick={onClose} data-testid="dm-image-overlay">
      <img className={styles.imageOverlayImg} src={src} alt="attachment (full size)" />
    </div>
  );
}

function InlineImage({ src, href }: { src: string; href: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <img
        className={styles.inlineImage}
        src={src}
        alt="attachment"
        data-testid="dm-inline-image"
        onClick={() => setOpen(true)}
      />
      {open && <ImageOverlay src={href} onClose={() => setOpen(false)} />}
    </>
  );
}

function EncryptedImage({ imageRef }: { imageRef: EncryptedImageRef }) {
  // undefined = loading, null = failed (→ link fallback), string = object URL.
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void fetchDecryptedImage(imageRef).then((url) => {
      if (!cancelled) setSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [imageRef.url, imageRef.key, imageRef.iv]); // eslint-disable-line react-hooks/exhaustive-deps
  if (src === undefined) {
    return <div className={styles.imageLoading} data-testid="dm-image-loading">loading image…</div>;
  }
  if (src === null) {
    return (
      <a
        className={styles.imageLink}
        href={imageRef.url}
        target="_blank"
        rel="noreferrer"
        data-testid="dm-image-fallback"
      >
        {imageRef.url}
      </a>
    );
  }
  return <InlineImage src={src} href={src} />;
}

export function DmMessageContent({ content }: { content: string }) {
  const segments = parseDmContent(content);
  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === 'text' ? (
          <span key={i}>{seg.text}</span>
        ) : seg.kind === 'image' ? (
          <EncryptedImage key={i} imageRef={seg.ref} />
        ) : (
          <InlineImage key={i} src={seg.url} href={seg.url} />
        ),
      )}
    </>
  );
}
