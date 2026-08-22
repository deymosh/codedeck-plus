// @vitest-environment jsdom
/**
 * ToolGroupRow — the collapsed "N actions" row. First component test for it
 * (CDX-085); the row shipped in Phase 3c with none.
 *
 * The change under test: thinking used to render as a row of its OWN, so one
 * turn produced `Thinking`, `4 actions`, `Thinking`, `2 actions`. Reasoning now
 * lives inside this row's body, in transcript order, and counts toward the
 * summary.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { OutputEntry } from '@codedeck/protocol';
import type { SeqEntry } from '../displayEntries';
import { ToolGroupRow } from '../rows/ToolGroupRow';

afterEach(cleanup);

let seq = 0;
const at = (entryType: OutputEntry['entryType'], content: string, metadata = {}): SeqEntry => ({
  seq: ++seq,
  entry: { entryType, content, timestamp: '2026-08-09T00:00:00.000Z', metadata },
});

describe('ToolGroupRow', () => {
  it('collapsed: shows only the summary and a closed chevron', () => {
    seq = 0;
    render(
      <ToolGroupRow
        entries={[at('thinking', 'let me reason'), at('tool_use', 'Bash: ls')]}
        summary="2 actions"
        expanded={false}
        onToggle={() => {}}
      />,
    );
    const header = screen.getByRole('button');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(header.textContent).toContain('2 actions');
    // Body is not rendered at all while collapsed.
    expect(screen.queryByText('let me reason')).toBeNull();
    expect(screen.queryByText(/Bash: ls/)).toBeNull();
  });

  it('expanded: reasoning and tool calls appear together, in transcript order', () => {
    seq = 0;
    const entries = [
      at('thinking', 'first I should look'),
      at('tool_use', 'Bash: ls'),
      at('tool_result', 'file.txt'),
      at('thinking', 'now I know'),
    ];
    const { container } = render(
      <ToolGroupRow entries={entries} summary="4 actions" expanded onToggle={() => {}} />,
    );
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true');

    const items = [...container.querySelectorAll('[data-kind]')];
    expect(items.map((el) => el.getAttribute('data-kind'))).toEqual([
      'thinking',
      'tool_use',
      'tool_result',
      'thinking',
    ]);
    expect(items[0]!.textContent).toBe('first I should look');
    expect(items[3]!.textContent).toBe('now I know');
    // tool_result keeps its ↳ prefix; thinking does not get one.
    expect(items[2]!.textContent).toContain('↳');
    expect(items[0]!.textContent).not.toContain('↳');
  });

  it('a redacted thinking block renders a label instead of a blank line', () => {
    seq = 0;
    const { container } = render(
      <ToolGroupRow
        entries={[at('thinking', '', { role: 'assistant', redacted: true })]}
        summary="1 action"
        expanded
        onToggle={() => {}}
      />,
    );
    // content is '' on redacted_thinking — without the substitution this row
    // is an empty div the user cannot account for.
    const item = container.querySelector('[data-kind="thinking"]')!;
    expect(item.textContent).toBe('Thinking (redacted)');
  });

  it('the header toggles, and the row is tagged for the transcript', () => {
    seq = 0;
    const onToggle = vi.fn();
    const { container } = render(
      <ToolGroupRow
        entries={[at('tool_use', 'Bash: ls')]}
        summary="1 action"
        expanded={false}
        onToggle={onToggle}
      />,
    );
    expect(container.querySelector('[data-row="tool-group"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
