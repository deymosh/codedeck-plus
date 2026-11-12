/**
 * The pairing panel's HTML for each state of the window. No script runs in
 * it: the QR is an image, the only link is a command link, and every value
 * from the bridge is escaped.
 */

import type { PairStatus } from './pairing.js';

const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export type PairView = PairStatus | { state: 'waiting' } | { state: 'failed'; message: string };

export function pairPage(view: PairView, cspSource: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline' ${cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pair a phone</title>
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    display: flex; justify-content: center;
    padding: 32px 16px;
  }
  main { max-width: 360px; width: 100%; text-align: center; }
  h1 { font-size: 1.3em; font-weight: 600; margin: 0 0 6px; }
  p { margin: 0 0 12px; line-height: 1.5; }
  .muted { color: var(--vscode-descriptionForeground); }
  .qr { display: block; width: 100%; max-width: 280px; margin: 20px auto; border-radius: 6px; image-rendering: pixelated; }
  code {
    display: block; word-break: break-all; text-align: left; user-select: all;
    font-family: var(--vscode-editor-font-family); font-size: 0.85em;
    padding: 8px 10px; border-radius: 4px;
    background: var(--vscode-textCodeBlock-background);
  }
  a { color: var(--vscode-textLink-foreground); }
</style>
</head>
<body><main>${body(view)}</main></body>
</html>`;
}

function body(view: PairView): string {
  const again = '<p><a href="command:codedeck.pair">Show a new code</a></p>';
  switch (view.state) {
    case 'waiting':
      return '<h1>Pair a phone</h1><p class="muted">Asking the bridge for a pairing code…</p>';
    case 'open': {
      const qr = view.qrSvg
        ? `<img class="qr" alt="Pairing QR code" src="data:image/svg+xml;base64,${Buffer.from(view.qrSvg).toString('base64')}">`
        : '';
      const until = view.expiresAtMs ? ` It is valid until ${escape(clock(view.expiresAtMs))}.` : '';
      const url = view.displayUrl ?? view.url;
      return `<h1>Pair a phone</h1>
<p class="muted">Scan this code with the CodeDeck+ app.${until}</p>
${qr}
${url ? `<p class="muted">Or paste this pairing URL into the app:</p><code>${escape(url)}</code>` : ''}`;
    }
    case 'paired':
      return `<h1>Phone paired</h1><p>${view.phone ? `<strong>${escape(view.phone.label)}</strong> can now drive the agents on this machine.` : 'A phone can now drive the agents on this machine.'}</p>
${view.phone ? `<p class="muted"><code>${escape(view.phone.npub)}</code></p>` : ''}`;
    case 'expired':
      return `<h1>The code expired</h1><p class="muted">No phone paired while it was valid.</p>${again}`;
    case 'closed':
      return `<h1>Pairing closed</h1><p class="muted">The bridge stopped, or another pairing replaced this one.</p>${again}`;
    case 'failed':
      return `<h1>Pairing failed</h1><p class="muted">${escape(view.message)}</p>${again}`;
  }
}
