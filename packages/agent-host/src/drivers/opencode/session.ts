/**
 * One OpenCode session, over the server client: it subscribes to the
 * server's event stream, normalizes it down to stable `OpenCodeEvent`s
 * (adapter.ts translates those into entries), and answers OpenCode's
 * permission asks and its forms (the cards a question becomes) through the
 * bridge.
 */
import * as path from 'node:path';
import type { OpenCodeClient, PermissionAsked, PermissionRule, SessionInfo, V2Event } from '@opencode/client';
import { parseSlashCommand } from '../../sdk/commands';
import type { DriverSession, SessionContext, SessionMcpState } from '../../sdk/driver';
import { PartialCoalescer } from '../../sdk/partial';
import { PERMISSION_ALLOW, PERMISSION_ALLOW_ALWAYS, PERMISSION_DENY, toolLocations, unknownToolReporter } from '../../sdk/tools';
import { newTranslateContext, type TranslateContext } from '../../sdk/transcript';
import type { Persona, SessionOption, SlashCommand, StartSession, Subagent, TaskStatus, UsageData } from '../../sdk/types';
import { opencodeEventToEntries, QUESTION_TOOL, SHELL_TOOL, toolCallDiffs, toolResultText, type OpenCodeEvent } from './adapter';
import {
  contextTokens,
  DEFAULT_VARIANT,
  describePermission,
  formatOpenCodeError,
  isNotFound,
  isPlaceholderTitle,
  openCodeContext,
  retryText,
  splitModelId,
  toFormAnswer,
  toQuestionSpecs,
  toSlashCommands,
  unsupportedModelReason,
  type FormFieldLike,
  type OpenCodeCatalog,
} from './format';
import { openCodeSessionMcp, toggleOpenCodeMcp } from './mcp';
import { allowInProject, AUTO_APPROVE_MODE, BUILD_AGENT, DEFAULT_MODE, OPENCODE_MODES, permissionRules, PLAN_AGENT, PLAN_MODE } from './modes';
import { delay, isPersona, listSelectablePersonas, PERSONA_LOAD_MS, PERSONA_POLL_MS, PERSONA_WAIT_MS } from './personas';
import { SESSION_COMMANDS, sessionCommand, sessionSlashCommands } from './sessionCommands';
import { opencodeTool } from './tools';

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

export class OpenCodeSession implements DriverSession {
  private readonly cwd: string;
  private readonly abortController = new AbortController();
  private readonly translate: TranslateContext;
  /** Told a tool name no agent's table lists, which the log then carries. */
  private readonly reportUnknownTool: (toolName: string) => void;
  private ended = false;
  private mode: string;
  /** The persona the session runs as. Plan mode runs OpenCode's own plan
   *  agent instead, and comes back to this one when it leaves. */
  private persona: string = BUILD_AGENT;
  /** When the session became ready. Its directory's own agents are still
   *  loading for a moment after, so a persona list asked for meanwhile
   *  waits rather than answering with the built-ins alone. */
  private personasReadyAt?: number;
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
  /** Whether the server it runs on is up: until then nothing runs on it. */
  private serverUp = false;
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
    clientPromise.then(
      () => (this.serverUp = true),
      () => {},
    );
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

  /** The server this session runs on exited: the session ends with the
   *  reason, so the bridge can resume the conversation on the next one. */
  serverLost(reason: string): void {
    this.finish(reason);
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
      const { session, resumeLost } = await this.resolveSession(client, params);
      // Before any prompt can run: which persona the session runs as, and
      // the rules of the agent that is actually running — the persona's
      // denies must hold from the first tool call, not from the first mode
      // switch.
      await this.resolvePersona(client, session, params, resumeLost);
      // OpenCode runs whatever agent the session recorded: a new one is
      // created on build (or plan), and a resumed one may still name a
      // persona whose file has since gone, which would fail its next turn.
      const running = this.runningAgent();
      // A session that names none runs the one it was created on, or else
      // OpenCode's default.
      const created = !params.resume || resumeLost;
      const recorded = session.agent ?? (created && this.mode === PLAN_MODE ? PLAN_AGENT : BUILD_AGENT);
      if (recorded !== running) {
        await client.session.switchAgent({ sessionID: session.id, agent: running }).catch(() => {});
      }
      await this.statePermissions(client, session.id, running);
      // The "memory was lost" notice goes ahead of the session's first line.
      if (resumeLost) this.deliver({ type: 'resume-lost' });
      if (!this.ended) {
        this.ctx.emit({ type: 'info', nativeSessionId: session.id, ...(model ? { model } : {}), mode: this.mode, persona: this.persona });
        this.reportTitle(session.title);
        this.ctx.emit({ type: 'ready' });
        // From here the session's directory has been booted, and its own
        // agents are the ones still loading.
        this.personasReadyAt = Date.now();
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
        // Only "the server does not have this session" is a lost
        // conversation. A transport failure says nothing about the session:
        // falling through to a fresh one would discard the transcript for a
        // server that is merely unreachable, and that server could not
        // create the new session either.
        if (!isNotFound(err)) {
          throw new Error(`OpenCode could not look up session ${params.resume}: ${formatOpenCodeError(err)}`);
        }
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

  /** The OpenCode agent the session runs right now: Plan mode runs the plan
   *  agent, every other mode the persona. */
  private runningAgent(): string {
    return this.mode === PLAN_MODE ? PLAN_AGENT : this.persona;
  }

  /**
   * Which persona the session runs as, decided before it is ready so every
   * prompt and every permission rule is stated for it.
   *
   * A new session is created on the plan agent in Plan mode and `build`
   * otherwise; a persona the phone named is waited for — a directory's own
   * agents load a moment after it was booted — and must be one a session can
   * run as. A resumed session keeps the agent OpenCode recorded, so a
   * restart resumes as the session actually ran. Only decides: the caller
   * switches OpenCode's session to it.
   */
  private async resolvePersona(
    client: OpenCodeClient,
    session: SessionInfo,
    params: StartSession,
    resumeLost: boolean,
  ): Promise<void> {
    if (params.resume && !resumeLost && session.agent && (await this.selectableAgent(client, session.agent))) {
      this.persona = session.agent;
      return;
    }
    const requested = params.persona;
    if (!requested || requested === BUILD_AGENT) {
      this.persona = BUILD_AGENT;
      return;
    }
    if (await this.waitForAgent(client, requested)) {
      // Plan mode keeps its own agent; the persona applies when it leaves.
      this.persona = requested;
      return;
    }
    this.persona = BUILD_AGENT;
    this.deliver({
      type: 'persona-notice',
      text: `OpenCode has no agent '${requested}' here, so this session runs as Build.`,
    });
  }

  /** OpenCode's record of `id` in this session's directory. `found` is false
   *  when the agent does not exist (yet), which a caller may wait on. */
  private async agentLookup(client: OpenCodeClient, id: string): Promise<{ found: boolean; persona?: string }> {
    try {
      const got = await client.agent.get({ agentID: id, location: { directory: this.cwd } });
      return { found: true, ...(isPersona(got.data) ? { persona: got.data.id } : {}) };
    } catch {
      return { found: false };
    }
  }

  /** The agent under `id`, when it is one a session can run as. */
  private async selectableAgent(client: OpenCodeClient, id: string): Promise<string | undefined> {
    return (await this.agentLookup(client, id)).persona;
  }

  /** Wait for a just-booted directory's agents to load, then answer whether
   *  `id` is one a session can run as. An agent that exists but is not one
   *  ends the wait at once: it never becomes one. */
  private async waitForAgent(client: OpenCodeClient, id: string): Promise<boolean> {
    const deadline = Date.now() + PERSONA_WAIT_MS;
    for (;;) {
      const { found, persona } = await this.agentLookup(client, id);
      if (persona) return true;
      if (found || Date.now() >= deadline) return false;
      await delay(PERSONA_POLL_MS);
    }
  }

  /**
   * Apply the agent the session runs as now and state its rules, through the
   * queue: the host runs a second switch while the first is still talking to
   * the server, and each queued one reads the mode and persona set last, so
   * the session ends on the agent and rules of the final one, never a mix.
   */
  private queueAgentSwitch(client: OpenCodeClient, session: SessionInfo): Promise<void> {
    const switched = this.agentSwitch.then(async () => {
      const agent = this.runningAgent();
      await client.session.switchAgent({ sessionID: session.id, agent }).catch(() => {});
      await this.statePermissions(client, session.id, agent);
    });
    this.agentSwitch = switched;
    return switched;
  }

  /**
   * A directory's agent files changed: the persona this session runs as may
   * be gone, and the rules of the agent running may have changed. Anything
   * for another directory is not this session's news — the directory is
   * compared resolved, since the server may spell the same one differently.
   */
  private async onAgentUpdated(client: OpenCodeClient, directory: string | undefined): Promise<void> {
    if (this.ended) return;
    if (directory !== undefined && path.resolve(directory) !== path.resolve(this.cwd)) return;
    try {
      const { session } = await this.ready;
      if (this.ended) return;
      const removed = this.persona;
      if (removed !== BUILD_AGENT && !(await this.selectableAgent(client, removed))) {
        this.persona = BUILD_AGENT;
        this.deliver({
          type: 'persona-notice',
          text: `OpenCode's agent '${removed}' was removed, so this session runs as Build.`,
        });
        if (!this.ended) this.ctx.emit({ type: 'info', persona: BUILD_AGENT });
      }
      // The agent running now has its rules restated whatever changed: its
      // own file may be the one that was edited.
      await this.queueAgentSwitch(client, session);
    } catch (err) {
      // Nothing here may escape: this runs off the event stream, where a
      // rejection has no one to catch it. A session that never came up has
      // nothing to restate; anything else is worth the log.
      this.ctx.log(`[opencode] could not restate the session after an agent change: ${formatOpenCodeError(err)}`);
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
        // A directory's agent files changed: the persona this session runs
        // as may be gone, and the rules of the agent running may have
        // changed. Handled off the stream, since it talks to the server.
        case 'agent.updated': {
          void this.onAgentUpdated(client, event.location?.directory);
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

  /** The personas this session can run as: the selectable agents in its
   *  directory, waiting a moment for the directory's own agents to load
   *  after the session became ready. */
  async listPersonas(): Promise<Persona[]> {
    const { client } = await this.ready;
    return listSelectablePersonas(client, { directory: this.cwd }, (this.personasReadyAt ?? Date.now()) + PERSONA_LOAD_MS);
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
        // switching the mode switches both: the plan agent (or the session's
        // persona), and whether a tool call reaches the phone at all.
        const { client, session } = await this.ready;
        await this.queueAgentSwitch(client, session);
        return;
      }
      case 'persona': {
        // The session runs as the persona outside Plan mode; in Plan mode it
        // runs OpenCode's plan agent, and comes back to the persona when it
        // leaves. Either way the persona is what a switch is validated
        // against, so an agent that is gone is refused before it is set.
        const { client, session } = await this.ready;
        const found = await this.selectableAgent(client, value);
        if (!found) throw new Error(`OpenCode has no agent '${value}' here`);
        this.persona = found;
        if (this.mode === PLAN_MODE) return;
        await this.queueAgentSwitch(client, session);
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
    const agentRules = await this.agentRules(client, agent);
    await client.session
      .update({ sessionID, permissions: permissionRules(this.mode, agentRules) })
      .catch((err) => this.ctx.log(`[opencode] could not set the session's permissions: ${formatOpenCodeError(err)}`));
  }

  /** `agent`'s own permission rules in this session's directory. A directory
   *  OpenCode has only just booted has no agents for a moment — even `build`
   *  is not found until about 0.1-0.3 s after the session was created
   *  (verified against 2.1.4) — so a missing agent is waited for, as a
   *  persona is; reading too early would drop rules such as the plan agent's
   *  edit deny for the session's first turn. */
  private async agentRules(client: OpenCodeClient, agent: string): Promise<PermissionRule[]> {
    const deadline = Date.now() + PERSONA_WAIT_MS;
    for (;;) {
      try {
        return (await client.agent.get({ agentID: agent, location: { directory: this.cwd } })).data.permissions;
      } catch (err) {
        if (!isNotFound(err) || Date.now() >= deadline) {
          this.ctx.log(`[opencode] could not read agent ${agent}'s permissions: ${formatOpenCodeError(err)}`);
          return [];
        }
        await delay(PERSONA_POLL_MS);
      }
    }
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
    // A server still to start (waiting for its provider profiles, or being
    // installed) runs nothing of this session's, and may not start before
    // the host stops waiting on this end.
    if (!this.serverUp) return;
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
