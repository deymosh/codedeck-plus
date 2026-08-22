/**
 * DmAvatar — profile picture with an initial fallback (ported from the old
 * Avatar.tsx idea, rebuilt on tokens/rem). The fallback hue is derived from
 * the pubkey so a peer keeps a stable color before their kind-0 resolves.
 */
import { useState } from 'react';
import styles from './dm.module.css';

function hueOf(pubkey: string): number {
  let h = 0;
  for (let i = 0; i < Math.min(pubkey.length, 16); i++) {
    h = (h * 31 + pubkey.charCodeAt(i)) % 360;
  }
  return h;
}

export function DmAvatar({
  pubkey,
  picture,
  name,
  sizeRem = 2.25,
}: {
  pubkey: string;
  picture?: string | undefined;
  name?: string | undefined;
  sizeRem?: number;
}) {
  const [broken, setBroken] = useState(false);
  const size = `${sizeRem}rem`;
  // `||`, not `??`: an empty name (or an empty pubkey on a group whose peer is
  // unknown) must fall through, not render a blank circle.
  const initial = (name?.trim()[0] || pubkey.slice(0, 1) || '?').toUpperCase();

  if (picture && !broken) {
    return (
      <img
        className={styles.avatar}
        style={{ width: size, height: size }}
        src={picture}
        alt=""
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <span
      className={styles.avatarFallback}
      style={{
        width: size,
        height: size,
        fontSize: `${sizeRem * 0.45}rem`,
        background: `hsl(${hueOf(pubkey)} 30% 25%)`,
      }}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}
