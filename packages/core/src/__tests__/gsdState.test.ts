/**
 * GSD state reader — ported pure-logic tests from the old bridge's
 * gsdState.test.ts (normalizeCommand, resolvePhaseTotals CD-054, task-commit
 * parsing) plus the degradation contract (missing tools / empty cwd). The
 * old fixture suite against a live gsd-tools install is deliberately NOT
 * ported (environment-dependent); the compute pipeline itself is a verbatim
 * port and BridgeCore consumes it behind the injectable GsdStateProvider.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  clearGsdCache,
  getGsdState,
  normalizeCommand,
  parseTaskCommits,
  resolvePhaseTotals,
} from '../workspace/gsdState';

describe('normalizeCommand', () => {
  it('rewrites the namespaced form to the flat form on a flat install', () => {
    expect(normalizeCommand('/gsd:plan-phase', false)).toBe('/gsd-plan-phase');
  });

  it('leaves commands alone on a namespaced install', () => {
    expect(normalizeCommand('/gsd:plan-phase', true)).toBe('/gsd:plan-phase');
  });

  it('only rewrites the leading /gsd: prefix', () => {
    expect(normalizeCommand('/gsd:execute-phase 2 --cwd /x/gsd:y', false))
      .toBe('/gsd-execute-phase 2 --cwd /x/gsd:y');
  });
});

describe('resolvePhaseTotals — CD-054', () => {
  it('prefers the roadmap count over the on-disk directory count', () => {
    expect(resolvePhaseTotals({ roadmapTotal: 5, diskTotal: 1, rawPercent: 100 }))
      .toEqual({ totalPhases: 5, percent: 20 });
  });

  it('scales the percentage to the whole roadmap, not just the planned phases', () => {
    expect(resolvePhaseTotals({ roadmapTotal: 4, diskTotal: 2, rawPercent: 50 }))
      .toEqual({ totalPhases: 4, percent: 25 });
  });

  it('leaves the percentage alone once every phase has been planned', () => {
    expect(resolvePhaseTotals({ roadmapTotal: 3, diskTotal: 3, rawPercent: 66 }))
      .toEqual({ totalPhases: 3, percent: 66 });
  });

  it('never scales up when more phases exist on disk than the roadmap lists', () => {
    expect(resolvePhaseTotals({ roadmapTotal: 2, diskTotal: 3, rawPercent: 40 }))
      .toEqual({ totalPhases: 2, percent: 40 });
  });

  it('falls back to the disk count before a roadmap exists', () => {
    expect(resolvePhaseTotals({ roadmapTotal: null, diskTotal: 2, rawPercent: 10 }))
      .toEqual({ totalPhases: 2, percent: 10 });
  });
});

describe('parseTaskCommits', () => {
  it('parses GSD task commits and ignores ordinary work', () => {
    expect(parseTaskCommits([
      'feat(04-01): implement payment session creation',
      'fix a typo',
      'chore(2.1-03): wire the flag',
      'feat(CDX-005): not a gsd commit',
    ])).toEqual([
      { phase: '04', plan: '01', desc: 'implement payment session creation' },
      { phase: '2.1', plan: '03', desc: 'wire the flag' },
    ]);
  });
});

describe('getGsdState — degradation', () => {
  const envBackup = process.env.CODEDECK_GSD_TOOLS_PATH;

  beforeEach(() => {
    clearGsdCache();
  });

  afterEach(() => {
    if (envBackup === undefined) delete process.env.CODEDECK_GSD_TOOLS_PATH;
    else process.env.CODEDECK_GSD_TOOLS_PATH = envBackup;
    clearGsdCache();
  });

  it('reports unavailable for an empty cwd', async () => {
    const state = await getGsdState('');
    expect(state.available).toBe(false);
    expect(state.installed).toBe(false);
    expect(state.phases).toEqual([]);
  });

  it('reports NOT installed when gsd-tools is missing — distinct from "not set up yet"', async () => {
    process.env.CODEDECK_GSD_TOOLS_PATH = '/definitely/not/here/gsd-tools.cjs';
    clearGsdCache();
    const state = await getGsdState('/tmp');
    expect(state.installed).toBe(false);
    expect(state.available).toBe(false);
    expect(state.situation).toBe('not-installed');
  });
});
