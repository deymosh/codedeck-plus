/**
 * DmBottomBar — the DM composer, rebuilt as ONE flex component on tokens
 * (plan §5; the old app's DM icon-layout bug is fixed structurally — see
 * DmBottomBar.module.css for the autopsy). Auto-growing textarea + send
 * button; Enter sends on non-touch devices (ported), Shift+Enter always
 * inserts a newline.
 */
import { useRef, useState } from 'react';
import { recognizeSpeech } from '../../platform/stt';
import { appendToDraft } from '../appendToDraft';
import { AttachIcon, MicIcon } from '../icons';
import { useAutoGrowTextarea } from '../autoGrowTextarea';
import styles from './DmBottomBar.module.css';

const isCoarsePointer = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(pointer: coarse)').matches;

export function DmBottomBar({
  onSend,
  onAttach,
  canSendEmpty = false,
  disabled = false,
}: {
  /** Called with the trimmed draft; the bar clears itself. */
  onSend(text: string): void;
  /** Attach an image (CDX-011) — renders the clip button (a DIRECT child of the
   *  one flex row) only when wired; the parent owns the file input + preview. */
  onAttach?(): void;
  /** An attachment is staged — Send works with an empty draft. */
  canSendEmpty?: boolean;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow up to the CSS max-height (ported behaviour, rem-based). CDX-025
  // moved the arithmetic into the shared helper so this composer also picks up
  // the border-box correction and the re-measure on --ui-scale / resize.
  useAutoGrowTextarea(textareaRef, draft);

  const canSend = (draft.trim() !== '' || canSendEmpty) && !disabled;

  const send = (): void => {
    const text = draft.trim();
    if ((text === '' && !canSendEmpty) || disabled) return;
    setDraft('');
    onSend(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey && !isCoarsePointer()) {
      e.preventDefault();
      send();
    }
  };

  // Mic (5c): native STT appends to the draft; null (desktop/cancel) focuses
  // the textarea instead. Stays a DIRECT child of the one flex row.
  const mic = async (): Promise<void> => {
    const text = await recognizeSpeech();
    if (text) setDraft((d) => appendToDraft(d, text));
    else textareaRef.current?.focus();
  };

  return (
    <div className={styles.bar} data-testid="dm-bottom-bar">
      {onAttach && (
        <button
          className={styles.micBtn}
          onClick={onAttach}
          disabled={disabled}
          aria-label="Attach image"
          title="Attach image"
        >
          <AttachIcon />
        </button>
      )}
      <textarea
        ref={textareaRef}
        className={styles.textarea}
        rows={1}
        value={draft}
        placeholder="Message…"
        aria-label="Message"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
      />
      <button
        className={styles.micBtn}
        onClick={() => void mic()}
        disabled={disabled}
        aria-label="Dictate with voice"
        title="Dictate with voice"
      >
        <MicIcon />
      </button>
      <button className={styles.sendBtn} onClick={send} disabled={!canSend}>
        Send
      </button>
    </div>
  );
}
