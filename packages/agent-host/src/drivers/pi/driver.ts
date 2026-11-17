/**
 * The Pi driver, over its RPC mode (`pi --mode rpc`): JSONL commands on
 * stdin, responses and session events on stdout, and an extension-UI
 * sub-protocol for dialogs (rpc.ts).
 *
 * What Pi does not have is a permission system of its own. CodeDeck's
 * extension (extension.ts) holds every `tool_call` until this driver answers,
 * which is what turns Pi's tool calls into the phone's permission cards: the
 * driver decides whether a card is needed — `yolo`, Pi's read-only tools, and
 * a tool allowed for the session are answered at once — and the card is built
 * from the `tool_execution_start` facts of that call.
 *
 * One Pi process serves exactly one CodeDeck session (runtime.ts). The session
 * is Pi's own on disk: `get_state` reports its id and file, and a resume
 * opens it again with `--session`.
 *
 * Deliberate limits, all of them this driver's for now: no plugins or MCP
 * management (Pi reads its own configuration), no subscription usage (there
 * is none to ask), no background-task control. Provider profiles are session
 * bindings only; their models are not added to Pi's own catalog.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Driver, DriverSession, SessionContext } from '../../sdk/driver';
import type { ProviderHttp } from '../../sdk/net';
import { OPENAI_API, checkToken, listModels } from '../../sdk/providerApi';
import type { EndpointModel } from '../../sdk/providerModels';
import { now, PERMISSION_ALLOW, PERMISSION_DENY, toolLocations, unknownToolReporter } from '../../sdk/tools';
import { truncateToolResult } from '../../sdk/transcript';
import { PartialCoalescer } from '../../sdk/partial';
import type {
  AgentInfo,
  ModelEntry,
  OptionChoice,
  OutputEntry,
  PermissionOption,
  PermissionRequest,
  ProviderBinding,
  QuestionOutcome,
  QuestionSpec,
  SelectOutcome,
  SessionOption,
  SlashCommand,
  StartSession,
  UsageData,
} from '../../sdk/types';
import { PiAccounts } from './accounts';
import { buildPiEnv } from './env';
import { PI_PERMISSION_PREFIX, installPiExtension } from './extension';
import { PI_LABEL } from './install';
import { PiRpc, type PiRecord, type PiRpcOptions } from './rpc';
import { PI_READ_ONLY_TOOLS, piTool } from './tools';
import { PI_STYLE } from './style';
import { PiRuntime, piCommand, type PiRuntimeOptions } from './runtime';

export const PI_AGENT_ID = 'pi';

const ASK_MODE = 'ask';
const YOLO_MODE = 'yolo';
const DEFAULT_MODE = ASK_MODE;
const PI_MODES = [
  { id: ASK_MODE, label: 'Ask', description: 'Ask before each tool call, except for read-only tools' },
  { id: YOLO_MODE, label: 'YOLO', description: 'Run every tool without asking' },
];

/** Pi's thinking levels (`--thinking`, `set_thinking_level`). A model that
 *  does not support one clamps it, as Pi does in its own UI; the list is the
 *  vocabulary, not a promise that every model has every level. */
const PI_EFFORTS: OptionChoice[] = [
  { id: 'off', label: 'Off', description: 'No reasoning.' },
  { id: 'minimal', label: 'Minimal', description: 'The shortest reasoning budget.' },
  { id: 'low', label: 'Low', description: 'A small reasoning budget.' },
  { id: 'medium', label: 'Medium', description: "Pi's default balance." },
  { id: 'high', label: 'High', description: 'For harder tasks.' },
  { id: 'xhigh', label: 'Extra high', description: 'Only models that support it.' },
  { id: 'max', label: 'Max', description: 'Only models that support it.' },
];
/** Pi's own default when neither the settings nor the session says. */
const DEFAULT_EFFORT = 'medium';

/** The card's third choice: the tool is not asked about again in this
 *  session. Pi itself has no saved rules, so this lives in the session. */
const ALLOW_SESSION: PermissionOption = { id: 'allow_session', label: 'Allow for this session', kind: 'allow_always' };

/** What Pi prints on stderr, before exiting with 1, when `--session` names a
 *  conversation it does not have (verified against 1.5.2: "No session found
 *  matching '<id>'"). */
const PI_SESSION_MISSING = /^No session found matching /;

/** How long the model probe may take: it starts a Pi process and reads its
 *  declarative catalog, so no account or endpoint is involved. */
const PROBE_TIMEOUT_MS = 30_000;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** The text blocks of a Pi tool result, joined as the phone shows them. */
function resultText(result: unknown): string {
  const content = recordOf(result)?.content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block) => {
      const part = recordOf(block);
      return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [];
    })
    .join('\n');
}

/** The model a provider profile names, and the model id inside it. A
 *  bound session names its profile's model — with or without the profile's
 *  id before it — and the model id itself may contain a slash (a gateway's
 *  routing key), so the bound profile wins over splitting at the first
 *  slash. */
function splitModel(model: string, boundProvider: string | undefined): { provider?: string; modelId: string } {
  if (boundProvider !== undefined) {
    const prefix = `${boundProvider}/`;
    return { provider: boundProvider, modelId: model.startsWith(prefix) ? model.slice(prefix.length) : model };
  }
  const slash = model.indexOf('/');
  if (slash > 0) return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
  return { modelId: model };
}

/** What one Pi session is built with. */
interface PiSessionDeps {
  runtime: PiRuntime;
  home: string;
  baseEnv: NodeJS.ProcessEnv;
  spawnFn?: PiRpcOptions['spawnFn'];
  log: (message: string) => void;
}

export class PiSession implements DriverSession {
  private rpc: PiRpc | undefined;
  private sessionMode: string;
  private readonly allowedTools = new Set<string>();
  private readonly toolFacts = new Map<string, { name: string; input: Record<string, unknown> }>();
  /** Dialog requests Pi is waiting on, by id, so an interrupt or the
   *  session's end answers every one. */
  private readonly openUi = new Set<string>();
  /** Dialogs an interrupt or the session's end already answered: their
   *  handlers must not send a second response. */
  private readonly cancelledUi = new Set<string>();
  private readonly coalescer: PartialCoalescer;
  private readonly reportUnknownTool: (toolName: string) => void;

  private ended = false;
  private ready = false;
  private running = false;
  private nativeSessionId: string | undefined;
  private sessionFile: string | undefined;
  private contextWindow: number | undefined;
  private contextPercentage: number | undefined;
  private modelLabel: string | undefined;
  private currentProvider: string | undefined;
  private currentModelId: string | undefined;
  /** The assistant message being streamed: its part key prefix and the
   *  content indexes that streamed under it. */
  private assistant: { key: string; parts: Map<number, 'text' | 'thinking'> } | undefined;
  private lastStderr = '';
  /** The last failed attempt's error, until Pi says whether it retries. */
  private heldError: string | undefined;
  /** Pi said the conversation `--session` names does not exist. */
  private sessionMissing = false;
  /** Prompts that arrived before the process was ready; flushed at `ready`. */
  private readonly queuedPrompts: string[] = [];
  /** The child's environment. Built synchronously, so a provider profile that
   *  cannot be used refuses the session before it starts. */
  private readonly env: Record<string, string>;
  /** The running process once it accepts commands; rejected if the session
   *  ends first. An option changed while Pi starts waits on it, rather than
   *  being dropped as if it applied. */
  private readonly started: Promise<PiRpc>;
  private settleStarted!: { resolve(rpc: PiRpc): void; reject(error: Error): void };

  constructor(
    private readonly params: StartSession,
    private readonly ctx: SessionContext,
    private readonly deps: PiSessionDeps,
  ) {
    this.sessionMode = params.mode ?? DEFAULT_MODE;
    this.started = new Promise<PiRpc>((resolve, reject) => {
      this.settleStarted = { resolve, reject };
    });
    // Nobody may be waiting when the session ends early.
    this.started.catch(() => {});
    this.env = buildPiEnv(params, deps.home, deps.baseEnv);
    this.reportUnknownTool = unknownToolReporter((message) => ctx.log(message));
    this.coalescer = new PartialCoalescer((update) => {
      if (!this.ended) this.ctx.emit({ type: 'partial', ...update });
    });
    this.start();
  }

  // --- startup ---

  private start(): void {
    void this.launch().catch((error: unknown) => {
      this.fail(error instanceof Error ? error.message : String(error));
    });
  }

  private async launch(): Promise<void> {
    const entry = await this.deps.runtime.entryPoint();
    if (this.ended) return;
    const extension = installPiExtension(this.deps.home);
    const command = piCommand(entry, this.arguments(extension));
    this.rpc = new PiRpc({
      command: command.command,
      args: command.args,
      cwd: this.params.cwd,
      env: this.env,
      onEvent: (record) => this.event(record),
      onUiRequest: (record) => this.uiRequest(record),
      onExit: (code, signal) => this.exited(code, signal),
      onStderr: (line) => {
        this.lastStderr = line;
        if (PI_SESSION_MISSING.test(line)) this.sessionMissing = true;
        this.deps.log(`[pi] ${line}`);
      },
      onBadLine: (line, reason) => {
        this.deps.log(`[pi] dropped a line from Pi (${reason})${line ? `: ${line.slice(0, 200)}` : ''}`);
      },
      ...(this.deps.spawnFn !== undefined ? { spawnFn: this.deps.spawnFn } : {}),
    });

    const state = recordOf(await this.rpc.request('get_state'));
    if (this.ended) return;
    this.nativeSessionId = str(state?.sessionId);
    this.sessionFile = str(state?.sessionFile);
    const model = recordOf(state?.model);
    if (model) {
      this.currentProvider = str(model.provider);
      this.currentModelId = str(model.id);
      this.modelLabel = str(model.name) ?? this.modelName();
      this.contextWindow = num(model.contextWindow);
    }
    this.ready = true;
    this.ctx.emit({
      type: 'info',
      ...(this.nativeSessionId ? { nativeSessionId: this.nativeSessionId } : {}),
      ...(this.modelLabel ? { model: this.modelLabel } : {}),
      mode: this.sessionMode,
      ...(this.contextWindow !== undefined ? { contextWindow: this.contextWindow } : {}),
    });
    this.ctx.emit({ type: 'ready' });
    this.settleStarted.resolve(this.rpc);
    for (const text of this.queuedPrompts.splice(0)) this.prompt(text);
  }

  private arguments(extension: string): string[] {
    const args = ['--mode', 'rpc', '--offline', '-e', extension];
    if (this.params.resume) args.push('--session', this.params.resume);
    const model = this.params.model?.trim();
    if (model) args.push('--model', this.modelArgument(model));
    const effort = this.params.effort?.trim();
    if (effort) args.push('--thinking', effort);
    return args;
  }

  /** The selector `--model` takes: a profile-bound session names its
   *  profile's model under the profile's id, so Pi resolves it even when the
   *  bridge sent only the model id. */
  private modelArgument(model: string): string {
    const provider = this.params.provider?.id;
    if (provider === undefined) return model;
    return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
  }

  private modelName(): string | undefined {
    if (this.currentProvider !== undefined && this.currentModelId !== undefined) {
      return `${this.currentProvider}/${this.currentModelId}`;
    }
    return this.currentModelId;
  }

  // --- process and turn state ---

  private exited(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.ended) return;
    const why = this.lastStderr || `Pi exited (${code ?? signal ?? 'no code'})`;
    this.ended = true;
    this.settleStarted.reject(new Error(`the Pi session ended: ${why}`));
    this.coalescer.reset();
    this.openUi.clear();
    this.ctx.emit({
      type: 'ended',
      error: this.ready ? why : `Pi could not start: ${why}`,
      // Only Pi saying the conversation is not there makes it lost: the
      // bridge then starts the session fresh and forgets the old id, which
      // any other early exit (a crash, a bad flag) must not cost the user.
      ...(this.params.resume && !this.ready && this.sessionMissing ? { resumeLost: true } : {}),
    });
  }

  /** A failure before Pi ran (the runtime would not install, the process
   *  would not answer). The conversation, if any, is untouched on disk. */
  private fail(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.settleStarted.reject(new Error(`the Pi session ended: ${reason}`));
    this.coalescer.reset();
    this.ctx.emit({ type: 'ended', error: reason });
  }

  private emit(entries: OutputEntry[]): void {
    if (!this.ended && entries.length > 0) this.ctx.emit({ type: 'entries', entries });
  }

  /** One session event from Pi. Everything Pi reports after `agent_settled`
   *  that adds nothing to the phone's transcript — queue state, retry
   *  progress, compaction bookkeeping — is left out. */
  private event(record: PiRecord): void {
    if (this.ended) return;
    switch (record.type) {
      case 'agent_settled':
        this.settled(record.aborted === true);
        return;
      case 'message_start':
        this.messageStart(record.message);
        return;
      case 'message_update':
        this.messageUpdate(record);
        return;
      case 'message_end':
        this.messageEnd(record.message);
        return;
      case 'tool_execution_start':
        this.toolStart(record);
        return;
      case 'tool_execution_end':
        this.toolEnd(record);
        return;
      case 'auto_retry_start':
        this.retrying(record);
        return;
      case 'auto_retry_end':
        if (record.success === false) {
          // Pi gave up: its final error is the turn's, said once.
          this.heldError = undefined;
          this.emit([{ entryType: 'error', text: str(record.finalError) ?? 'Pi gave up after retrying', timestamp: now() }]);
        }
        return;
      case 'extension_error':
        this.deps.log(`[pi] an extension failed: ${String(record.error ?? record.event ?? 'unknown')}`);
        return;
      default:
        return;
    }
  }

  private messageStart(message: unknown): void {
    const msg = recordOf(message);
    if (msg?.role !== 'assistant') {
      this.assistant = undefined;
      return;
    }
    this.assistant = { key: String(num(msg.timestamp) ?? Date.now()), parts: new Map() };
  }

  private messageUpdate(record: PiRecord): void {
    const update = recordOf(record.assistantMessageEvent);
    if (!update || !this.assistant) return;
    const index = num(update.contentIndex) ?? 0;
    const delta = str(update.delta);
    if (delta === undefined) return;
    if (update.type === 'text_delta') {
      this.assistant.parts.set(index, 'text');
      this.coalescer.delta({ key: `${this.assistant.key}:${index}`, entryType: 'text', text: delta });
    } else if (update.type === 'thinking_delta') {
      this.assistant.parts.set(index, 'thinking');
      this.coalescer.delta({ key: `${this.assistant.key}:${index}`, entryType: 'thinking', text: delta });
    }
  }

  private messageEnd(message: unknown): void {
    const msg = recordOf(message);
    if (msg?.role !== 'assistant') return;
    const assistant = this.assistant;
    this.assistant = undefined;
    const entries: OutputEntry[] = [];
    const timestamp = now();

    const errorMessage = str(msg.errorMessage);
    const aborted = msg.stopReason === 'aborted';
    if (msg.stopReason === 'error' || (errorMessage !== undefined && !aborted)) {
      // Whatever streamed is dropped: the error replaces it. It is held, not
      // shown: Pi may retry the request (`auto_retry_start` follows), and a
      // failed attempt that a later one recovers from is not the turn's error.
      for (const index of assistant?.parts.keys() ?? []) this.coalescer.complete(`${assistant!.key}:${index}`);
      this.heldError = errorMessage ?? 'Pi reported an error';
      return;
    }
    // An aborted response is the user's own interrupting: its partial content
    // is completed as text, with no error row to blame them for it.

    const content = Array.isArray(msg.content) ? msg.content : [];
    content.forEach((block, index) => {
      const part = recordOf(block);
      const key = assistant ? `${assistant.key}:${index}` : undefined;
      const streamed = assistant?.parts.get(index);
      if (part?.type === 'text' && typeof part.text === 'string' && part.text !== '') {
        entries.push({
          entryType: 'text',
          role: 'agent',
          text: part.text,
          ...(streamed === 'text' && key !== undefined ? { part: key } : {}),
          timestamp,
        });
      } else if (part?.type === 'thinking' && typeof part.text === 'string' && part.text !== '') {
        entries.push({
          entryType: 'thinking',
          text: part.text,
          ...(streamed === 'thinking' && key !== undefined ? { part: key } : {}),
          timestamp,
        });
      }
      if (key !== undefined) this.coalescer.complete(key);
    });

    const provider = str(msg.provider);
    const modelId = str(msg.model);
    if (provider !== undefined && modelId !== undefined && (provider !== this.currentProvider || modelId !== this.currentModelId)) {
      this.currentProvider = provider;
      this.currentModelId = modelId;
      const label = this.modelName();
      if (label !== undefined && label !== this.modelLabel) {
        this.modelLabel = label;
        this.ctx.emit({ type: 'info', model: label });
      }
    }
    this.emit(entries);
  }

  private toolStart(record: PiRecord): void {
    const callId = str(record.toolCallId);
    const toolName = str(record.toolName);
    if (callId === undefined || toolName === undefined) return;
    const input = recordOf(record.args) ?? {};
    this.toolFacts.set(callId, { name: toolName, input });
    const call = piTool(toolName, input, this.reportUnknownTool);
    const locations = toolLocations(input);
    this.emit([
      {
        entryType: 'tool_call',
        callId,
        toolName,
        kind: call.kind,
        title: call.title,
        ...(locations.length > 0 ? { locations } : {}),
        ...(call.input !== undefined ? { input: call.input } : {}),
        timestamp: now(),
      },
    ]);
  }

  private toolEnd(record: PiRecord): void {
    const callId = str(record.toolCallId);
    if (callId === undefined) return;
    this.toolFacts.delete(callId);
    // The facts are gone by now; a call the permission gate hid would be
    // known here, but nothing is hidden: Pi's own question tools are none.
    const text = resultText(record.result);
    this.emit([
      {
        entryType: 'tool_result',
        callId,
        text: text === '' ? (record.isError === true ? 'The tool failed.' : '(no output)') : truncateToolResult(text),
        ...(record.isError === true ? { isError: true } : {}),
        timestamp: now(),
      },
    ]);
  }

  /** Pi will try the failed request again: one status line says so, in
   *  place of the attempt's error. */
  private retrying(record: PiRecord): void {
    this.heldError = undefined;
    const attempt = num(record.attempt);
    const of = num(record.maxAttempts);
    const delay = num(record.delayMs);
    // The first line, briefly: a provider's error can be a page of JSON, and
    // the full text is the error entry's if Pi gives up.
    const firstLine = str(record.errorMessage)?.split('\n')[0];
    const why = firstLine !== undefined && firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine;
    const when = delay !== undefined ? ` in ${Math.max(1, Math.round(delay / 1000))}s` : '';
    const count = attempt !== undefined && of !== undefined ? ` (${attempt} of ${of})` : '';
    this.emit([{ entryType: 'status', text: `Retrying${when}${count}${why ? `: ${why}` : ''}`, timestamp: now() }]);
  }

  private settled(aborted: boolean): void {
    // An error Pi did not retry is the turn's: shown now that nothing follows
    // — unless the user stopped the turn, which is why nothing followed.
    if (this.heldError !== undefined && !aborted) {
      this.emit([{ entryType: 'error', text: this.heldError, timestamp: now() }]);
    }
    this.heldError = undefined;
    this.coalescer.reset();
    this.assistant = undefined;
    if (!this.running) return;
    this.running = false;
    this.emit([{ entryType: 'turn_complete', timestamp: now() }]);
    this.ctx.emit({ type: 'turn', state: 'idle' });
    void this.refreshContext();
  }

  /** Pi reports the context-window estimate it uses for its own compaction
   *  footer; the phone gets it as session info, the way the other drivers
   *  report their agents' meters. */
  private async refreshContext(): Promise<void> {
    if (!this.rpc?.alive) return;
    try {
      const stats = recordOf(await this.rpc.request('get_session_stats'));
      const usage = recordOf(stats?.contextUsage);
      const window = num(usage?.contextWindow);
      const percent = num(usage?.percent);
      const rounded = percent !== undefined ? Math.round(percent) : undefined;
      const changedWindow = window !== undefined && window > 0 && window !== this.contextWindow;
      const changedPercent = rounded !== undefined && rounded !== this.contextPercentage;
      if (changedWindow) this.contextWindow = window;
      if (changedPercent) this.contextPercentage = rounded;
      if (!this.ended && (changedWindow || changedPercent)) {
        this.ctx.emit({
          type: 'info',
          ...(changedWindow ? { contextWindow: window } : {}),
          ...(changedPercent ? { contextPercentage: rounded } : {}),
        });
      }
    } catch {
      // The meter is cosmetic: a session that cannot report it runs on.
    }
  }

  // --- the permission gate and other extensions' dialogs ---

  private uiRequest(record: PiRecord): void {
    if (this.ended) return;
    const method = str(record.method);
    if (method === 'notify') {
      const text = str(record.message);
      if (text !== undefined) this.emit([{ entryType: 'status', text, timestamp: now() }]);
      return;
    }
    if (method !== 'select' && method !== 'confirm' && method !== 'input' && method !== 'editor') return;
    const id = str(record.id);
    if (id === undefined) return;
    this.openUi.add(id);
    void this.answerUi(id, method, record)
      .catch((error: unknown) => {
        this.deps.log(`[pi] could not answer a dialog: ${error instanceof Error ? error.message : String(error)}`);
        this.respond({ type: 'extension_ui_response', id, cancelled: true });
      })
      .finally(() => this.openUi.delete(id));
  }

  private respond(response: Record<string, unknown>): void {
    const id = str(response.id);
    if (id !== undefined && this.cancelledUi.has(id)) return;
    this.rpc?.respond(response);
  }

  private async answerUi(id: string, method: string, record: PiRecord): Promise<void> {
    const title = str(record.title) ?? '';
    if (method === 'select' && title.startsWith(PI_PERMISSION_PREFIX)) {
      await this.answerPermission(id, title.slice(PI_PERMISSION_PREFIX.length));
      return;
    }
    if (method === 'select') {
      const options = Array.isArray(record.options) ? record.options.filter((o): o is string => typeof o === 'string') : [];
      const outcome = await this.ask(id, title || 'Pi asks', options);
      this.reply(id, outcome);
      return;
    }
    if (method === 'confirm') {
      const message = str(record.message);
      const question = message !== undefined && message !== title ? `${title}\n\n${message}` : title || 'Pi asks';
      const outcome = await this.ask(id, question, ['Yes', 'No']);
      if (outcome.outcome === 'cancelled') {
        this.respond({ type: 'extension_ui_response', id, cancelled: true });
        return;
      }
      const answer = outcome.answers[0];
      const yes =
        answer?.type === 'selected' ? answer.labels.includes('Yes') : answer?.type === 'text' ? /^\s*y/i.test(answer.text) : false;
      this.respond({ type: 'extension_ui_response', id, confirmed: yes });
      return;
    }
    // input / editor: free text, with the editor's prefill in the question.
    const prefill = str(record.prefill);
    const question = prefill !== undefined ? `${title || 'Pi asks'}\n\n${prefill}` : title || 'Pi asks';
    const outcome = await this.ask(id, question, []);
    this.reply(id, outcome);
  }

  private ask(requestId: string, question: string, options: string[]): Promise<QuestionOutcome> {
    const spec: QuestionSpec = {
      question,
      ...(options.length > 0 ? { options: options.map((label) => ({ label })) } : {}),
    };
    return this.ctx.askQuestion(requestId, [spec]);
  }

  private reply(id: string, outcome: QuestionOutcome): void {
    if (outcome.outcome === 'cancelled') {
      this.respond({ type: 'extension_ui_response', id, cancelled: true });
      return;
    }
    const answer = outcome.answers[0];
    const value = answer?.type === 'selected' ? (answer.labels[0] ?? '') : answer?.type === 'text' ? answer.text : '';
    this.respond({ type: 'extension_ui_response', id, value });
  }

  /**
   * One CodeDeck permission gate. The facts of the call Pi already reported
   * name the tool, its input and its kind; whether it needs a card at all is
   * this driver's decision, and the phone's answer becomes Pi's `select`
   * value: only "allow" lets the call run.
   */
  private async answerPermission(id: string, callId: string): Promise<void> {
    const facts = this.toolFacts.get(callId);
    const toolName = facts?.name ?? 'tool';
    if (this.sessionMode === YOLO_MODE || this.allowedTools.has(toolName) || PI_READ_ONLY_TOOLS.has(toolName)) {
      this.respond({ type: 'extension_ui_response', id, value: 'allow' });
      return;
    }
    const input = facts?.input ?? {};
    const call = piTool(toolName, input, this.reportUnknownTool);
    const locations = toolLocations(input);
    const request: Omit<PermissionRequest, 'sessionId'> = {
      requestId: id,
      toolName,
      kind: call.kind,
      title: call.title,
      ...(locations.length > 0 ? { locations } : {}),
      options: [PERMISSION_ALLOW, { ...ALLOW_SESSION, label: `Allow ${toolName} for this session` }, PERMISSION_DENY],
    };
    const outcome: SelectOutcome = await this.ctx.requestPermission(request);
    if (this.cancelledUi.has(id)) return;
    if (outcome.outcome === 'cancelled') {
      this.respond({ type: 'extension_ui_response', id, cancelled: true });
      return;
    }
    if (outcome.optionId === PERMISSION_ALLOW.id || outcome.optionId === ALLOW_SESSION.id) {
      if (outcome.optionId === ALLOW_SESSION.id) this.allowedTools.add(toolName);
      this.respond({ type: 'extension_ui_response', id, value: 'allow' });
      return;
    }
    this.respond({ type: 'extension_ui_response', id, value: 'deny' });
  }

  /** Answer every dialog still waiting with "cancelled". Pi does not settle
   *  an agent while an extension dialog is open (verified against 1.5.2), so
   *  an interrupt and the session's end must close them. */
  private cancelDialogs(): void {
    for (const id of this.openUi) {
      if (this.cancelledUi.has(id)) continue;
      this.cancelledUi.add(id);
      this.rpc?.respond({ type: 'extension_ui_response', id, cancelled: true });
    }
    this.openUi.clear();
  }

  // --- the DriverSession surface ---

  prompt(text: string): void {
    if (this.ended) return;
    if (!this.ready || this.rpc === undefined) {
      // The bridge waits for `ready` before it offers input; a prompt that
      // races the process start is held rather than dropped.
      this.queuedPrompts.push(text);
      return;
    }
    if (!this.running) {
      this.running = true;
      this.ctx.emit({ type: 'turn', state: 'running' });
      void this.startTurn(text);
      return;
    }
    // A message while a turn runs is steered into that turn: Pi delivers it
    // after the current tool calls, before the next model request.
    void this.rpc.request('steer', { message: text }).catch((error: unknown) => {
      this.deps.log(`[pi] could not steer the running turn: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async startTurn(text: string): Promise<void> {
    try {
      if (this.rpc === undefined) throw new Error('the process is not running');
      const data = recordOf(await this.rpc.request('prompt', { message: text }));
      if (this.ended) return;
      // "handled": an extension command consumed the prompt, so no run
      // started — the turn is over as soon as it began.
      if (data?.disposition === 'handled' && this.running) {
        this.running = false;
        this.emit([{ entryType: 'turn_complete', timestamp: now() }]);
        this.ctx.emit({ type: 'turn', state: 'idle' });
      }
    } catch (error: unknown) {
      if (this.ended) return;
      this.emit([
        { entryType: 'error', text: `Pi refused the prompt: ${error instanceof Error ? error.message : String(error)}`, timestamp: now() },
      ]);
      if (this.running) {
        this.running = false;
        this.ctx.emit({ type: 'turn', state: 'idle' });
      }
    }
  }

  async interrupt(): Promise<void> {
    if (this.ended) return;
    this.cancelDialogs();
    try {
      await this.rpc?.request('abort');
    } catch (error: unknown) {
      this.deps.log(`[pi] could not abort the turn: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async setOption(option: SessionOption, value: string): Promise<void> {
    switch (option) {
      case 'mode':
        if (!PI_MODES.some((mode) => mode.id === value)) throw new Error(`${PI_LABEL} has no mode '${value}'`);
        this.sessionMode = value;
        return;
      case 'effort':
        if (!PI_EFFORTS.some((effort) => effort.id === value)) throw new Error(`${PI_LABEL} has no thinking level '${value}'`);
        await (await this.started).request('set_thinking_level', { level: value });
        return;
      case 'model': {
        const { provider, modelId } = splitModel(value, this.params.provider?.id);
        const rpc = await this.started;
        const data = recordOf(await rpc.request('set_model', { ...(provider !== undefined ? { provider } : {}), modelId }));
        const label = str(data?.name) ?? (provider !== undefined ? `${provider}/${modelId}` : modelId);
        if (label !== this.modelLabel) {
          this.modelLabel = label;
          this.ctx.emit({ type: 'info', model: label });
        }
        return;
      }
    }
  }

  async getUsage(): Promise<UsageData | null> {
    return null;
  }

  async listCommands(): Promise<SlashCommand[]> {
    if (this.ended || !this.rpc?.alive) return [];
    try {
      const data = recordOf(await this.rpc.request('get_commands'));
      const commands = Array.isArray(data?.commands) ? data.commands : [];
      return commands.flatMap((raw): SlashCommand[] => {
        const command = recordOf(raw);
        const name = str(command?.name);
        if (name === undefined) return [];
        const description = str(command?.description);
        return [{ name, ...(description !== undefined ? { description } : {}) }];
      });
    } catch (error: unknown) {
      this.deps.log(`[pi] could not list commands: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.settleStarted.reject(new Error('the Pi session ended'));
    this.cancelDialogs();
    this.coalescer.reset();
    await this.rpc?.close();
  }
}

export interface PiDriverOptions {
  runtime: PiRuntime;
  /** `CODEDECK_PI_HOME` — where Pi's settings, credentials and sessions
   *  live. */
  home: string;
  /** The environment a session inherits (the host's, without its own
   *  variables). */
  baseEnv?: NodeJS.ProcessEnv;
  /** Outbound HTTP to provider profiles' endpoints. */
  providerHttp?: ProviderHttp;
  /** Spawn seam for tests. */
  spawnFn?: PiRpcOptions['spawnFn'];
  /** Spawn seam for the account helper, in tests. */
  accountsSpawnFn?: PiRpcOptions['spawnFn'];
  log: (message: string) => void;
}

export class PiDriver implements Driver {
  private unavailable: string | undefined;
  private models?: Promise<{ models: ModelEntry[]; defaultModel?: string }>;
  /** Pi's provider keys and sign-ins, stored where Pi's own `/login` keeps
   *  them; a change makes the model list be read again. */
  readonly accounts: PiAccounts;

  constructor(private readonly options: PiDriverOptions) {
    // Pi's state root must exist before the first process starts in it
    // (whether that is a session or the model probe).
    try {
      fs.mkdirSync(options.home, { recursive: true });
    } catch (error) {
      options.log(`[pi] could not create ${options.home}: ${error instanceof Error ? error.message : String(error)}`);
    }
    // The runtime is fetched as the host starts, like the other agents', so
    // the first session (and the model list the phone asks for before it)
    // finds it ready instead of waiting on a download.
    void options.runtime.prepare();
    this.accounts = new PiAccounts({
      home: options.home,
      entryPoint: () => options.runtime.entryPoint(),
      env: () => buildPiEnv({}, options.home, options.baseEnv ?? process.env),
      changed: () => {
        this.models = undefined;
      },
      ...(options.accountsSpawnFn !== undefined ? { spawnFn: options.accountsSpawnFn } : {}),
    });
  }

  /** Mark the driver unusable (a path the operator named is not a file). */
  setUnavailable(reason: string): void {
    this.unavailable = reason;
  }

  /** The release of the installed package, from its manifest. */
  version(): Promise<string | undefined> {
    return this.options.runtime.version();
  }

  info(): AgentInfo {
    return {
      id: PI_AGENT_ID,
      displayName: PI_LABEL,
      modes: PI_MODES,
      efforts: PI_EFFORTS,
      defaultMode: DEFAULT_MODE,
      defaultEffort: DEFAULT_EFFORT,
      // What the RPC surface carries: models, commands and interruption, and
      // a provider profile bound to a session. Its plugins, MCP servers and
      // saved permission rules are its own configuration and have no manager
      // here; there is no subscription usage to ask for.
      supports: {
        models: true,
        usage: false,
        providers: true,
        interrupt: true,
        commands: true,
        accounts: true,
        plugins: false,
        mcp: false,
        tasks: false,
      },
      credentials: [],
      style: PI_STYLE,
      ...(this.unavailable ? { unavailableReason: this.unavailable } : {}),
    };
  }

  startSession(params: StartSession, ctx: SessionContext): DriverSession {
    if (this.unavailable) throw new Error(this.unavailable);
    if (params.mode !== undefined && !PI_MODES.some((mode) => mode.id === params.mode)) {
      throw new Error(`${PI_LABEL} has no mode '${params.mode}'`);
    }
    if (params.effort !== undefined && !PI_EFFORTS.some((effort) => effort.id === params.effort)) {
      throw new Error(`${PI_LABEL} has no thinking level '${params.effort}'`);
    }
    // Built here so a provider that cannot be used at all refuses the
    // session before it starts, rather than after an error entry.
    return new PiSession(params, ctx, {
      runtime: this.options.runtime,
      home: this.options.home,
      baseEnv: this.options.baseEnv ?? process.env,
      ...(this.options.spawnFn !== undefined ? { spawnFn: this.options.spawnFn } : {}),
      log: this.options.log,
    });
  }

  /**
   * Pi's model catalog, from a short-lived probe process: the list is the
   * package's own built-ins plus the operator's `models.json`, and reading it
   * needs neither a credential nor a reachable endpoint. Cached once it says
   * something, and asked again after a failure or an empty answer.
   */
  listModels(): Promise<{ models: ModelEntry[]; defaultModel?: string }> {
    this.models ??= this.probeModels().catch((error: unknown) => {
      this.models = undefined;
      this.options.log(`[pi] could not list models: ${error instanceof Error ? error.message : String(error)}`);
      return { models: [] };
    });
    return this.models;
  }

  private async probeModels(): Promise<{ models: ModelEntry[]; defaultModel?: string }> {
    const entry = await this.options.runtime.entryPoint();
    const command = piCommand(entry, ['--mode', 'rpc', '--no-session', '--offline']);
    const rpc = new PiRpc({
      command: command.command,
      args: command.args,
      cwd: this.options.home,
      env: buildPiEnv({}, this.options.home, this.options.baseEnv ?? process.env),
      onEvent: () => {},
      onUiRequest: () => {},
      onExit: () => {},
      onStderr: () => {},
      onBadLine: () => {},
      ...(this.options.spawnFn !== undefined ? { spawnFn: this.options.spawnFn } : {}),
    });
    try {
      const listed = recordOf(await rpc.request('get_available_models', {}, PROBE_TIMEOUT_MS));
      const state = recordOf(await rpc.request('get_state', {}, PROBE_TIMEOUT_MS));
      const models: ModelEntry[] = [];
      for (const raw of Array.isArray(listed?.models) ? listed.models : []) {
        const model = recordOf(raw);
        const id = str(model?.id);
        const provider = str(model?.provider);
        if (id === undefined) continue;
        const full = provider !== undefined ? `${provider}/${id}` : id;
        const name = str(model?.name);
        models.push({ id: full, label: name ?? id, ...(provider !== undefined ? { provider } : {}) });
      }
      const current = recordOf(state?.model);
      const currentId = str(current?.id);
      const currentProvider = str(current?.provider);
      if (models.length === 0) this.models = undefined;
      return {
        models,
        ...(currentId !== undefined
          ? { defaultModel: currentProvider !== undefined ? `${currentProvider}/${currentId}` : currentId }
          : {}),
      };
    } finally {
      await rpc.close(1_000);
    }
  }

  /** Pi speaks OpenAI's chat-completions API to a profile's endpoint, so the
   *  token is checked the way any OpenAI-compatible client would. */
  async checkProvider(provider: ProviderBinding, model: string): Promise<boolean | undefined> {
    return this.options.providerHttp ? checkToken(OPENAI_API, provider, model, this.options.providerHttp.post) : undefined;
  }

  async listProviderModels(baseUrl: string, token: string): Promise<EndpointModel[]> {
    if (!this.options.providerHttp) throw new Error('this host reads no provider endpoints');
    return listModels(OPENAI_API, baseUrl, token, this.options.providerHttp.get);
  }

  /**
   * Remove Pi's record of conversation `id`: its session file, under
   * whichever project directory Pi filed it in. The layout is Pi's own —
   *
   *   $PI_CODING_AGENT_DIR/sessions/<encoded cwd>/<timestamp>_<id>.jsonl
   *
   * — and the project directory is not recomputed here: an id is a UUID, so
   * every one is searched. Resolves when nothing of it is left.
   */
  async deleteConversation(conversationId: string, cwd: string): Promise<void> {
    void cwd; // Pi files sessions by cwd; every project directory is searched.
    if (!/^[A-Za-z0-9._-]+$/.test(conversationId) || conversationId === '.' || conversationId === '..') {
      throw new Error(`'${conversationId}' is not a Pi session id`);
    }
    const root = path.join(this.options.home, 'sessions');
    for (const project of directories(root)) {
      const dir = path.join(root, project);
      for (const name of files(dir)) {
        if (name.endsWith(`_${conversationId}.jsonl`) || name === `${conversationId}.jsonl`) {
          await fs.promises.rm(path.join(dir, name), { force: true });
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    this.accounts.close();
    await this.options.runtime.close();
  }
}

function directories(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function files(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
