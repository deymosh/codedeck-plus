/**
 * The OpenCode driver, over `@opencode/client` — the API OpenCode 2.x
 * servers serve.
 *
 * One `OpenCodeSession` per bridge session: it subscribes to the server's
 * event stream, normalizes it down to stable `OpenCodeEvent`s (adapter.ts
 * translates those into entries), and answers OpenCode's permission asks and
 * its forms (the cards a question becomes) through the bridge.
 *
 * Deliberate limits:
 *  - an "always allow" reply is OpenCode's own `always`: a rule it saves for
 *    the project, which outlives the session and the server — listed and
 *    revoked through `permissionRules` (permissionRules.ts);
 *  - no subscription usage: OpenCode has no equivalent to ask, and a
 *    fabricated number would be worse than none. Context usage is reported
 *    only for models whose provider declares a context limit;
 *  - no effort levels of its own; models are `provider/model` ids, and a
 *    reasoning level rides on the model as a v2 variant.
 *
 * Provider profiles are added to the server this driver starts as
 * providers of their own (providers.ts): their models join the list beside
 * OpenCode Zen and the operator's providers, and a session picks one like
 * any other.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { OpenCode, type ModelInfo, type OpenCodeClient, type PermissionAsked, type PermissionRule, type ProviderInfo, type SessionInfo, type V2Event } from '@opencode/client';
import { parseSlashCommand, slashCommand } from '../../sdk/commands';
import type { Driver, DriverSession, McpManager, PermissionRuleManager, PluginManager, SessionContext, SessionMcpState } from '../../sdk/driver';
import { PERMISSION_ALLOW, PERMISSION_ALLOW_ALWAYS, PERMISSION_DENY, toolLocations, unknownToolReporter } from '../../sdk/tools';
import { opencodeTool } from './tools';
import { newTranslateContext, type TranslateContext } from '../../sdk/transcript';
import { PartialCoalescer } from '../../sdk/partial';
import type {
  AgentInfo,
  ContextBreakdown,
  ContextCategory,
  ModelEntry,
  OptionChoice,
  PermissionOption,
  ProviderBinding,
  QuestionReply,
  QuestionSpec,
  RefusedProvider,
  SessionOption,
  SlashCommand,
  StartSession,
  Subagent,
  TaskStatus,
  UsageData,
} from '../../sdk/types';
import {
  opencodeEventToEntries,
  QUESTION_TOOL,
  SHELL_TOOL,
  toolCallDiffs,
  toolResultText,
  type OpenCodeEvent,
} from './adapter';
import { SESSION_COMMANDS, sessionCommand, sessionSlashCommands } from './sessionCommands';
import { OpenCodeMcp, openCodeSessionMcp, toggleOpenCodeMcp } from './mcp';
import { OpenCodePlugins } from './plugins';
import { OpenCodePermissionRules } from './permissionRules';
import { OpenCodeAccounts } from './accounts';
import { type Catalog, EMPTY_CATALOG } from './catalog';
import { NOTHING_SERVED, type Placement, placeProfiles, profileModelGroup, providersFingerprint, type Served, servedBy, serverSetup } from './providers';
import {
  resolveOpenCodePath,
  startOpenCodeServer,
  type OpenCodeServerHandle,
  type StartOpenCodeServerOptions,
} from './server';
import type { ProviderHttp } from '../../sdk/net';
import { isValidProviderBaseUrl } from '../../sdk/provider';
import { checkToken, listModels, OPENAI_API } from '../../sdk/providerApi';
import type { EndpointModel } from '../../sdk/providerModels';
import { OPENCODE_STYLE } from './style';

export const OPENCODE_AGENT_ID = 'opencode';

/** `ask` sends every permission OpenCode asks for to the phone; `default`
 *  (the auto-approve mode every agent shares) allows them all; `plan` runs
 *  OpenCode's own plan agent, which may not edit, asking like `ask`. */
const AUTO_APPROVE_MODE = 'default';
const DEFAULT_MODE = 'ask';
const PLAN_MODE = 'plan';
const OPENCODE_MODES = [
  { id: DEFAULT_MODE, label: 'Ask', description: 'Ask before each tool call' },
  { id: PLAN_MODE, label: 'Plan', description: 'Explore and plan without editing; switch to Ask or YOLO to build it' },
  { id: AUTO_APPROVE_MODE, label: 'YOLO', description: 'Run every tool without asking' },
];
/** The OpenCode agent the plan mode runs. In any other mode a prompt names
 *  none, so OpenCode uses its default agent (`build`, or the operator's). */
const PLAN_AGENT = 'plan';
/** The agent every other mode runs. */
const BUILD_AGENT = 'build';

/**
 * The permission rules a session runs under, from its mode and the rules of
 * the agent it runs.
 *
 * V2's base policy ALLOWS every tool in the project: left alone, a session
 * would never ask, and the phone's approval card would never appear. The ask
 * modes therefore state the rule that makes OpenCode ask — the last matching
 * rule wins, and `*`/`*` matches everything — while the auto-approve mode
 * states the allow it already had, so a mode switch always lands on an
 * explicit rule rather than on whatever the operator configured.
 *
 * The session's rules are matched after the agent's own, so that catch-all
 * alone would also override what the agent forbids (the plan agent's
 * `edit` deny, a custom agent's `shell` deny). The agent's rules therefore
 * follow it again, in their order: a deny stays a deny, and every other
 * effect becomes the mode's — the mode decides whether a call asks, the
 * agent what it may never do.
 */
export function permissionRules(mode: string, agentRules: readonly PermissionRule[] = []): PermissionRule[] {
  const effect = mode === AUTO_APPROVE_MODE ? 'allow' : 'ask';
  return [
    { action: '*', resource: '*', effect },
    ...agentRules.map((rule): PermissionRule => ({ action: rule.action, resource: rule.resource, effect: rule.effect === 'deny' ? rule.effect : effect })),
  ];
}

/** OpenCode's "always": it saves a rule for the project that every later
 *  session obeys, across server restarts, until it is removed. The rule is
 *  the pattern OpenCode offers with the ask (`echo *` for `echo hi`), often
 *  wider than the call on the card, so the label names it. */
function allowInProject(save: readonly string[]): PermissionOption {
  const what = save.map((pattern) => `"${pattern}"`).join(', ');
  return { ...PERMISSION_ALLOW_ALWAYS, label: `Always allow ${what} in this project` };
}

type SessionPermissionAsk = PermissionAsked['data'];

/** A sub-agent's child session, as its `subagent` call described it. */
interface ChildSession {
  callId: string;
  title: string;
  label?: string;
  /** The sub-agent was left running in the background, and has not ended. */
  background: boolean;
  /** The user asked it to stop: its end is a stop, not a completion. */
  stopping: boolean;
  /** The child session has ended, however it ended. A call that finishes
   *  after its child already went idle did not leave anything running. */
  ended: boolean;
}

function subagentOf(child: ChildSession): Subagent {
  return { ...(child.label ? { label: child.label } : {}), parentCallId: child.callId };
}

/** The stable id of a reply part: its message and the part's ordinal within
 *  it — the same identity every event of the part (started, each delta,
 *  ended) carries, so its `partial`s and the `text` entry that replaces them
 *  agree on the key. */
function partKey(data: { assistantMessageID: string; ordinal: number }): string {
  return `${data.assistantMessageID}:${data.ordinal}`;
}

/** The tool OpenCode uses to ask the user questions. Its own call is not
 *  shown as a generic tool row: the form it raises renders as a question
 *  card instead (see handleForm). */
const SUBAGENT_TOOL = 'subagent';

/** `model/providerID` split — a v2 model reference wants `{providerID, id}`,
 *  not a single string. A model id with no `/` (or an empty half) has no
 *  valid split, so nothing is named and OpenCode falls back to its own
 *  configured default — no fabrication. */
function splitModelId(model: string | undefined): { providerID: string; id: string } | undefined {
  if (!model) return undefined;
  const i = model.indexOf('/');
  if (i <= 0 || i === model.length - 1) return undefined;
  return { providerID: model.slice(0, i), id: model.slice(i + 1) };
}

/** OpenCode's models and the one a session defaults to. */
export interface OpenCodeCatalog {
  models: ModelEntry[];
  defaultModel?: string;
  /** Context window per model id, for the models whose provider declares
   *  one. A provider that declares none reports 0, and OpenCode then has no
   *  size to compact against (its auto-compaction threshold is derived from
   *  the window, and is unbounded without one), so such a model has no entry
   *  here rather than a guessed size. */
  contextLimits?: Record<string, number>;
}

/**
 * What the context holds after one assistant step: the prompt that step sent
 * (its uncached input, what the provider read from its cache and what it
 * wrote there) plus the reply it produced (its text and its reasoning),
 * which the next step sends back as part of its prompt.
 *
 * These are a STEP's counters — `session.step.ended`'s. They must never be
 * fed the session's own totals (`session.usage.updated`), which only ever
 * grow: they count every step, tool call, title and compaction the session
 * has ever paid for, so a meter built from them climbs to the window's size
 * and stays pinned there while the context itself is nearly empty.
 */
export function contextTokens(tokens: SessionInfo['tokens']): number {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write;
}

/** A provider retry as the phone shows it: why, which attempt, and when
 *  the next one goes. */
export function retryText(status: { attempt: number; message: string; next: number }, now: number): string {
  const wait = Math.max(0, Math.round((status.next - now) / 1000));
  const why = status.message.trim() || 'the provider failed';
  return `${why} — retrying (attempt ${status.attempt}${wait > 0 ? `, in ${wait} s` : ''})`;
}

/**
 * What the context window held at a session's last step, as far as OpenCode
 * counts it: the prompt (the part the provider had cached, and the rest)
 * and the reply (its reasoning, its text), which the next step reads as part
 * of its prompt. Nothing without the window's size.
 */
export function openCodeContext(tokens: SessionInfo['tokens'], window: number | undefined): ContextBreakdown | undefined {
  if (!window || window <= 0) return undefined;
  const parts: Array<[string, number]> = [
    ['Cached prompt', tokens.cache.read],
    ['New prompt', tokens.input + tokens.cache.write],
    ['Reasoning', tokens.reasoning],
    ['Reply', tokens.output],
  ];
  const whole = (n: number) => Math.min(Math.max(0, Math.round(n)), 0xffff_ffff);
  const used = whole(parts.reduce((sum, [, n]) => sum + n, 0));
  const categories: ContextCategory[] = parts
    .filter(([, n]) => n > 0)
    .map(([name, n]) => ({ name, tokens: whole(n), kind: 'used' as const }));
  categories.push({ name: 'Free space', tokens: whole(window - used), kind: 'free' });
  return { usedTokens: used, windowTokens: whole(window), categories };
}

/** The provider OpenCode Zen serves under — the one provider every OpenCode
 *  install has, whose free models need no API key at all. */
const ZEN_PROVIDER = 'opencode';

/**
 * The model a session runs when the phone names none, as a
 * `<providerID>/<modelID>` id from `models`: the model OpenCode's own
 * default names, when it is one of them; else a free OpenCode Zen model,
 * which works with no credential set up; else the first model that is not
 * deprecated. Deprecated models are skipped, and a model the server does not
 * offer at all is never named.
 */
export function pickDefaultModel(configured: string | undefined, models: ModelInfo[]): string | undefined {
  const usable = models.filter((m) => m.status !== 'deprecated' && m.enabled);
  const ids = new Set(usable.map((m) => `${m.providerID}/${m.modelID}`));
  if (configured && ids.has(configured)) return configured;
  const free = usable.find((m) => m.providerID === ZEN_PROVIDER && m.cost.every((c) => c.input === 0 && c.output === 0));
  if (free) return `${free.providerID}/${free.modelID}`;
  const first = usable[0];
  return first ? `${first.providerID}/${first.modelID}` : undefined;
}

/** The variant OpenCode reads as "none": the model's own settings. */
const DEFAULT_VARIANT = 'default';

/** How a variant reads in the effort picker. */
const VARIANT_LABELS: Record<string, string> = { xhigh: 'Extra high', none: 'None' };

/** A model's reasoning levels, from its OpenCode variants (`low`, `high`,
 *  `max`…, set by OpenCode from what the model is): its default first. A
 *  model without variants has none. */
export function reasoningLevels(variants: ModelInfo['variants'] | undefined): OptionChoice[] {
  const ids = (variants ?? []).map((v) => v.id).filter((id) => id !== DEFAULT_VARIANT);
  if (ids.length === 0) return [];
  const label = (id: string) => VARIANT_LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
  return [{ id: DEFAULT_VARIANT, label: 'Default' }, ...ids.map((id) => ({ id, label: label(id) }))];
}

/** The name OpenCode gives a session it has not titled yet
 *  ("New session - <ISO time>"; "Child session - …" for a sub-agent's). */
const PLACEHOLDER_TITLE = /^(New|Child) session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isPlaceholderTitle(title: string): boolean {
  return PLACEHOLDER_TITLE.test(title);
}

export function unsupportedModelReason(model: string, models: ModelEntry[]): string | undefined {
  if (models.length === 0 || models.some((m) => m.id === model)) return undefined;
  return `OpenCode does not offer the model '${model}' — none of its configured providers serves it; choose one from its model list.`;
}

/** Best-effort human-readable text out of a v2 structured error. */
export function formatOpenCodeError(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as { message?: unknown; name?: unknown; data?: { message?: unknown } };
    if (typeof e.message === 'string' && e.message !== '') return e.message;
    if (typeof e.data?.message === 'string') return e.data.message;
    if (typeof e.name === 'string') return e.name;
  }
  return 'OpenCode reported an error';
}

/**
 * The phone-facing description of a permission ask. V2 names the RULE that
 * needs approval (`external_directory`, `edit`, `shell`, …), not the tool;
 * the tool itself is shown as the card's title (see fromAsk), so this says
 * what the approval is actually for.
 */
export function describePermission(permission: string, patterns: string[]): string {
  const what = patterns.filter((p) => p.length > 0).join(', ');
  switch (permission) {
    case 'external_directory':
      return what ? `Access outside the project: ${what}` : 'Access outside the project';
    case 'doom_loop':
      return 'The same tool call keeps repeating — let it continue?';
    case 'shell':
      return what ? `Run: ${what}` : 'Run a shell command';
    case 'edit':
      return what ? `Edit: ${what}` : 'Edit files';
    case 'read':
      return what ? `Read: ${what}` : 'Read files';
    case 'webfetch':
      return what ? `Fetch: ${what}` : 'Fetch a URL';
    case 'websearch':
      return what ? `Search the web: ${what}` : 'Search the web';
    default:
      return what ? `${permission}: ${what}` : permission;
  }
}

/** OpenCode's commands as the phone's command menu lists them. V2's command
 *  list carries no argument hints of its own, so a command shows just its
 *  name and description. */
export function toSlashCommands(commands: Array<{ name: string; description?: string }>): SlashCommand[] {
  return commands.map((c) => slashCommand(c.name, c.description));
}

/** A `question` form's fields in the wire's question shape. V2 states a
 *  question as a form field: a string field carrying the options (with
 *  `custom` allowing a typed answer), or a multiselect for a question that
 *  takes more than one. */
export function toQuestionSpecs(fields: FormFieldLike[]): QuestionSpec[] {
  return fields.map((f) => ({
    question: f.title ?? f.description ?? f.key,
    ...(f.description && f.title ? { header: f.title } : {}),
    options: (f.type === 'multiselect' || f.type === 'string' ? (f.options ?? []) : []).map((o) => ({
      label: o.label,
      ...(o.description ? { description: o.description } : {}),
    })),
    ...(f.type === 'multiselect' ? { multiSelect: true } : {}),
  }));
}

/** The subset of a v2 form field the question card reads. */
export interface FormFieldLike {
  key: string;
  type: string;
  title?: string;
  description?: string;
  options?: Array<{ value: string; label: string; description?: string }>;
}

/**
 * The user's answers as the form's value map: v2 keys each field's answer by
 * the field itself (`q0`, `q1`…, the key the question tool gave it), and
 * takes a chosen entry as its value — a custom (typed) answer is sent as the
 * text, since OpenCode reads any value the options do not offer that way.
 */
export function toFormAnswer(
  fields: FormFieldLike[],
  answers: QuestionReply[],
): Record<string, string | string[]> {
  const answer: Record<string, string | string[]> = {};
  fields.forEach((field, i) => {
    const reply = answers[i];
    if (reply === undefined) return;
    if (reply.type === 'selected') {
      answer[field.key] = field.type === 'multiselect' ? reply.labels : (reply.labels[0] ?? '');
      return;
    }
    if (reply.text !== '') answer[field.key] = field.type === 'multiselect' ? [reply.text] : reply.text;
  });
  return answer;
}

export class OpenCodeSession implements DriverSession {
  private readonly cwd: string;
  private readonly abortController = new AbortController();
  private readonly translate: TranslateContext;
  /** Told a tool name no agent's table lists, which the log then carries. */
  private readonly reportUnknownTool: (toolName: string) => void;
  private ended = false;
  private mode: string;
  /** The last mode switch still being applied to the server; the next one
   *  waits for it. Never rejects. */
  private agentSwitch: Promise<void> = Promise.resolve();
  /** The title last reported for the session. */
  private title: string | undefined;
  private model?: { providerID: string; id: string };
  /** The reasoning level ("variant") prompts ask of the model; none = the
   *  model's default. */
  private variant: string | undefined;

  /** Tool call ids already shown as a row — v2 reports a call's input, its
   *  start and its end separately, and only one row may come of them. */
  private readonly shownCalls = new Set<string>();
  /** Coalesces the reply's streamed deltas into `partial` events
   *  (sdk/partial): a few signed, relayed updates a second, not one per
   *  token. Only the main agent's reply text is streamed — see the `delta`
   *  case in consumeEvents. */
  private readonly partials: PartialCoalescer;
  /** Ask ids (permissions and forms) already handled — an ask could in
   *  theory refire; a second reply is rejected by the server anyway, but this
   *  avoids the wasted round trip and a second card. */
  private readonly answeredAsks = new Set<string>();
  /** Sub-agent sessions this session started (OpenCode's `subagent` tool runs
   *  each in a child session), by session id: the call that started it, the
   *  sub-agent's kind, and — for one left running in the background — that
   *  it is a task, and whether the user asked it to stop. */
  private readonly children = new Map<string, ChildSession>();
  /** Background shell commands this session started, by the shell id the
   *  server gave them — the title a task row shows, the tool call that
   *  started it, and whether the user asked it to stop. The server names a
   *  background shell only on this session's own tool result; its later
   *  `shell.exited` carries no session at all, so the id learned here is
   *  what ties that exit back to this session's task. */
  private readonly shells = new Map<string, { title: string; callId: string; stopping: boolean }>();
  /** Every event the stream carried for this session, one line each, when
   *  `CODEDECK_DEBUG_EVENTS` is set: which event, for which session, and
   *  whether this session reads it as a sub-agent's child. A live server is
   *  the only place v2's real event order can be seen (the fixtures are
   *  written by hand), so turn and reporting bugs are diagnosed from this
   *  trace — see `./codedeck live opencode --env CODEDECK_DEBUG_EVENTS=1`. */
  private readonly traceEvents = Boolean(process.env.CODEDECK_DEBUG_EVENTS);
  /** The providers' context limits, fetched on the first step that used
   *  tokens; dropped again when the fetch came back empty, so a server that
   *  was briefly unreachable is asked again. */
  private contextLimits?: Promise<Record<string, number>>;
  private contextWindow?: number;
  private contextPercentage?: number;
  /** The turn was reported complete, and no new one has started since. */
  private turnCompleted = false;
  /** The error last reported in this turn: OpenCode reports a failed
   *  turn's error both on its step and on its execution. */
  private lastError?: string;
  /** The last main-agent step's own token counts: what the context held
   *  then. Never the session's running totals, which only grow. */
  private lastTokens?: SessionInfo['tokens'];
  /** The model the last main-agent step ran, which is the window its tokens
   *  are measured against. */
  private lastStepModel?: { providerID: string; id: string };
  /** Names of the session's commands, from the last list fetched: a typed
   *  `/name` runs as that command only when OpenCode has one by that name.
   *  Dropped again when the fetch failed, so the next one asks again. */
  private commandNames?: Promise<Set<string>>;

  /** Resolves once the OpenCode session exists server-side. */
  private readonly ready: Promise<{ client: OpenCodeClient; session: SessionInfo }>;
  private readonly catalog: () => Promise<OpenCodeCatalog>;

  constructor(
    params: StartSession,
    private readonly ctx: SessionContext,
    clientPromise: Promise<OpenCodeClient>,
    options: OpenCodeSessionOptions = {},
  ) {
    this.cwd = params.cwd;
    this.mode = params.mode ?? DEFAULT_MODE;
    this.reportUnknownTool = unknownToolReporter((message) => this.ctx.log(message));
    this.translate = newTranslateContext(this.reportUnknownTool);
    this.partials = new PartialCoalescer((update) => {
      if (!this.ended) this.ctx.emit({ type: 'partial', ...update });
    });
    this.catalog = options.catalog ?? (async () => ({ models: [] }));
    this.model = splitModelId(params.model ?? undefined);
    // A level the model lacks is ignored by OpenCode: the session starts on
    // the model's default rather than failing.
    this.variant = params.effort && params.effort !== DEFAULT_VARIANT ? params.effort : undefined;
    this.ready = this.init(clientPromise, params);
    // init() reports its own failure as `ended`; nothing else awaits this
    // rejection except prompt/interrupt, which catch it themselves.
    this.ready.catch(() => {});
  }

  private deliver(event: OpenCodeEvent): void {
    if (this.ended) return;
    const entries = opencodeEventToEntries(event, this.translate);
    if (entries.length > 0) this.ctx.emit({ type: 'entries', entries });
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /** The server this session runs on was replaced: it ends with the
   *  reason, which the bridge answers by resuming it. */
  serverReplaced(): void {
    this.finish('The OpenCode server restarted to load changed provider profiles.');
  }

  private finish(error?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.abortController.abort();
    this.partials.reset();
    // Nothing will report these shells' ends once the stream is gone.
    this.shells.clear();
    this.ctx.emit({ type: 'ended', ...(error ? { error } : {}) });
  }

  private async init(
    clientPromise: Promise<OpenCodeClient>,
    params: StartSession,
  ): Promise<{ client: OpenCodeClient; session: SessionInfo }> {
    try {
      // With no model named, the session runs the default the phone was
      // shown, set on the session — never whatever OpenCode would pick on
      // its own (the last model used, possibly one with no credential).
      // A resumed conversation already ran on its model; only a new start is
      // checked against what the providers offer.
      const catalogRead: Promise<OpenCodeCatalog> = !params.model || !params.resume ? this.catalog() : Promise.resolve({ models: [] });
      // Subscribe BEFORE resolving/creating the session so no event in the gap
      // between "session exists" and "we started listening" is missed. The
      // stream carries every location, so this session filters by sessionID.
      // Opened while the catalog is read, so a new session waits for one
      // round trip, not two; a refused model closes it again (the abort in
      // `finish`).
      const [catalog, client] = await Promise.all([catalogRead, clientPromise]);
      const stream = client.event.subscribe({ signal: this.abortController.signal });
      if (params.model && !params.resume) {
        const refused = unsupportedModelReason(params.model, catalog.models);
        if (refused) throw new Error(refused);
      }
      // The context meter's window sizes come from the same catalog.
      if (catalog.models.length > 0) this.contextLimits ??= Promise.resolve(catalog.contextLimits ?? {});
      const model = params.model ?? catalog.defaultModel;
      if (!params.model) this.model = splitModelId(model);
      // Read alongside the session, for the line a new session opens with; a
      // server that does not say leaves the line without it.
      const version = Promise.resolve()
        .then(() => client.server.info())
        .then((info) => info.version, () => undefined);
      const { session, resumeLost } = await this.resolveSession(client, params);
      // Before any prompt can run: until then the agent's denies are not in
      // the session's rules.
      await this.statePermissions(client, session.id, session.agent ?? (this.mode === PLAN_MODE ? PLAN_AGENT : BUILD_AGENT));
      // The "memory was lost" notice goes ahead of the session's first line.
      if (resumeLost) this.deliver({ type: 'resume-lost' });
      if (!this.ended) {
        this.ctx.emit({ type: 'info', nativeSessionId: session.id, ...(model ? { model } : {}), mode: this.mode });
        this.reportTitle(session.title);
        // The version is said once, when a conversation starts — the model is
        // on the phone's composer. A resumed one said it when it began; one
        // whose conversation was lost starts anew.
        if (!params.resume || resumeLost) {
          const v = await version;
          this.deliver({ type: 'started', ...(v ? { version: v } : {}) });
        }
        this.ctx.emit({ type: 'ready' });
      }
      // Consume the event stream for the rest of this session's life. A clean
      // end (server closed the connection) ends the session normally; a
      // rejection (network drop, server restart) ends it with the error, so
      // the bridge's restart policy can bring it back.
      void this.consumeEvents(client, stream, session.id).then(
        () => this.finish(),
        (err) => this.finish(err instanceof Error ? err.message : String(err)),
      );
      return { client, session };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deliver({ type: 'error', content: message });
      this.finish(message);
      throw err;
    }
  }

  /** `params.resume` names a previously seen OpenCode session id. Verify it
   *  still exists server-side before trusting it — a session the server no
   *  longer knows about (deleted, server restarted with no persistence) falls
   *  through to creating a fresh one rather than failing the whole session.
   *  `resumeLost` says whether that fallback happened, so the user is told. */
  private async resolveSession(
    client: OpenCodeClient,
    params: StartSession,
  ): Promise<{ session: SessionInfo; resumeLost: boolean }> {
    if (params.resume) {
      try {
        return { session: await client.session.get({ sessionID: params.resume }), resumeLost: false };
      } catch (err) {
        this.ctx.log(`[opencode] resume ${params.resume} not found server-side (${formatOpenCodeError(err)}) — starting a fresh session instead`);
      }
    }
    return { session: await this.createSessionRemote(client), resumeLost: Boolean(params.resume) };
  }

  /** Created untitled, so OpenCode names it after its first message, on the
   *  model and agent the session runs from the start — v2 takes both here
   *  rather than on each prompt. */
  private async createSessionRemote(client: OpenCodeClient): Promise<SessionInfo> {
    try {
      return await client.session.create({
        location: { directory: this.cwd },
        ...(this.model ? { model: { ...this.model, ...(this.variant ? { variant: this.variant } : {}) } } : {}),
        ...(this.mode === PLAN_MODE ? { agent: PLAN_AGENT } : {}),
        permissions: permissionRules(this.mode),
      });
    } catch (err) {
      throw new Error(`OpenCode session.create failed: ${formatOpenCodeError(err)}`);
    }
  }

  private async consumeEvents(
    client: OpenCodeClient,
    stream: AsyncIterable<V2Event>,
    sessionId: string,
  ): Promise<void> {
    for await (const event of stream) {
      if (this.ended) break;
      const data = event.data as { sessionID?: string } | undefined;
      const child = data?.sessionID ? this.children.get(data.sessionID) : undefined;
      if (this.traceEvents) {
        const parent = (event.data as { parentID?: string } | undefined)?.parentID;
        this.ctx.log(
          `[opencode] ${event.type} sessionID=${String(data?.sessionID)} parentID=${String(parent)} child=${Boolean(child)} main=${sessionId}`,
        );
      }
      // Events for other sessions are dropped, except the one that tells this
      // session a sub-agent of its own started.
      if (data?.sessionID && data.sessionID !== sessionId && !child && !this.noteChild(event, sessionId)) continue;
      switch (event.type) {
        case 'session.text.delta': {
          // Only the main agent's reply text is streamed: a sub-agent's text
          // and the model's reasoning are shown collapsed (inside a tool
          // group, or as a Thinking step), so a relay round trip for either
          // would be traffic for what nobody sees as it arrives.
          if (!child && event.data.delta) {
            this.partials.delta({ key: partKey(event.data), entryType: 'text', text: event.data.delta });
          }
          break;
        }
        case 'session.text.ended': {
          const part = child ? undefined : partKey(event.data);
          if (part) this.partials.complete(part);
          this.deliver({
            type: 'text',
            role: 'assistant',
            text: event.data.text,
            ...(part ? { part } : {}),
            ...(child ? { subagent: subagentOf(child) } : {}),
          });
          break;
        }
        case 'session.reasoning.ended': {
          this.deliver({ type: 'reasoning', text: event.data.text, ...(child ? { subagent: subagentOf(child) } : {}) });
          break;
        }
        case 'session.tool.input.started': {
          this.toolCalls.set(event.data.id, { name: event.data.name, input: {} });
          break;
        }
        case 'session.tool.called': {
          const name = this.toolCalls.get(event.data.id)?.name ?? '';
          this.toolCalls.set(event.data.id, { name, input: (event.data.input ?? {}) as Record<string, unknown> });
          // Only this session's own calls start children it pairs: a
          // sub-agent's own sub-agent is announced to that sub-agent, never
          // to us, so its call would wait here forever and the next child
          // of ours would be paired with it.
          if (name === SUBAGENT_TOOL && !child) this.noteSubagentCall(event.data.id, event.data.input);
          this.deliver({
            type: 'tool-start',
            callId: event.data.id,
            toolName: name,
            input: event.data.input,
            ...(child ? { subagent: subagentOf(child) } : {}),
          });
          break;
        }
        case 'session.tool.success': {
          const diffs = toolCallDiffs(event.data.metadata as Record<string, unknown> | undefined);
          for (const diff of diffs) this.toolDiffedFiles.add(diff.path);
          this.deliver({
            type: 'tool-result',
            callId: event.data.id,
            text: toolResultText(event.data.content, 'Done.'),
            diffs,
            ...(child ? { subagent: subagentOf(child) } : {}),
          });
          this.finishSubagentCall(event.data.id);
          // A sub-agent's own background shell belongs to that sub-agent, and
          // its child session ending is what reports the task.
          if (!child) this.noteBackgroundShell(event.data.id, event.data.metadata);
          break;
        }
        case 'session.tool.failed': {
          this.deliver({
            type: 'tool-result',
            callId: event.data.id,
            text: toolResultText(event.data.content, formatOpenCodeError(event.data.error)),
            isError: true,
            diffs: toolCallDiffs(event.data.metadata as Record<string, unknown> | undefined),
            ...(child ? { subagent: subagentOf(child) } : {}),
          });
          this.finishSubagentCall(event.data.id);
          break;
        }
        case 'session.step.started': {
          // The step is what names the model; its end carries only the
          // tokens, and the context meter needs both.
          if (!child) this.lastStepModel = event.data.model;
          break;
        }
        case 'session.step.ended': {
          if (!child) {
            // The step's own counters, not the session's running totals (see
            // contextTokens): what the next step will carry as its prompt.
            if (event.data.tokens) this.lastTokens = event.data.tokens;
            this.reportStepTokens();
          }
          // Files the step changed that no tool call already showed (a shell
          // command's writes, say): v2 names them here rather than as a
          // session-wide diff.
          if (event.data.files && event.data.files.length > 0) void this.reportChangedFiles(client, sessionId, event.data.files);
          break;
        }
        // A compaction rewrote the conversation the model sees. The phone's
        // transcript still holds what the summary replaced, and its context
        // meter is about to drop, so the compaction is stated rather than
        // left to look like the context vanishing on its own.
        case 'session.compaction.started': {
          if (child) break;
          // A manual compaction is the `/compact` built-in, whose own status
          // line is already in the transcript; only an automatic one is news.
          if (event.data.reason !== 'manual') {
            this.deliver({ type: 'status', text: 'OpenCode is compacting the conversation to make room in the context.' });
          }
          break;
        }
        case 'session.compaction.ended': {
          if (child) break;
          this.deliver({
            type: 'status',
            text:
              event.data.reason === 'manual'
                ? 'Compacted the conversation: OpenCode continues from a summary of it.'
                : 'Compacted the conversation to make room: OpenCode continues from a summary of it.',
          });
          break;
        }
        case 'session.compaction.failed': {
          if (child) break;
          this.reportError(`OpenCode could not compact the conversation: ${formatOpenCodeError(event.data.error)}`);
          break;
        }
        // A child's failure is the sub-agent's own: it ends that sub-agent,
        // rather than surfacing on the phone as an error the user cannot
        // place. The background task it was left as is what reports it.
        case 'session.step.failed': {
          if (child) {
            this.childEnded(child, 'failed');
            break;
          }
          if (event.data.error) this.reportError(formatOpenCodeError(event.data.error));
          break;
        }
        case 'session.execution.failed': {
          if (child) {
            this.childEnded(child, 'failed');
            break;
          }
          this.reportError(formatOpenCodeError(event.data.error));
          // The turn is over however it ended: a failure that left the
          // session looking like it was still working would strand the phone
          // with a spinner and no way back.
          this.markTurnComplete();
          break;
        }
        // A child's execution ending is that sub-agent's own end, exactly as
        // its `session.idle` would be: only THIS session's own execution
        // ending ends its turn. A child's end read as the session's own marks
        // the turn complete while the parent is still working, and — because
        // the child is then never recorded as ended — makes the call that
        // started it a background task the phone shows as running for good.
        case 'session.execution.succeeded': {
          if (child) {
            this.childEnded(child, 'completed');
            break;
          }
          this.markTurnComplete();
          break;
        }
        case 'session.execution.interrupted': {
          if (child) {
            this.childEnded(child, 'stopped');
            break;
          }
          this.markTurnComplete();
          break;
        }
        case 'session.idle': {
          if (child) this.childEnded(child, 'completed');
          else this.markTurnComplete();
          break;
        }
        // A background shell of this session ended: the server's
        // `shell.exited` names the shell and its exit, but no session (see
        // the `shells` field), so it is matched by the id this session learned
        // when the shell was started. A shell of another session's — or one
        // already reported — is ignored.
        case 'shell.exited': {
          this.finishShell(event.data);
          break;
        }
        case 'session.status': {
          const status = event.data.status;
          if (status.type === 'retry') {
            // The provider failed and OpenCode tries again, waiting longer
            // each time: said on the phone, rather than a turn that only
            // seems slow until the last attempt's error.
            this.deliver({ type: 'status', text: retryText(status, Date.now()) });
            break;
          }
          if (child) break;
          if (status.type === 'busy') {
            this.turnCompleted = false;
            this.lastError = undefined;
          }
          if (!this.ended) this.ctx.emit({ type: 'turn', state: status.type === 'busy' ? 'running' : 'idle' });
          break;
        }
        case 'session.renamed': {
          if (!child) this.reportTitle(event.data.title);
          break;
        }
        case 'permission.asked': {
          this.handlePermission(client, event.data, child);
          break;
        }
        case 'form.created': {
          if (event.data.form.metadata?.kind !== 'question') break;
          this.handleForm(client, event.data.form, child);
          break;
        }
        case 'session.execution.started': {
          // A sub-agent asked again works again: it has not ended.
          if (child) {
            child.ended = false;
            break;
          }
          // V2 starts a turn with this, not with a `busy` status: without it
          // the phone would only ever learn a turn had ended.
          this.turnCompleted = false;
          this.lastError = undefined;
          if (!this.ended) this.ctx.emit({ type: 'turn', state: 'running' });
          break;
        }
        default:
          break;
      }
    }
  }

  /**
   * What each call is, by its id: v2 names the tool when its input starts and
   * sends the input when the call is made, while the events that come after
   * — a permission ask, a result — carry only the id. A permission card is
   * therefore read from here, since the ask itself says no more than which
   * call it is about.
   */
  private readonly toolCalls = new Map<string, { name: string; input: Record<string, unknown> }>();
  /** Files a completed edit/write/patch call already showed as a diff card.
   *  A file the step also names as changed is that same edit — dropped
   *  instead of shown twice — and consumes the entry, so a LATER change to
   *  the file (a shell command, say) still gets its card. */
  private readonly toolDiffedFiles = new Set<string>();

  /** Whether this event is this session's own child being announced; the
   *  child is recorded so its later events are read. OpenCode names the
   *  parent on the child's own `session.created`, which is what tells a
   *  sub-agent's session apart from an unrelated one on the same server. */
  private noteChild(event: V2Event, sessionId: string): boolean {
    if (event.type !== 'session.created') return false;
    const created = event.data;
    if (created.parentID !== sessionId || this.children.has(created.sessionID)) return false;
    // The call that started it named the sub-agent; the two events arrive
    // back to back, the call first.
    const call = this.pendingSubagents.shift();
    this.children.set(created.sessionID, {
      callId: call?.callId ?? '',
      title: call?.title ?? created.title ?? 'Sub-agent',
      ...(call?.label ? { label: call.label } : {}),
      background: false,
      stopping: false,
      ended: false,
    });
    return true;
  }

  /** Sub-agent calls whose child session has not been announced yet: the
   *  call names the sub-agent, the `session.created` that follows names the
   *  session it runs in, and the two are paired here. */
  private readonly pendingSubagents: Array<{ callId: string; label?: string; title: string }> = [];

  /** Remember what the `subagent` call asked for; the child session it
   *  starts is created just after, and claims this. */
  private noteSubagentCall(callId: string, input: Record<string, unknown>): void {
    const label = typeof input.agent === 'string' && input.agent ? input.agent : undefined;
    const title = typeof input.description === 'string' && input.description ? input.description : 'Sub-agent';
    this.pendingSubagents.push({ callId, ...(label ? { label } : {}), title });
  }

  /** The child a sub-agent call started, by that call's id. */
  private childOfCall(callId: string): { id: string; child: ChildSession } | undefined {
    for (const [id, child] of this.children) if (child.callId === callId) return { id, child };
    return undefined;
  }

  /** A sub-agent call finished while its child session is still going: the
   *  sub-agent was left to run on its own, which is the background task the
   *  phone can stop. */
  private finishSubagentCall(callId: string): void {
    const found = this.childOfCall(callId);
    if (!found) return;
    const { id, child } = found;
    // A child whose execution already ended ran to completion inside the
    // call: it was not left running, so there is no task to report.
    if (child.background || child.ended) return;
    child.background = true;
    this.deliver({ type: 'task', taskId: id, kind: 'agent', title: child.title, status: 'running', callId: child.callId });
  }

  private childIdOf(child: ChildSession): string {
    for (const [id, c] of this.children) if (c === child) return id;
    return child.callId;
  }

  /** A child session ended — its own execution, or a failure: a background
   *  sub-agent's task ended (stopped, when the user asked for that). */
  private childEnded(child: ChildSession, status: 'completed' | 'failed' | 'stopped'): void {
    child.ended = true;
    if (!child.background) return;
    child.background = false;
    this.deliver({
      type: 'task',
      taskId: this.childIdOf(child),
      kind: 'agent',
      title: child.title,
      status: child.stopping ? 'stopped' : status,
      callId: child.callId,
    });
  }

  /**
   * A `shell` call OpenCode moved to the background, read from its success
   * result. The result names the shell and reports it still `running`; a
   * shell that ran to completion carries its output and its exit code
   * instead, with no shell id — that difference is what tells a background
   * task apart from a call that already finished inside the turn. The shell
   * is a server object whose own events (`shell.created`, `shell.exited`)
   * name no session, so the id learned here is the only thing that ties its
   * exit back to this session's task.
   */
  private noteBackgroundShell(callId: string, metadata: unknown): void {
    const started = this.toolCalls.get(callId);
    if (started?.name !== SHELL_TOOL) return;
    const meta = metadata as { shellID?: unknown; status?: unknown } | undefined;
    const shellID = typeof meta?.shellID === 'string' ? meta.shellID : '';
    if (shellID === '' || meta?.status !== 'running' || this.shells.has(shellID)) return;
    const command = started.input.command;
    const title = typeof command === 'string' && command !== '' ? command : 'Background command';
    this.shells.set(shellID, { title, callId, stopping: false });
    this.deliver({ type: 'task', taskId: shellID, kind: 'shell', title, status: 'running', callId });
  }

  /**
   * A background shell of this session ended, out of the server's
   * `shell.exited` (which names no session — see `shells`). Its exit decides
   * how it went; a shell the user stopped, or one the server killed, is
   * reported as stopped rather than failed. A shell this session did not
   * start is ignored.
   */
  private finishShell(data: { id: string; exit?: number; status: string }): void {
    const shell = this.shells.get(data.id);
    if (!shell) return;
    this.shells.delete(data.id);
    const status: TaskStatus =
      shell.stopping || data.status === 'killed'
        ? 'stopped'
        : data.status === 'timeout' || (data.exit !== undefined && data.exit !== 0)
          ? 'failed'
          : 'completed';
    this.deliver({ type: 'task', taskId: data.id, kind: 'shell', title: shell.title, status, callId: shell.callId });
  }

  /** The turn is over: said once, however many of v2's end signals arrive. */
  private markTurnComplete(): void {
    // A live row left over is dropped here (nothing will complete it), and no
    // part timer outlives the turn.
    this.partials.reset();
    if (!this.turnCompleted) this.deliver({ type: 'idle' });
    this.turnCompleted = true;
    if (!this.ended) this.ctx.emit({ type: 'turn', state: 'idle' });
  }

  /** Files a step changed that no tool call showed, as diff cards: the
   *  server's own diff carries the patch for each. */
  private async reportChangedFiles(client: OpenCodeClient, sessionId: string, files: string[]): Promise<void> {
    const wanted = files.filter((f) => !this.consumeToolDiff(f));
    if (wanted.length === 0) return;
    try {
      const diff = await client.session.diff({ sessionID: sessionId });
      const byPath = new Map(diff.map((d) => [d.file, d]));
      const shown = wanted.flatMap((f) => {
        const found = byPath.get(f) ?? [...byPath.values()].find((d) => d.file.endsWith(`/${f}`) || f.endsWith(`/${d.file}`));
        return found ? [found] : [];
      });
      if (shown.length > 0) this.deliver({ type: 'diff', files: shown });
    } catch {
      // A diff the server will not give is not worth failing a turn over.
    }
  }

  /** Whether a tool call already showed `file`'s change (removing that
   *  record). Tool calls name files by absolute path, the step's list by
   *  worktree-relative path, so either may be a path-suffix of the other. */
  private consumeToolDiff(file: string): boolean {
    const norm = (p: string) => p.replace(/\\/g, '/');
    const target = norm(file);
    for (const shown of this.toolDiffedFiles) {
      const s = norm(shown);
      if (s === target || s.endsWith(`/${target}`) || target.endsWith(`/${s}`)) {
        this.toolDiffedFiles.delete(shown);
        return true;
      }
    }
    return false;
  }

  /** Report how full the context is after a step, over the window of the
   *  model that ran it — only what changed, and nothing for a model with no
   *  declared limit. */
  private reportStepTokens(): void {
    const providerID = this.lastStepModel?.providerID;
    const modelID = this.lastStepModel?.id;
    if (!this.lastTokens || !providerID || !modelID) return;
    const used = contextTokens(this.lastTokens);
    if (used <= 0) return;
    this.contextLimits ??= this.catalog().then((c) => {
      if (c.models.length === 0) this.contextLimits = undefined;
      return c.contextLimits ?? {};
    });
    void this.contextLimits.then((limits) => {
      const window = limits[`${providerID}/${modelID}`];
      if (!window || this.ended) return;
      const pct = Math.max(0, Math.min(100, Math.round((used / window) * 100)));
      const changedPct = pct !== this.contextPercentage;
      const changedCw = window !== this.contextWindow;
      if (!changedPct && !changedCw) return;
      this.contextPercentage = pct;
      this.contextWindow = window;
      this.ctx.emit({
        type: 'info',
        ...(changedPct ? { contextPercentage: pct } : {}),
        ...(changedCw ? { contextWindow: window } : {}),
      });
    });
  }

  private reportError(content: string): void {
    if (content === this.lastError) return;
    this.lastError = content;
    this.deliver({ type: 'error', content });
  }

  /**
   * Answer one OpenCode permission ask: allowed in the auto-approve mode,
   * otherwise sent to the phone. Always answered — OpenCode must never wait
   * on a reply that is not coming.
   */
  private handlePermission(client: OpenCodeClient, ask: SessionPermissionAsk, child?: ChildSession): void {
    if (this.answeredAsks.has(ask.id)) return;
    this.answeredAsks.add(ask.id);
    const reply = (decision: 'once' | 'always' | 'reject'): void => {
      // Best effort — the ask then stays pending server-side; there is no
      // live connection left to retry over.
      void client.permission.reply({ sessionID: ask.sessionID, requestID: ask.id, decision }).catch(() => {});
    };

    if (this.mode === AUTO_APPROVE_MODE) {
      reply('once');
      return;
    }
    const started = this.toolCalls.get(ask.source?.id ?? '');
    const toolName = started?.name ?? ask.action;
    // The question tool asks for permission to ask, and then asks. Its own
    // ask is the question: a card for it would make the user allow being
    // asked before they are asked, with the answer they give the form the
    // only one that says anything. Allowed here, so the form's card is the
    // one they see.
    if (toolName === QUESTION_TOOL) {
      reply('once');
      return;
    }
    // The ask names the call, not what it will run: the arguments it was
    // called with are what the card shows (`read` a file, `shell` a command).
    // Its own `metadata` carries them when v2 sends any.
    const input = started?.input ?? ((ask.metadata ?? {}) as Record<string, unknown>);
    const description = ask.message?.trim() || describePermission(ask.action, ask.resources);
    const call = opencodeTool(toolName, input, this.reportUnknownTool);
    this.ctx
      .requestPermission({
        requestId: ask.source?.id ?? ask.id,
        toolName,
        kind: call.kind,
        title: call.title,
        description,
        locations: toolLocations(input),
        options: ask.save && ask.save.length > 0 ? [PERMISSION_ALLOW, allowInProject(ask.save), PERMISSION_DENY] : [PERMISSION_ALLOW, PERMISSION_DENY],
        ...(child ? { subagent: subagentOf(child) } : {}),
      })
      .then((outcome) => {
        const chosen = outcome.outcome === 'selected' ? outcome.optionId : undefined;
        reply(chosen === PERMISSION_ALLOW.id ? 'once' : chosen === PERMISSION_ALLOW_ALWAYS.id && ask.save?.length ? 'always' : 'reject');
      })
      .catch(() => reply('reject'));
  }

  /**
   * One OpenCode form raised by the `question` tool, asked on the phone.
   * Keyed by the question tool's call id — the form's own metadata names it —
   * so the card groups under that call and the call's result marks the card
   * answered. Always answered — a dismissal cancels the form, so OpenCode
   * never waits on a reply that is not coming.
   */
  private handleForm(client: OpenCodeClient, form: FormInfoLike, child?: ChildSession): void {
    if (this.answeredAsks.has(form.id)) return;
    this.answeredAsks.add(form.id);

    const tool = (form.metadata as { tool?: { id?: string } } | undefined)?.tool;
    const toolUseId = tool?.id ?? form.id;
    this.deliver({ type: 'question', toolUseId });

    const cancel = (): void => {
      void client.session.form.cancel({ sessionID: form.sessionID, formID: form.id }).catch(() => {});
    };
    this.ctx
      .askQuestion(toolUseId, toQuestionSpecs(form.fields))
      .then((outcome) => {
        if (outcome.outcome !== 'answered') return cancel();
        return client.session.form
          .reply({ sessionID: form.sessionID, formID: form.id, answer: toFormAnswer(form.fields, outcome.answers) })
          .catch(cancel);
      })
      .catch(cancel);
  }

  /**
   * A typed `/name args` naming one of OpenCode's commands runs through
   * `session.command`, which expands the command's template; sent as plain
   * text it would reach the model verbatim. Anything else is a prompt.
   */
  prompt(text: string): void {
    const command = parseSlashCommand(text);
    this.turnCompleted = false;
    this.lastError = undefined;
    this.ready
      .then(async ({ client, session }) => {
        const listed = command ? await this.knownCommands(client) : new Set<string>();
        if (command && listed.has(command.name)) {
          this.runCommand(client, session.id, command.name, command.args);
          return;
        }
        const builtin = command && sessionCommand(command.name, listed);
        if (builtin) {
          this.runSessionCommand(client, session.id, builtin);
          return;
        }
        try {
          await client.session.prompt({ sessionID: session.id, text });
        } catch (err) {
          this.deliver({ type: 'error', content: `OpenCode prompt failed: ${formatOpenCodeError(err)}` });
        }
      })
      .catch((err) => {
        this.deliver({ type: 'error', content: `OpenCode prompt failed: ${err instanceof Error ? err.message : String(err)}` });
      });
  }

  /** One of the commands OpenCode's terminal runs itself; its outcome is a
   *  status line, its failure an error entry. */
  private runSessionCommand(client: OpenCodeClient, sessionID: string, command: (typeof SESSION_COMMANDS)[number]): void {
    command
      .run({
        client,
        sessionID,
        ...(this.model ? { model: { ...this.model, ...(this.variant ? { variant: this.variant } : {}) } } : {}),
        status: (text) => this.deliver({ type: 'status', text }),
      })
      .catch((err) => this.deliver({ type: 'error', content: err instanceof Error ? err.message : String(err) }));
  }

  /** The title OpenCode gave the session, once it has one of its own
   *  (not the timestamp a new session starts with) — each new one once. */
  private reportTitle(title: string | undefined): void {
    if (!title || isPlaceholderTitle(title) || title === this.title || this.ended) return;
    this.title = title;
    this.ctx.emit({ type: 'info', title });
  }

  /** `session.command` answers only once the whole turn is over, so it is
   *  not awaited: the turn itself arrives on the event stream. A refusal
   *  becomes an error entry; a connection given up on while the turn runs
   *  (the stream still carries it) is only logged. */
  private runCommand(client: OpenCodeClient, sessionID: string, name: string, args: string): void {
    client.session
      .command({ sessionID, name, text: args })
      .then(() => {})
      .catch((err) => this.ctx.log(`[opencode] /${name}: ${formatOpenCodeError(err)}`));
  }

  private async fetchCommands(client: OpenCodeClient): Promise<Array<{ name: string; description?: string }>> {
    try {
      const listed = await client.command.list({ location: { directory: this.cwd } });
      this.commandNames = Promise.resolve(new Set(listed.data.map((c) => c.name)));
      return listed.data;
    } catch (err) {
      throw new Error(`OpenCode could not list its commands: ${formatOpenCodeError(err)}`);
    }
  }

  private knownCommands(client: OpenCodeClient): Promise<Set<string>> {
    this.commandNames ??= this.fetchCommands(client).then(
      (commands) => new Set(commands.map((c) => c.name)),
      () => {
        this.commandNames = undefined;
        return new Set<string>();
      },
    );
    return this.commandNames;
  }

  /** The server's commands, then the ones the driver runs itself. */
  async listCommands(): Promise<SlashCommand[]> {
    const { client } = await this.ready;
    const commands = await this.fetchCommands(client);
    return [...toSlashCommands(commands), ...sessionSlashCommands(new Set(commands.map((c) => c.name)))];
  }

  async mcpStatus(): Promise<SessionMcpState> {
    const { client } = await this.ready;
    return openCodeSessionMcp(client, this.cwd);
  }

  async toggleMcp(name: string, enabled: boolean): Promise<SessionMcpState> {
    const { client } = await this.ready;
    return toggleOpenCodeMcp(client, this.cwd, name, enabled);
  }

  async setOption(option: SessionOption, value: string): Promise<void> {
    switch (option) {
      case 'mode': {
        if (!OPENCODE_MODES.some((m) => m.id === value)) throw new Error(`OpenCode has no mode '${value}'`);
        this.mode = value;
        // V2 runs an agent and a permission ruleset for the whole session, so
        // switching the mode switches both: the plan agent (or OpenCode's own
        // default), and whether a tool call reaches the phone at all.
        const { client, session } = await this.ready;
        // The host runs a second switch while the first is still talking to
        // the server: queued, each applies the mode set last, so the session
        // ends on the agent and rules of the final one, never a mix.
        const switched = this.agentSwitch.then(async () => {
          const agent = this.mode === PLAN_MODE ? PLAN_AGENT : BUILD_AGENT;
          await client.session.switchAgent({ sessionID: session.id, agent }).catch(() => {});
          await this.statePermissions(client, session.id, agent);
        });
        this.agentSwitch = switched;
        await switched;
        return;
      }
      case 'model': {
        // V2 keeps the model on the session; the switch applies from the next
        // step, which is what a per-prompt model used to mean.
        const split = splitModelId(value);
        if (!split) throw new Error(`'${value}' is not an OpenCode provider/model id`);
        const models = (await this.catalog()).models;
        const refused = unsupportedModelReason(value, models);
        if (refused) throw new Error(refused);
        // A level the new model lacks would be ignored; drop it.
        if (this.variant && !models.find((m) => m.id === value)?.efforts?.some((e) => e.id === this.variant)) this.variant = undefined;
        this.model = split;
        await this.switchModel();
        return;
      }
      case 'effort': {
        // Levels are the model's own (its OpenCode variants).
        const { models, defaultModel } = await this.catalog();
        const id = this.model ? `${this.model.providerID}/${this.model.id}` : defaultModel;
        const levels = models.find((m) => m.id === id)?.efforts ?? [];
        if (!levels.some((e) => e.id === value)) {
          throw new Error(levels.length > 0 ? `'${value}' is not a reasoning level of ${id}` : `${id ?? 'This model'} has no reasoning levels`);
        }
        this.variant = value === DEFAULT_VARIANT ? undefined : value;
        await this.switchModel();
        return;
      }
    }
  }

  /** Set the session's rules for its mode and for `agent`'s own rules. An
   *  agent that cannot be read leaves only the mode's catch-all, which is
   *  logged: nothing the agent forbids would then be refused. */
  private async statePermissions(client: OpenCodeClient, sessionID: string, agent: string): Promise<void> {
    const agentRules = await Promise.resolve()
      .then(() => client.agent.get({ agentID: agent, location: { directory: this.cwd } }))
      .then(
        (got) => got.data.permissions,
        (err) => {
          this.ctx.log(`[opencode] could not read agent ${agent}'s permissions: ${formatOpenCodeError(err)}`);
          return [];
        },
      );
    await client.session
      .update({ sessionID, permissions: permissionRules(this.mode, agentRules) })
      .catch((err) => this.ctx.log(`[opencode] could not set the session's permissions: ${formatOpenCodeError(err)}`));
  }

  /** Tell the server which model (and reasoning variant) the session runs. */
  private async switchModel(): Promise<void> {
    if (!this.model) return;
    const { client, session } = await this.ready;
    await client.session
      .switchModel({ sessionID: session.id, model: { ...this.model, ...(this.variant ? { variant: this.variant } : {}) } })
      .catch(() => {});
  }

  async interrupt(): Promise<void> {
    // The interrupted turn's remaining text is dropped rather than left to
    // keep arriving; its final entries still carry whatever it produced.
    this.partials.reset();
    try {
      const { client, session } = await this.ready;
      await client.session.interrupt({ sessionID: session.id });
    } catch {
      // Best effort — an already-idle OpenCode session can legitimately
      // refuse an interrupt.
    }
  }

  /**
   * Stop a task the phone can see: a sub-agent left running in the
   * background (its task id is its child session's id), or a background
   * shell command (its task id is the shell's). Either may already be gone —
   * the task ended between the phone's tap and this call — and a target the
   * server no longer knows is the outcome that was wanted, not a failure:
   * the task's own end, or the lack of one, is what reports it.
   */
  async stopTask(taskId: string): Promise<void> {
    const shell = this.shells.get(taskId);
    const child = shell ? undefined : this.children.get(taskId);
    if (!shell && !child?.background) throw new Error('No such task is running');
    if (shell) shell.stopping = true;
    else if (child) child.stopping = true;
    const { client } = await this.ready;
    try {
      // The delete must name the session's own directory: the server scopes
      // shells by location, and a delete without one drops its record
      // without ending the process, which would leave the command running
      // while the phone was told it stopped.
      if (shell) await client.shell.remove({ id: taskId, location: { directory: this.cwd } });
      else await client.session.interrupt({ sessionID: taskId });
    } catch (err) {
      if (isNotFound(err)) {
        // A sub-agent's child session reports its own end, but a shell the
        // server has forgotten will send no exit for this session to read:
        // report it stopped here, or it would show as running for good.
        if (shell) this.finishShell({ id: taskId, status: 'killed' });
        return;
      }
      throw new Error(`OpenCode could not stop the task: ${formatOpenCodeError(err)}`);
    }
  }

  /** What the session has cost so far, as OpenCode prices its models (no
   *  subscription windows: OpenCode has none to report). A free or
   *  unpriced model's session reports no cost. */
  async getUsage(): Promise<UsageData | null> {
    const { client, session } = await this.ready;
    try {
      const info = await client.session.get({ sessionID: session.id });
      const context = this.lastTokens ? openCodeContext(this.lastTokens, this.contextWindow) : undefined;
      return {
        available: true,
        windows: [],
        ...(info.cost ? { sessionCostUsd: info.cost } : {}),
        ...(context ? { context } : {}),
        fetchedAt: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.abortController.abort();
    this.partials.reset();
    // The session is gone from this client: no shell event will arrive for it.
    this.shells.clear();
    try {
      const { client, session } = await this.ready;
      await client.session.interrupt({ sessionID: session.id });
    } catch {
      // Best effort — the session may never have been created, or may
      // already be gone server-side.
    }
  }
}

/** The parts of a v2 form the question card reads. */
interface FormInfoLike {
  id: string;
  sessionID: string;
  title: string;
  metadata?: Record<string, unknown>;
  fields: FormFieldLike[];
}

export interface OpenCodeSessionOptions {
  /** The models a session may choose from, and its default. */
  catalog?: () => Promise<OpenCodeCatalog>;
}

export interface OpenCodeDriverOptions {
  /** An OpenCode server to connect to. Wins over `autoStart`. */
  serverUrl?: string;
  /** Spawn and manage an OpenCode server when no `serverUrl` is given. */
  autoStart?: boolean;
  /** `opencode` executable for auto-start (else resolved from PATH). */
  binaryPath?: string;
  /** Installs `opencode` for auto-start when none is found. */
  installOpenCode?: () => Promise<string>;
  /** The environment to look for an installed `opencode` in (PATH,
   *  CODEDECK_OPENCODE_PATH); the host's own by default. */
  lookupEnv?: NodeJS.ProcessEnv;
  port?: number;
  log: (message: string) => void;
  /** Outbound HTTP to provider profiles' endpoints. */
  providerHttp?: ProviderHttp;
  /** Seams for tests: how the server is started and connected to. */
  startServer?: (options: StartOpenCodeServerOptions) => Promise<OpenCodeServerHandle>;
  connect?: (config: { baseUrl: string; headers?: Record<string, string> }) => OpenCodeClient;
  /** How long a server's first start is given to refresh its model list
   *  (`MODELS_REFRESH_WAIT_MS` by default; 0 does not wait). */
  modelsRefreshWaitMs?: number;
}

/** A server's first start on a machine answers from the models snapshot
 *  built into it until it has fetched models.dev, a few hundred ms later,
 *  and says so with `models-dev.refreshed`. The snapshot can name retired
 *  models and even default to one (2.0.28's names `opencode/exo-free`), so
 *  a session or a model list asked for in that window would get a model
 *  that no longer runs. Later starts load the list kept from that fetch,
 *  current from the first answer, and send no such event — so only a first
 *  start waits. The wait is capped: with models.dev unreachable no event
 *  comes and the snapshot stays — then it is the best list there is. */
export const MODELS_REFRESH_WAIT_MS = 3_000;

/** Where the server keeps its database, which holds the models.dev list it
 *  fetched: its data directory, XDG's on every platform. No database yet
 *  means a first start. */
export function openCodeDatabase(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_DATA_HOME?.trim() || path.join(homedir(), '.local', 'share');
  return path.join(base, 'opencode', 'opencode.db');
}

/** Wait for a just-started server's `models-dev.refreshed`, at most
 *  `waitMs`. Not when the fetch is switched off, and not past a stream that
 *  fails: either way there is nothing to wait for. The server loads its
 *  catalog, and fetches models.dev, only once something asks for it, so the
 *  wait asks: nothing else would until the wait is over. */
async function modelsRefreshed(client: OpenCodeClient, env: NodeJS.ProcessEnv, waitMs: number): Promise<void> {
  const disabled = env.OPENCODE_DISABLE_MODELS_FETCH;
  if (waitMs <= 0 || (disabled !== undefined && disabled !== '' && disabled !== '0' && disabled !== 'false')) return;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A stream that could not open, or ended, has nothing more to say; and
  // neither it nor the ask may fail the start, so both are settled here.
  const refreshed = (async () => {
    for await (const event of client.event.subscribe({ signal: abort.signal })) {
      if (event.type === 'models-dev.refreshed') return;
    }
  })().catch(() => {});
  void (async () => client.model.list())().catch(() => {});
  // The deadline races the stream rather than relying on the abort to end
  // it: a pending read is not interrupted by every stream.
  const deadline = new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)));
  try {
    await Promise.race([refreshed, deadline]);
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

/** Why OpenCode cannot run, when it is enabled but unusable. */
const NOT_CONFIGURED = 'This bridge has no OpenCode server to use (CODEDECK_OPENCODE_SERVER_URL), and starts none of its own.';

export class OpenCodeDriver implements Driver {
  private clientPromise: Promise<OpenCodeClient> | null = null;
  private server: OpenCodeServerHandle | null = null;
  private unavailable: string | undefined;
  /** The `opencode` the server runs, once found or installed. */
  private bin: string | null = null;
  /** Auto-start with no `opencode` on the machine: it is installed, then
   *  started, in the background; a failed attempt is retried by the next
   *  session. */
  private installs = false;
  private stopped = false;
  /** Where the provider profiles go among the server's providers, and the
   *  catalog that placed them (it fills in their models). */
  private placed: Placement[] = [];
  private catalog: Catalog = EMPTY_CATALOG;
  /** The placements the running server was started with: their
   *  fingerprint, and the providers they made. */
  private served = providersFingerprint([]);
  private serving: Served = NOTHING_SERVED;
  /** Provider changes are applied one at a time, in order. */
  private applying: Promise<void> = Promise.resolve();
  /** Sessions on the running server, ended when it is replaced; ended
   *  ones are dropped. */
  private readonly sessions = new Set<OpenCodeSession>();
  readonly plugins: PluginManager = new OpenCodePlugins(() => this.client());
  readonly mcp: McpManager = new OpenCodeMcp(() => this.client());
  readonly accounts = new OpenCodeAccounts(() => this.client(), { log: (message) => this.options.log(message) });
  readonly permissionRules: PermissionRuleManager = new OpenCodePermissionRules(() => this.client(), (message) => this.options.log(message));

  private constructor(private readonly options: OpenCodeDriverOptions) {}

  /** The driver starts the server, so it decides the server's config. */
  private get manages(): boolean {
    return !this.options.serverUrl && Boolean(this.options.autoStart);
  }

  /** The server's client, starting it again when the last attempt failed. */
  private client(): Promise<OpenCodeClient> {
    if (!this.clientPromise && !this.stopped && (this.bin || this.installs)) this.launch();
    return this.clientPromise ?? Promise.reject(new Error(this.unavailable ?? NOT_CONFIGURED));
  }

  /** Connect to (or start) the configured server. Never throws: a driver
   *  that cannot reach OpenCode is still advertised, with the reason. */
  static async create(options: OpenCodeDriverOptions): Promise<OpenCodeDriver> {
    const driver = new OpenCodeDriver(options);
    if (options.serverUrl) {
      if (options.autoStart) options.log('[opencode] both a server URL and auto-start are configured — using the server URL');
      driver.clientPromise = Promise.resolve(driver.connect({ baseUrl: options.serverUrl }));
    } else if (options.autoStart) {
      driver.bin = resolveOpenCodePath(options.binaryPath, options.lookupEnv);
      if (!driver.bin && options.installOpenCode) {
        driver.installs = true;
        driver.launch();
      } else if (!driver.bin) {
        driver.unavailable =
          'OpenCode auto-start is enabled but the `opencode` executable was not found (set CODEDECK_OPENCODE_PATH).';
      } else {
        try {
          driver.clientPromise = Promise.resolve(await driver.startServer(driver.bin));
        } catch (err) {
          driver.unavailable = err instanceof Error ? err.message : String(err);
        }
      }
    } else {
      driver.unavailable = NOT_CONFIGURED;
    }
    if (driver.unavailable) options.log(`[opencode] unavailable: ${driver.unavailable}`);
    return driver;
  }

  /** A driver over an existing client (tests). */
  static withClient(client: OpenCodeClient): OpenCodeDriver {
    const driver = new OpenCodeDriver({ log: () => {} });
    driver.clientPromise = Promise.resolve(client);
    return driver;
  }

  private connect(config: { baseUrl: string; headers?: Record<string, string> }): OpenCodeClient {
    return (this.options.connect ?? OpenCode.make)(config);
  }

  /** Start `opencode serve` with the provider profiles it should have, and
   *  connect to it. */
  private async startServer(bin: string): Promise<OpenCodeClient> {
    const placed = this.placed;
    const setup = serverSetup(placed, this.catalog, process.env);
    const start = this.options.startServer ?? startOpenCodeServer;
    const env = { ...process.env, ...setup.env };
    const firstStart = !existsSync(openCodeDatabase(env));
    let server: OpenCodeServerHandle;
    try {
      server = await start({
        command: bin,
        env,
        ...(this.options.port !== undefined ? { port: this.options.port } : {}),
      });
    } catch (err) {
      throw new Error(`The OpenCode server failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.stopped) {
      await server.close();
      throw new Error('the agent host is shutting down');
    }
    this.server = server;
    this.served = providersFingerprint(placed);
    this.serving = servedBy(placed);
    const added = placed.length > 0 ? `, with ${placed.length} provider profile(s)` : '';
    this.options.log(`[opencode] started ${server.url} (pid ${server.pid ?? '?'})${added}`);
    const client = this.connect({ baseUrl: server.url, headers: setup.headers });
    // Everything waits on this start (the client promise), so nothing reads
    // the models before they are current.
    if (firstStart) {
      await modelsRefreshed(client, env, this.options.modelsRefreshWaitMs ?? MODELS_REFRESH_WAIT_MS);
      // Shut down meanwhile: the server is closed, and this start is over.
      if (this.stopped) throw new Error('the agent host is shutting down');
    }
    return client;
  }

  /** Find (or install) `opencode`, start its server and connect — sessions
   *  and model lists asked for meanwhile wait on the same promise. `first`
   *  runs before the start (closing the server being replaced). */
  private launch(first?: () => Promise<void>): void {
    const attempt = (async (): Promise<OpenCodeClient> => {
      await first?.();
      this.bin ??= await this.options.installOpenCode!();
      return this.startServer(this.bin);
    })();
    this.clientPromise = attempt;
    attempt.then(
      () => {
        this.unavailable = undefined;
      },
      (err: unknown) => {
        this.options.log(`[opencode] unavailable: ${err instanceof Error ? err.message : String(err)}`);
        if (this.clientPromise === attempt) this.clientPromise = null;
      },
    );
  }

  /** The provider profiles to add to OpenCode's own providers, placed by
   *  its catalog (providers.ts); one that would shadow a provider OpenCode
   *  has is left out, with the reason. The server reads
   *  its config only when it starts, so a changed list restarts it:
   *  sessions on the old one end with an error and the bridge resumes them
   *  on the new one. */
  async setProviders(providers: ProviderBinding[]): Promise<RefusedProvider[]> {
    if (!this.manages) {
      throw new Error('OpenCode runs on a server this bridge does not start (CODEDECK_OPENCODE_SERVER_URL), so it cannot add provider profiles to it');
    }
    const apply = this.applying.then(() => this.applyProviders(providers));
    this.applying = apply.then(
      () => {},
      () => {},
    );
    return apply;
  }

  private async applyProviders(providers: ProviderBinding[]): Promise<RefusedProvider[]> {
    // A server still being installed or started is waited for: it may have
    // read an older list, and its catalog places the profiles.
    await this.clientPromise?.catch(() => {});
    // A profile the bridge would not let a session use is not added either.
    const usable = providers.filter((p) => isValidProviderBaseUrl(p.baseUrl) && p.authToken !== '' && p.models.length > 0);
    const catalog = await this.readCatalog();
    const { placed, refused } = placeProfiles(usable, catalog, this.serving);
    this.placed = placed;
    this.catalog = catalog;
    if (this.stopped || !this.server || !this.bin || providersFingerprint(placed) === this.served) return refused;
    this.options.log('[opencode] restarting the server: its provider profiles changed');
    const old = this.server;
    this.server = null;
    this.launch(() => old.close());
    // A session holds the old server's client: its password stops working
    // and its event stream reconnects for ever to the new server, so it
    // would never end on its own. Ended now, the bridge resumes it on the
    // new server (OpenCode keeps the conversation on disk).
    const stale = [...this.sessions];
    this.sessions.clear();
    for (const session of stale) session.serverReplaced();
    await this.clientPromise;
    return refused;
  }

  /** The running server's catalog (catalog.ts). Empty when it cannot say:
   *  every profile is then a provider of its own, nothing refused or
   *  filled in. */
  private async readCatalog(): Promise<Catalog> {
    try {
      const client = await this.clientPromise;
      if (!client) return EMPTY_CATALOG;
      const [providers, models] = await Promise.all([client.provider.list(), client.model.list()]);
      return {
        providers: new Map(providers.data.map((p) => [p.id, p])),
        models: new Map(models.data.map((m) => [`${m.providerID}/${m.modelID}`, m])),
        connected: new Set(providers.data.filter((p) => p.activation === 'enabled').map((p) => p.id)),
      };
    } catch (err) {
      this.options.log(`[opencode] could not read its provider catalog, so profiles are not checked against it: ${err instanceof Error ? err.message : String(err)}`);
      return EMPTY_CATALOG;
    }
  }

  info(): AgentInfo {
    return {
      id: OPENCODE_AGENT_ID,
      displayName: 'OpenCode',
      modes: OPENCODE_MODES,
      efforts: [],
      defaultMode: DEFAULT_MODE,
      // Usage is the session's cost. Provider profiles add models to the
      // server this driver starts; sessions are never bound to one.
      supports: {
        models: true,
        usage: true,
        providers: false,
        providerModels: this.manages,
        interrupt: true,
        commands: true,
        plugins: true,
        mcp: true,
        tasks: true,
        permissionRules: true,
        // Through the server's own API, so a key or a sign-in reaches a
        // running server without the restart a provider profile costs.
        accounts: true,
      },
      credentials: [],
      ...(this.unavailable ? { unavailableReason: this.unavailable } : {}),
      style: OPENCODE_STYLE,
    };
  }

  startSession(params: StartSession, ctx: SessionContext): DriverSession {
    if (params.provider) throw new Error('OpenCode offers provider profiles as models; a session is not bound to one');
    if (!this.clientPromise && this.installs && !this.stopped) this.launch();
    if (!this.clientPromise) throw new Error(this.unavailable ?? NOT_CONFIGURED);
    if (params.mode !== undefined && !OPENCODE_MODES.some((m) => m.id === params.mode)) {
      throw new Error(`OpenCode has no mode '${params.mode}'`);
    }
    if (params.model && !splitModelId(params.model)) {
      throw new Error(`'${params.model}' is not an OpenCode provider/model id — choose one from its model list.`);
    }
    const session = new OpenCodeSession(params, ctx, this.clientPromise, { catalog: () => this.listModels() });
    for (const s of this.sessions) if (s.isEnded) this.sessions.delete(s);
    this.sessions.add(session);
    return session;
  }

  /** A profile is reached as an OpenAI-compatible provider: a session on
   *  it posts chat completions. */
  async checkProvider(provider: ProviderBinding, model: string): Promise<boolean | undefined> {
    return this.options.providerHttp ? checkToken(OPENAI_API, provider, model, this.options.providerHttp.post) : undefined;
  }

  async listProviderModels(baseUrl: string, token: string): Promise<EndpointModel[]> {
    if (!this.options.providerHttp) throw new Error('this host reads no provider endpoints');
    return listModels(OPENAI_API, baseUrl, token, this.options.providerHttp.get);
  }

  /** Best-effort model list from OpenCode's configured providers, and the
   *  default among them (see pickDefaultModel) — empty on any failure. Ids
   *  are `<providerID>/<modelID>`, the shape a session expects. */
  async listModels(): Promise<OpenCodeCatalog> {
    if (!this.clientPromise) return { models: [] };
    try {
      const client = await this.clientPromise;
      const listed = await client.model.list();
      // The default is an extra: a server that cannot name one still lists
      // its models, and a list without a default is worth more than none.
      let fallback: { data?: { providerID: string; modelID: string } | null } | null = null;
      try {
        fallback = await client.model.default();
      } catch {
        fallback = null;
      }
      const models: ModelEntry[] = [];
      const contextLimits: Record<string, number> = {};
      const profiles = new Map(this.placed.map((p) => [p.providerId, p.profile]));
      for (const model of listed.data) {
        if (!model.enabled) continue;
        const id = `${model.providerID}/${model.modelID}`;
        const profile = profiles.get(model.providerID);
        const group = profile
          ? profileModelGroup(profile.label || model.providerID, profile.models.find((m) => m.id === model.modelID))
          : model.providerID;
        const efforts = reasoningLevels(model.variants);
        models.push({ id, label: model.name, provider: group, ...(efforts.length > 0 ? { efforts } : {}) });
        const window = model.limit?.context ?? 0;
        if (window > 0) contextLimits[id] = window;
      }
      const configured = fallback?.data ? `${fallback.data.providerID}/${fallback.data.modelID}` : undefined;
      const defaultModel = pickDefaultModel(configured, listed.data);
      return { models, contextLimits, ...(defaultModel ? { defaultModel } : {}) };
    } catch {
      return { models: [] };
    }
  }

  /** OpenCode deletes a session's subagent sessions with it. */
  async deleteConversation(conversationId: string, cwd: string): Promise<void> {
    const client = await this.client();
    try {
      await client.session.remove({ sessionID: conversationId });
    } catch (err) {
      // A session already gone is the outcome that was wanted.
      if (isNotFound(err)) return;
      throw new Error(`OpenCode could not delete session ${conversationId}: ${formatOpenCodeError(err)}`);
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.accounts.close();
    await this.server?.close();
  }
}

/** Whether a client error is the server's "no such thing" — 404, or the
 *  declared not-found error it answers a missing session with (whose body's
 *  `_tag`, e.g. `ShellNotFoundError`, the client sets as the error's name). */
function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; cause?: { status?: unknown } };
  if (typeof e.cause?.status === 'number') return e.cause.status === 404;
  return typeof e.name === 'string' && /NotFound/.test(e.name);
}
