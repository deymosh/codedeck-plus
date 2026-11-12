import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { pairPage } from '../pairPage.js';
import { parsePairLine } from '../pairing.js';

/**
 * What `codedeck-bridge pair --json` prints, one line per state: written by
 * the bridge's own test (bridge-runtime's pairing module), which fails when
 * the output changes, so this parser reads the real format.
 */
const FIXTURE = path.resolve(__dirname, '../../../../crates/bridge-runtime/tests/fixtures/pair-json.jsonl');

describe('parsePairLine', () => {
  const lines = readFileSync(FIXTURE, 'utf8').split(/\r?\n/).filter(Boolean);

  it('reads every state the bridge prints', () => {
    const statuses = lines.map(parsePairLine);
    expect(statuses.map((s) => s?.state)).toEqual(['open', 'paired', 'expired', 'closed']);
    const [open, paired] = statuses;
    expect(open).toMatchObject({ id: 'w1', url: 'nostr+codedeck://pair?token=tok1', expiresAtMs: 1_700_000_600_000 });
    expect(open?.qrSvg).toMatch(/^<svg[\s\S]*<\/svg>$/);
    expect(paired?.phone).toEqual({ label: 'Pixel 8', npub: 'npub1phone' });
  });

  it('skips what is not a status', () => {
    for (const line of ['', 'not json', '[]', 'null', '{"id":"w1","state":"opened"}', '{"state":"open"}', '{"id":"w1","state":"paired","phone":"x"}']) {
      expect(parsePairLine(line), line).toBeUndefined();
    }
  });
});

describe('pairPage', () => {
  it('shows the QR as an image and runs no script', () => {
    const open = parsePairLine(readFileSync(FIXTURE, 'utf8').split(/\r?\n/)[0]!)!;
    const html = pairPage(open, 'vscode-resource:');
    expect(html).toContain('src="data:image/svg+xml;base64,');
    expect(html).toContain('nostr+codedeck://pair?token=tok1');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("default-src 'none'");
  });

  it('escapes what the bridge reports', () => {
    const html = pairPage(
      { id: 'w1', state: 'paired', phone: { label: '<img src=x onerror=alert(1)>', npub: 'npub1"x' } },
      'vscode-resource:',
    );
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('npub1&quot;x');
  });
});
