/**
 * Shared markdown renderer — react-markdown + remark-gfm (tables, task lists,
 * strikethrough — Claude uses all of them) + rehype-highlight for code blocks
 * (CDX-011: the Phase-3 "syntax highlighting" deferral).
 *
 * rehype-highlight (highlight.js/lowlight "common" grammar set) was chosen
 * over shiki: it slots straight into the existing react-markdown pipeline as
 * a rehype plugin and costs ~1/10th of shiki's textmate+wasm machinery. It is
 * LAZY-LOADED (vite code-splits the dynamic import) so the ~250KB grammar
 * bundle stays out of the boot path — the first markdown row triggers the
 * fetch, rows re-render highlighted the moment it lands (module-level cache:
 * one import ever, later rows render highlighted immediately). Theme lives in
 * rows.module.css on the app tokens (monochrome + semantic accents).
 */
import { useEffect, useState } from 'react';
import ReactMarkdown, { type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const remarkPlugins = [remarkGfm];

type RehypePlugins = NonNullable<Options['rehypePlugins']>;

/** Loaded-once rehype-highlight plugin list (null until the import lands). */
let loadedRehype: RehypePlugins | null = null;
const listeners = new Set<() => void>();
let importStarted = false;

function ensureHighlightLoaded(): void {
  if (importStarted) return;
  importStarted = true;
  void import('rehype-highlight')
    .then((mod) => {
      // subset:true (default) highlights fenced blocks by their ```lang tag
      // and skips detection on untagged blocks — cheap and predictable.
      loadedRehype = [[mod.default, { detect: false }]] as RehypePlugins;
      for (const notify of [...listeners]) notify();
    })
    .catch((err) => {
      // Highlighting is progressive enhancement — plain code blocks remain.
      console.log(`[Markdown] rehype-highlight failed to load: ${err}`);
    });
}

function useRehypeHighlight(): RehypePlugins | undefined {
  const [plugins, setPlugins] = useState<RehypePlugins | null>(loadedRehype);
  useEffect(() => {
    if (loadedRehype) return;
    const notify = (): void => setPlugins(loadedRehype);
    listeners.add(notify);
    ensureHighlightLoaded();
    return () => {
      listeners.delete(notify);
    };
  }, []);
  return plugins ?? undefined;
}

export function Markdown({ children }: { children: string }) {
  const rehypePlugins = useRehypeHighlight();
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
      {children}
    </ReactMarkdown>
  );
}
