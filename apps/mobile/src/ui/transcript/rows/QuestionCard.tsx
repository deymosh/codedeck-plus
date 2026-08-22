/**
 * Question cards — AskUserQuestion surfaced as special='ask_question' entries.
 * Interaction design ported from the old QuestionEntry/QuestionGroupEntry:
 * option buttons (keypress '1'-based, context 'question'), multi-select with a
 * comma-joined `question-input`, free-text answers via `question-input`, and a
 * tabbed group card for multi-question groups (answered IN ORDER — the broker
 * resolves questions by remaining count, so the active tab is always the first
 * unanswered question).
 */
import { useEffect, useRef, useState } from 'react';
import type { QuestionDisplay, QuestionGroupDisplay, QuestionSpecView } from '../displayEntries';
import type { CardActions } from './types';
import styles from './cards.module.css';
import { shared } from '../../shared';

/** Heuristic: detect "type your own answer" style options (ported). */
export function isFreeTextOption(label: string, index: number, total: number): boolean {
  if (total < 3) return false;
  const lower = label.toLowerCase();
  if (/\b(something else|your own|type something|type your )\b/.test(lower)) return true;
  const isLast = index === total - 1;
  return isLast && /\b(provide|write |specify|custom|other)\b/.test(lower);
}

/**
 * The answering surface for ONE question: options / multi-select toggles /
 * free-text input. `onKeypressAnswer` sends the 1-based option keypress;
 * `onTextAnswer` sends free text or the joined multi-select labels.
 */
function QuestionAnswerBody({
  question,
  onKeypressAnswer,
  onTextAnswer,
}: {
  question: QuestionSpecView;
  onKeypressAnswer(key: string): void;
  onTextAnswer(text: string): void;
}) {
  const [showTextInput, setShowTextInput] = useState(false);
  const [textValue, setTextValue] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const textInputRef = useRef<HTMLInputElement>(null);

  const options = question.options ?? [];
  const hasOptions = options.length > 0;
  const isMulti = !!question.multiSelect && hasOptions;
  const freeTextIndex = hasOptions
    ? options.findIndex((opt, i) => isFreeTextOption(opt.label, i, options.length))
    : -1;

  useEffect(() => {
    if (showTextInput) textInputRef.current?.focus();
  }, [showTextInput]);

  const submitText = (): void => {
    const trimmed = textValue.trim();
    if (!trimmed) return;
    onTextAnswer(trimmed);
    setTextValue('');
    setShowTextInput(false);
  };

  const textInput = (
    <div className={styles.textInputRow}>
      <input
        className={styles.textInput}
        ref={textInputRef}
        type="text"
        placeholder="Type your answer…"
        value={textValue}
        onChange={(e) => setTextValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submitText();
        }}
      />
      <button className={shared.btnPrimary} onClick={submitText} disabled={!textValue.trim()}>
        Send
      </button>
    </div>
  );

  if (!hasOptions || showTextInput) return textInput;

  if (isMulti) {
    const toggle = (i: number): void => {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(i)) next.delete(i);
        else next.add(i);
        return next;
      });
    };
    const sendMulti = (): void => {
      if (selected.size === 0) return;
      const labels = [...selected].sort((a, b) => a - b).map((i) => options[i]!.label);
      onTextAnswer(labels.join(', '));
    };
    return (
      <>
        <div className={styles.multiHint}>Select all that apply</div>
        <div className={styles.options}>
          {options.map((opt, i) => {
            const on = selected.has(i);
            return (
              <button
                key={i}
                className={on ? styles.optionOn : styles.option}
                aria-pressed={on}
                onClick={() => toggle(i)}
              >
                <span>{on ? '☑' : '☐'}</span>
                <span className={styles.optionLabel}>{opt.label}</span>
                {opt.description && <span className={styles.optionDesc}>{opt.description}</span>}
              </button>
            );
          })}
        </div>
        <button className={shared.btnPrimary} onClick={sendMulti} disabled={selected.size === 0}>
          Send{selected.size > 0 ? ` (${selected.size})` : ''}
        </button>
      </>
    );
  }

  return (
    <>
      <div className={styles.options}>
        {options.map((opt, i) => (
          <button
            key={i}
            className={styles.option}
            onClick={() => {
              if (freeTextIndex === i) setShowTextInput(true);
              else onKeypressAnswer(String(i + 1));
            }}
          >
            <span className={styles.optionLabel}>{opt.label}</span>
            {opt.description && <span className={styles.optionDesc}>{opt.description}</span>}
          </button>
        ))}
      </div>
      {freeTextIndex === -1 && (
        <button className={shared.btnSmall} onClick={() => setShowTextInput(true)}>
          Type your own answer…
        </button>
      )}
    </>
  );
}

export function QuestionCard({
  item,
  sessionId,
  responded,
  actions,
}: {
  item: QuestionDisplay;
  sessionId: string;
  responded: boolean;
  actions: CardActions;
}) {
  const q = item.question;
  const optionCount = q.options?.length ?? 0;

  if (item.answered !== undefined || responded) {
    return (
      <div className={styles.cardAnswered} data-row="question">
        {q.header && <div className={styles.title}>{q.header}</div>}
        <div className={styles.questionText}>{q.entry.content}</div>
        <div className={styles.outcome}>{item.answered ?? 'Response sent…'}</div>
      </div>
    );
  }

  const mark = (): void => {
    if (item.toolUseId) actions.markResponded(item.toolUseId);
  };

  return (
    <div className={styles.card} data-row="question" aria-live="polite">
      {q.header && <div className={styles.title}>{q.header}</div>}
      <div className={styles.questionText}>{q.entry.content}</div>
      <QuestionAnswerBody
        question={q}
        onKeypressAnswer={(key) => {
          mark();
          actions.sendCommand({ type: 'keypress', sessionId, key, context: 'question' });
        }}
        onTextAnswer={(text) => {
          mark();
          actions.sendCommand({ type: 'question-input', sessionId, text, optionCount });
        }}
      />
    </div>
  );
}

export function QuestionGroupCard({
  item,
  sessionId,
  respondedCards,
  actions,
}: {
  item: QuestionGroupDisplay;
  sessionId: string;
  /** The session's optimistically-responded card-id set (composite ids `${toolUseId}:q${i}`). */
  respondedCards: ReadonlySet<string> | undefined;
  actions: CardActions;
}) {
  const { toolUseId, questions } = item;

  const answeredSet = new Set<number>();
  questions.forEach((_, i) => {
    if (respondedCards?.has(`${toolUseId}:q${i}`)) answeredSet.add(i);
  });

  const firstUnanswered = questions.findIndex((_, i) => !answeredSet.has(i));
  const allAnswered = firstUnanswered === -1;

  if (item.answered !== undefined || allAnswered) {
    return (
      <div className={styles.cardAnswered} data-row="question-group">
        <div className={styles.tabs}>
          {questions.map((q, i) => (
            <div key={i} className={styles.tabDone}>
              ✓ {q.header ?? `Question ${i + 1}`}
            </div>
          ))}
        </div>
        <div className={styles.outcome}>{item.answered ?? 'All responses sent'}</div>
      </div>
    );
  }

  // The broker answers questions IN ORDER — the active card is always the
  // first unanswered one; done/future tabs are labels, not navigation.
  const active = questions[firstUnanswered]!;
  const optionCount = active.options?.length ?? 0;
  const mark = (): void => actions.markResponded(`${toolUseId}:q${firstUnanswered}`);

  return (
    <div className={styles.card} data-row="question-group" aria-live="polite">
      <div className={styles.tabs}>
        {questions.map((q, i) => {
          const done = answeredSet.has(i);
          const isActive = i === firstUnanswered;
          return (
            <div
              key={i}
              className={isActive ? styles.tabActive : done ? styles.tabDone : styles.tab}
            >
              {done && '✓ '}
              {q.header ?? `Question ${i + 1}`}
            </div>
          );
        })}
      </div>
      <div className={styles.questionText}>{active.entry.content}</div>
      <QuestionAnswerBody
        key={firstUnanswered}
        question={active}
        onKeypressAnswer={(key) => {
          mark();
          actions.sendCommand({ type: 'keypress', sessionId, key, context: 'question' });
        }}
        onTextAnswer={(text) => {
          mark();
          actions.sendCommand({ type: 'question-input', sessionId, text, optionCount });
        }}
      />
    </div>
  );
}
