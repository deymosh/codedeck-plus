/**
 * GSD state — reads a session's GSD workflow position so the phone can render a
 * stage strip. Ported from the old bridge's gsdState.ts (battle-tested against
 * a live GSD 1.8.0 install); only the type imports changed (@codedeck/protocol)
 * and the module now exports `GsdStateProvider` — the seam BridgeCore consumes,
 * so hosts/tests can substitute their own reader (`getGsdState` is the default
 * CLI-host implementation, reading the workspace's `.planning/` via gsd-tools).
 *
 * GSD (github.com/open-gsd/gsd-core) keeps its state under `<project>/.planning/`,
 * but we do NOT parse that markdown: GSD ships a machine-readable CLI and that
 * is the supported contract. Three queries, deliberately staged because they
 * fail differently:
 *
 *   1. `smart-entry --json`  — THE GATE. Never throws; returns clean JSON even
 *                              off a GSD project. `signals.has_planning ===
 *                              false` → not a GSD project.
 *   2. `query init.manager`  — THE STAGE MATRIX. Richest per-phase data, but
 *                              THROWS unless both ROADMAP.md and STATE.md
 *                              exist. Always guarded + try/caught.
 *   3. `progress`            — percentage/milestone, and the fallback phase
 *                              list when (2) is unavailable. Never throws.
 *
 * Two more, fetched only when they can say something:
 *
 *   4. `query phase-plan-index N` — per-plan `autonomous` / `task_count` /
 *                              `has_summary`. Capped at MAX_PREFLIGHT_PHASES.
 *   5. `git log`             — GSD commits every task atomically as
 *                              `type(phase-plan): desc`; during a parallel wave
 *                              that log is the ONLY thing that moves.
 *
 * Everything is best-effort: a missing gsd-tools, a non-GSD directory, a
 * timeout, or malformed JSON all degrade to a blank snapshot. A broken GSD
 * install must never break a normal session.
 *
 * Two gotchas encoded here, both verified against a live 1.8.0 install:
 *   - gsd-tools writes warnings to STDERR. We parse stdout only.
 *   - `smart-entry` emits NAMESPACED commands (`/gsd:plan-phase`) while a flat
 *     install needs `/gsd-plan-phase`. See normalizeCommand().
 */

import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GsdAction, GsdPhase, GsdState } from '@codedeck/protocol';

/** The seam BridgeCore consumes — hosts/tests can substitute their own reader. */
export type GsdStateProvider = (cwd: string) => Promise<GsdState>;

/** Cap any single gsd-tools call. These are local file walks — fast unless something is wrong. */
const GSD_TIMEOUT_MS = 5_000;
const GSD_MAX_BUFFER = 4 * 1024 * 1024;

/** Collapse request bursts (session open + turn end can land together) onto one exec batch. */
const CACHE_TTL_MS = 2_000;

/** A runaway roadmap must not bloat a single relay event. */
const MAX_PHASES = 40;

/** Cap the pre-flight fan-out: one phase-plan-index exec per actionable phase, at most this many. */
const MAX_PREFLIGHT_PHASES = 3;

/** How far back to read task commits. A phase's worth of tasks is well inside this. */
const TASK_COMMIT_SCAN = 80;

function blank(installed: boolean): GsdState {
  return {
    installed,
    available: false,
    hasGit: false,
    situation: installed ? 'unknown' : 'not-installed',
    summary: '',
    milestone: null,
    currentPhase: null,
    totalPhases: null,
    percent: 0,
    phases: [],
    actions: [],
    recommended: null,
    paused: false,
    blockers: [],
    verifyFailed: false,
    execution: null,
  };
}

const NOT_INSTALLED: GsdState = blank(false);

/**
 * Locate `gsd-tools.cjs`. GSD 1.8.0 is laid down by an ephemeral `npx`, so
 * there is NO `gsd-tools` binary on PATH — the .cjs must be invoked with node.
 * Resolved once and cached; `null` means GSD isn't installed.
 */
function resolveGsdTools(): string | null {
  if (process.env.CODEDECK_GSD_TOOLS_PATH) {
    return fs.existsSync(process.env.CODEDECK_GSD_TOOLS_PATH) ? process.env.CODEDECK_GSD_TOOLS_PATH : null;
  }
  const home = os.homedir();
  const candidates = [
    path.join(home, '.claude', 'gsd-core', 'bin', 'gsd-tools.cjs'),
    path.join(home, '.config', 'opencode', 'gsd-core', 'bin', 'gsd-tools.cjs'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

let gsdToolsPath: string | null | undefined;
function gsdTools(): string | null {
  if (gsdToolsPath === undefined) gsdToolsPath = resolveGsdTools();
  return gsdToolsPath;
}

/**
 * Does this machine install GSD's slash commands namespaced
 * (`~/.claude/commands/gsd/plan-phase.md` → `/gsd:plan-phase`) or flat
 * (`~/.claude/commands/gsd-plan-phase.md` → `/gsd-plan-phase`)? smart-entry
 * always emits the namespaced form, so on a flat install every tapped command
 * would be an unknown-command no-op unless we rewrite it.
 */
function usesNamespacedCommands(): boolean {
  try {
    return fs.statSync(path.join(os.homedir(), '.claude', 'commands', 'gsd')).isDirectory();
  } catch {
    return false;
  }
}

let namespaced: boolean | undefined;

/** `/gsd:plan-phase` → `/gsd-plan-phase` on a flat install; left alone on a namespaced one. */
export function normalizeCommand(command: string, forceNamespaced?: boolean): string {
  const ns = forceNamespaced ?? (namespaced ??= usesNamespacedCommands());
  if (ns) return command;
  return command.replace(/^\/gsd:/, '/gsd-');
}

/**
 * Reconcile the two phase counts GSD reports (CD-054).
 *
 * `smart-entry`'s `total_phases` counts `.planning/phases/` DIRECTORIES, and
 * only a phase that has been planned has one. `roadmap_total_phases` is the
 * real count parsed from ROADMAP.md, so prefer it — and scale the percentage
 * by the fraction of the roadmap GSD can actually see (a finished phase 1 of 5
 * becomes 20%, not 100%).
 */
export function resolvePhaseTotals(input: {
  roadmapTotal: number | null;
  diskTotal: number | null;
  rawPercent: number;
}): { totalPhases: number | null; percent: number } {
  const { roadmapTotal, diskTotal, rawPercent } = input;
  const totalPhases = roadmapTotal ?? diskTotal;
  const scale = roadmapTotal && diskTotal && roadmapTotal > diskTotal ? diskTotal / roadmapTotal : 1;
  return { totalPhases, percent: Math.round(rawPercent * scale) };
}

interface RunResult { ok: boolean; stdout: string; }

/** Run gsd-tools and return STDOUT only — warnings go to stderr and would break JSON.parse. */
function runGsd(tools: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [tools, ...args, '--cwd', cwd],
      { timeout: GSD_TIMEOUT_MS, maxBuffer: GSD_MAX_BUFFER, encoding: 'utf8' },
      (err, stdout) => resolve({ ok: !err, stdout: String(stdout ?? '').trim() }),
    );
  });
}

/** Read recent commit subjects. Best-effort: no git, no repo, or a git error → empty. */
function gitSubjects(cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, 'log', '--no-merges', `-n${TASK_COMMIT_SCAN}`, '--pretty=format:%s'],
      { timeout: GSD_TIMEOUT_MS, maxBuffer: GSD_MAX_BUFFER, encoding: 'utf8' },
      (err, stdout) => resolve(err ? [] : String(stdout ?? '').split('\n').filter(Boolean)),
    );
  });
}

/**
 * GSD's task-commit convention: `{type}({phase}-{plan}): {description}`, e.g.
 * `feat(04-01): implement payment session creation`. Phase may be decimal
 * (`2.1`) for inserted phases. Anything else in the log is ordinary work.
 */
const TASK_COMMIT_RE = /^\w+\((\d+(?:\.\d+)*)-(\d+)\):\s*(.+)$/;

interface TaskCommit { phase: string; plan: string; desc: string }

export function parseTaskCommits(subjects: string[]): TaskCommit[] {
  const out: TaskCommit[] = [];
  for (const s of subjects) {
    const m = TASK_COMMIT_RE.exec(s);
    if (m) out.push({ phase: m[1]!, plan: m[2]!, desc: m[3]! });
  }
  return out; // newest-first, mirroring git log order
}

/** Phase ids appear as both '2' and '02' across GSD's own outputs — compare numerically. */
function samePhase(a: string, b: string): boolean {
  const na = parseFloat(a), nb = parseFloat(b);
  return Number.isFinite(na) && Number.isFinite(nb) ? na === nb : a === b;
}

async function queryJson<T>(tools: string, args: string[], cwd: string): Promise<T | null> {
  const r = await runGsd(tools, args, cwd);
  if (!r.ok || !r.stdout) return null;
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    return null; // human-readable output or a partial write — treat as unavailable
  }
}

// --- Raw shapes returned by gsd-tools (only the fields we consume) ---

interface SmartEntryOut {
  situation?: string;
  recommended?: string;
  summary?: string;
  signals?: {
    /** NOTE: arrives as a NUMBER despite STATE.md quoting it. Coerced at the call site. */
    current_phase?: string | number | null;
    /** Counted from `.planning/phases/` DIRECTORIES — prefer roadmap_total_phases (CD-054). */
    total_phases?: number | null;
    /** The real phase count, parsed from ROADMAP.md. Null before a roadmap exists. */
    roadmap_total_phases?: number | null;
    has_planning?: boolean;
    has_roadmap?: boolean;
    has_git?: boolean;
    paused?: boolean;
    blockers?: unknown[];
    verify_failed?: boolean;
  };
  actions?: Array<{ id?: string; label?: string; command?: string; recommended?: boolean }>;
}

interface PlanIndexOut {
  plans?: Array<{ id?: string; autonomous?: boolean; task_count?: number; has_summary?: boolean }>;
  incomplete?: string[];
  has_checkpoints?: boolean;
}

interface ManagerOut {
  phases?: Array<{
    number?: string;
    name?: string;
    display_name?: string;
    disk_status?: string;
    plan_count?: number;
    summary_count?: number;
    is_active?: boolean;
  }>;
  recommended_actions?: Array<{ phase?: string; action?: string; command?: string }>;
  phase_count?: number;
}

interface ProgressOut {
  milestone_version?: string;
  milestone_name?: string;
  percent?: number;
  phases?: Array<{ number?: string; name?: string; status?: string; plans?: number; summaries?: number }>;
}

/** `progress`'s human-facing status labels → `init.manager`'s disk_status vocabulary. */
const PROGRESS_STATUS_TO_DISK: Record<string, string> = {
  'Complete': 'complete',
  'Needs Review': 'executed',
  'Executed': 'executed',
  'In Progress': 'partial',
  'Planned': 'planned',
  'Pending': 'empty',
};

function milestoneLabel(p: ProgressOut | null): string | null {
  if (!p) return null;
  const version = p.milestone_version || '';
  const name = p.milestone_name && p.milestone_name !== 'milestone' ? p.milestone_name : '';
  const label = [version, name].filter(Boolean).join(' — ');
  return label || null;
}

interface CacheEntry { at: number; value: GsdState }
const cache = new Map<string, CacheEntry>();

/** Test seam — drop memoized state so a fixture change is picked up immediately. */
export function clearGsdCache(): void {
  cache.clear();
  gsdToolsPath = undefined;
  namespaced = undefined;
}

/**
 * Resolve the GSD stage snapshot for a session's working directory.
 * `available: false` means there's no `.planning/` here; `installed` still says
 * whether GSD exists on this machine. `--cwd` makes gsd-tools walk up for the
 * project root, so a subdirectory cwd works fine.
 */
export async function getGsdState(cwd: string): Promise<GsdState> {
  if (!cwd) return NOT_INSTALLED;

  const cached = cache.get(cwd);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const value = await computeGsdState(cwd);
  cache.set(cwd, { at: Date.now(), value });
  return value;
}

function toActions(entry: SmartEntryOut): GsdAction[] {
  return (entry.actions ?? [])
    .filter((a) => typeof a.command === 'string' && typeof a.id === 'string')
    .map((a) => ({
      id: a.id as string,
      label: a.label || (a.id as string),
      command: normalizeCommand(a.command as string),
      recommended: a.recommended === true,
    }));
}

async function computeGsdState(cwd: string): Promise<GsdState> {
  const tools = gsdTools();
  if (!tools) return NOT_INSTALLED;

  // 1. The gate. Never throws, so a null here means something is genuinely wrong.
  const entry = await queryJson<SmartEntryOut>(tools, ['smart-entry', '--json'], cwd);
  if (!entry) return blank(true);

  // Not a GSD project *yet*. Still return `installed: true` plus the actions GSD
  // offers for the no-project situation, so an opted-in session can show a
  // Start button.
  if (entry.signals?.has_planning !== true) {
    return {
      ...blank(true),
      hasGit: entry.signals?.has_git === true,
      situation: entry.situation || 'no-project',
      summary: entry.summary || '',
      actions: toActions(entry),
      recommended: entry.recommended ?? null,
    };
  }

  // 2 + 3. init.manager is guarded on has_roadmap AND still try/caught via
  // queryJson's null (it also throws when STATE.md is missing).
  const [manager, progress] = await Promise.all([
    entry.signals?.has_roadmap === true
      ? queryJson<ManagerOut>(tools, ['query', 'init.manager'], cwd)
      : Promise.resolve(null),
    queryJson<ProgressOut>(tools, ['progress'], cwd),
  ]);

  const phases = manager?.phases?.length
    ? phasesFromManager(manager)
    : phasesFromProgress(progress);

  // STATE.md's `current_phase: '2'` comes back through smart-entry as a NUMBER —
  // coerce or the phone's current-phase highlight silently never fires.
  const rawPhase = entry.signals?.current_phase;
  const currentPhase = rawPhase === null || rawPhase === undefined ? null : String(rawPhase);

  // 4. Pre-flight + live progress both need phase-plan-index; fetch each phase
  // once and share. Only phases GSD wants *executed* are worth the exec.
  const wanted: string[] = [];
  for (const p of phases) {
    if (p.action === 'execute' && wanted.length < MAX_PREFLIGHT_PHASES) wanted.push(p.number);
  }
  if (currentPhase && !wanted.some((w) => samePhase(w, currentPhase))) {
    wanted.unshift(currentPhase);
    wanted.length = Math.min(wanted.length, MAX_PREFLIGHT_PHASES);
  }

  const indexEntries = await Promise.all(
    wanted.map(async (n) => [n, await queryJson<PlanIndexOut>(tools, ['query', 'phase-plan-index', n], cwd)] as const),
  );
  const planIndex = new Map(indexEntries.filter(([, v]) => v).map(([n, v]) => [n, v as PlanIndexOut]));

  for (const p of phases) {
    const idx = planIndex.get(p.number);
    if (!idx?.plans) continue;
    p.planCount = idx.plans.length;
    // "Needs you" == plans with `autonomous: false` in their frontmatter.
    p.needsYou = idx.plans.filter((pl) => pl.autonomous === false).length;
  }

  const execution = buildExecution(currentPhase, planIndex, await gitSubjects(cwd), entry.situation);

  const signals = entry.signals ?? {};

  const { totalPhases, percent } = resolvePhaseTotals({
    roadmapTotal: signals.roadmap_total_phases ?? null,
    // `|| null` on the last fallback: a phase-less project should read "unknown", not "0 phases".
    diskTotal: signals.total_phases ?? manager?.phase_count ?? (phases.length || null),
    rawPercent: typeof progress?.percent === 'number' ? progress.percent : 0,
  });

  return {
    installed: true,
    available: true,
    hasGit: signals.has_git === true,
    situation: entry.situation || 'unknown',
    // Deliberately NOT re-derived for the strip's collapsed line — GSD bakes the
    // same wrong phase count into the summary string; the phone re-derives it.
    summary: entry.summary || '',
    milestone: milestoneLabel(progress),
    currentPhase,
    totalPhases,
    percent,
    phases,
    actions: toActions(entry),
    recommended: entry.recommended ?? null,
    paused: signals.paused === true,
    blockers: (signals.blockers ?? []).map((b) => (typeof b === 'string' ? b : JSON.stringify(b))).slice(0, 5),
    verifyFailed: signals.verify_failed === true,
    execution,
  };
}

/**
 * Reconstruct live progress inside the phase being executed. plansDone comes
 * from `has_summary`; task counts come from the atomic commits. Returns null
 * unless there is something real to show — a strip that invents progress is
 * worse than one that admits it doesn't know.
 */
function buildExecution(
  currentPhase: string | null,
  planIndex: Map<string, PlanIndexOut>,
  subjects: string[],
  situation: string | undefined,
): GsdState['execution'] {
  if (!currentPhase) return null;

  let idx: PlanIndexOut | undefined;
  for (const [num, v] of planIndex) { if (samePhase(num, currentPhase)) { idx = v; break; } }
  if (!idx?.plans?.length) return null;

  const commits = parseTaskCommits(subjects).filter((c) => samePhase(c.phase, currentPhase));
  // Nothing committed and not executing → the phase hasn't started; don't fake a 0/N readout.
  if (commits.length === 0 && situation !== 'executing') return null;

  const plansTotal = idx.plans.length;
  const plansDone = idx.plans.filter((p) => p.has_summary === true).length;

  // The in-flight plan is the first incomplete one; fall back to whatever last committed.
  const currentPlanId = idx.incomplete?.[0] ?? (commits[0] ? `${currentPhase}-${commits[0].plan}` : null);
  const planSuffix = currentPlanId ? currentPlanId.split('-').pop() ?? null : null;

  const planCommits = planSuffix ? commits.filter((c) => c.plan === planSuffix) : [];
  const declared = currentPlanId
    ? idx.plans.find((p) => p.id === currentPlanId)?.task_count ?? null
    : null;

  return {
    phase: currentPhase,
    plansTotal,
    plansDone,
    currentPlan: currentPlanId,
    tasksDone: planCommits.length,
    tasksTotal: declared && declared > 0 ? declared : null,
    lastTask: commits[0]?.desc ?? null,
  };
}

function phasesFromManager(manager: ManagerOut): GsdPhase[] {
  // recommended_actions is per-phase and its `command` is already in the flat `/gsd-...` form.
  const byPhase = new Map<string, { action?: string; command?: string }>();
  for (const a of manager.recommended_actions ?? []) {
    if (a.phase) byPhase.set(String(a.phase), a);
  }
  return (manager.phases ?? []).slice(0, MAX_PHASES).map((p) => {
    const number = String(p.number ?? '');
    const rec = byPhase.get(number);
    return {
      number,
      name: p.display_name || p.name || '',
      diskStatus: p.disk_status || 'empty',
      plans: p.plan_count ?? 0,
      summaries: p.summary_count ?? 0,
      recentlyTouched: p.is_active === true,
      action: rec?.action ?? null,
      command: rec?.command ?? null,
      planCount: null,
      needsYou: null,
    };
  });
}

function phasesFromProgress(progress: ProgressOut | null): GsdPhase[] {
  return (progress?.phases ?? []).slice(0, MAX_PHASES).map((p) => ({
    number: String(p.number ?? ''),
    name: p.name || '',
    diskStatus: PROGRESS_STATUS_TO_DISK[p.status || ''] || 'empty',
    plans: p.plans ?? 0,
    summaries: p.summaries ?? 0,
    recentlyTouched: false,
    action: null,
    command: null,
    planCount: null,
    needsYou: null,
  }));
}
