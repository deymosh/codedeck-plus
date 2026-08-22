// @vitest-environment jsdom
/**
 * DiffRow (CDX-050) — filename header, colored +/− lines, and the long-diff
 * collapse ("N more lines" expander beyond DIFF_COLLAPSE_AT).
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { OutputEntry } from '@codedeck/protocol';
import { DiffRow, DIFF_COLLAPSE_AT } from '../rows/DiffRow';

afterEach(cleanup);

const diffEntry = (over: Partial<OutputEntry> = {}): OutputEntry => ({
  entryType: 'diff',
  content: '-const a = 1;\n+const a = 2;',
  timestamp: '2026-08-08T00:00:00.000Z',
  metadata: { role: 'assistant', tool_name: 'Edit', tool_use_id: 'toolu_d1' },
  diff: {
    path: 'src/app.ts',
    lines: [
      { type: 'del', text: 'const a = 1;' },
      { type: 'add', text: 'const a = 2;' },
    ],
  },
  ...over,
});

describe('DiffRow', () => {
  it('renders the filename header and prefixed +/− lines from the structured payload', () => {
    render(<DiffRow entry={diffEntry()} expanded={false} onToggle={() => {}} />);
    expect(screen.getByText('src/app.ts')).toBeTruthy();
    expect(screen.getByText('-const a = 1;')).toBeTruthy();
    expect(screen.getByText('+const a = 2;')).toBeTruthy();
    // Short diff → no expander.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('colors add/del/context lines via distinct classes', () => {
    const entry = diffEntry({
      diff: {
        path: 'x.ts',
        lines: [
          { type: 'add', text: 'added' },
          { type: 'del', text: 'removed' },
          { type: 'context', text: '⋯' },
        ],
      },
    });
    render(<DiffRow entry={entry} expanded={false} onToggle={() => {}} />);
    const add = screen.getByText('+added');
    const del = screen.getByText('-removed');
    expect(add.className).not.toBe(del.className);
    expect(add.className).toMatch(/Add/);
    expect(del.className).toMatch(/Del/);
  });

  it(`collapses beyond ${DIFF_COLLAPSE_AT} lines behind an "N more lines" expander`, () => {
    const lines = Array.from({ length: DIFF_COLLAPSE_AT + 10 }, (_, i) => ({
      type: 'add' as const,
      text: `line ${i}`,
    }));
    const onToggle = vi.fn();
    render(
      <DiffRow
        entry={diffEntry({ diff: { path: 'big.ts', lines } })}
        expanded={false}
        onToggle={onToggle}
      />,
    );
    expect(screen.getByText(`+line ${DIFF_COLLAPSE_AT - 1}`)).toBeTruthy();
    expect(screen.queryByText(`+line ${DIFF_COLLAPSE_AT}`)).toBeNull();
    const expander = screen.getByRole('button');
    expect(expander.textContent).toBe('10 more lines');
    fireEvent.click(expander);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('expanded shows every line and offers "Show less"', () => {
    const lines = Array.from({ length: DIFF_COLLAPSE_AT + 10 }, (_, i) => ({
      type: 'add' as const,
      text: `line ${i}`,
    }));
    render(
      <DiffRow
        entry={diffEntry({ diff: { path: 'big.ts', lines } })}
        expanded={true}
        onToggle={() => {}}
      />,
    );
    expect(screen.getByText(`+line ${DIFF_COLLAPSE_AT + 9}`)).toBeTruthy();
    expect(screen.getByRole('button').textContent).toBe('Show less');
  });

  it('flags a wire-truncated diff in the header', () => {
    render(
      <DiffRow
        entry={diffEntry({
          diff: { path: 'big.ts', lines: [{ type: 'add', text: 'x' }], truncated: true },
        })}
        expanded={false}
        onToggle={() => {}}
      />,
    );
    expect(screen.getByText('(truncated)')).toBeTruthy();
  });

  it('falls back to parsing content when the structured payload is missing (legacy shape)', () => {
    const entry: OutputEntry = {
      entryType: 'diff',
      content: '-old line\n+new line',
      timestamp: 't',
      metadata: { filename: 'legacy.ts' },
    };
    render(<DiffRow entry={entry} expanded={false} onToggle={() => {}} />);
    expect(screen.getByText('legacy.ts')).toBeTruthy();
    expect(screen.getByText('-old line')).toBeTruthy();
    expect(screen.getByText('+new line')).toBeTruthy();
  });
});
