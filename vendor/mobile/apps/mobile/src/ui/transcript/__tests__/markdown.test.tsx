// @vitest-environment jsdom
/**
 * CDX-011: syntax highlighting in transcript markdown. rehype-highlight is
 * lazy-loaded — the row renders plain first and re-renders highlighted when
 * the (module-cached) import lands.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { Markdown } from '../rows/Markdown';

afterEach(cleanup);

describe('Markdown syntax highlighting', () => {
  it('a ```ts fence gets highlight.js token spans (lazy plugin load)', async () => {
    const { container } = render(
      <Markdown>{'```ts\nconst n: number = 42; // answer\n```'}</Markdown>,
    );
    // Plain code block renders immediately (progressive enhancement).
    expect(container.querySelector('pre code')).toBeTruthy();
    // Once rehype-highlight lands: hljs class + tokenized spans on the tokens
    // theme (keyword/number/comment classes styled in rows.module.css).
    await waitFor(() => {
      const code = container.querySelector('pre code.hljs');
      expect(code).toBeTruthy();
      expect(code!.querySelector('.hljs-keyword')?.textContent).toBe('const');
      expect(code!.querySelector('.hljs-number')?.textContent).toBe('42');
      expect(code!.querySelector('.hljs-comment')).toBeTruthy();
    });
  });

  it('untagged fences stay unhighlighted (detect off — cheap and predictable)', async () => {
    const { container } = render(<Markdown>{'```\nsome plain preformatted text\n```'}</Markdown>);
    // The plugin is already cached from the previous test; give it a tick.
    await waitFor(() => expect(container.querySelector('pre code')).toBeTruthy());
    expect(container.querySelector('.hljs-keyword')).toBeNull();
    expect(container.querySelector('pre code')!.textContent).toContain(
      'some plain preformatted text',
    );
  });

  it('inline code and gfm tables still render (plugin chain intact)', async () => {
    const { container } = render(
      <Markdown>{'a `snippet` and\n\n| h |\n| - |\n| c |'}</Markdown>,
    );
    await waitFor(() => {
      expect(container.querySelector('code')?.textContent).toBe('snippet');
      expect(container.querySelector('table td')?.textContent).toBe('c');
    });
  });
});
