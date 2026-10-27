/**
 * The pure translations between OpenCode's data and the shapes the phone
 * reads: its token counters, retries, model ids and defaults, errors,
 * permission asks, commands and question forms. Nothing here talks to the
 * server, so the session and the driver both use it.
 */
import type { ModelInfo, SessionInfo } from '@opencode/client';
import { slashCommand } from '../../sdk/commands';
import type {
  ContextBreakdown,
  ContextCategory,
  ModelEntry,
  OptionChoice,
  QuestionReply,
  QuestionSpec,
  SlashCommand,
} from '../../sdk/types';

/** `model/providerID` split — a v2 model reference wants `{providerID, id}`,
 *  not a single string. A model id with no `/` (or an empty half) has no
 *  valid split, so nothing is named and OpenCode falls back to its own
 *  configured default — no fabrication. */
export function splitModelId(model: string | undefined): { providerID: string; id: string } | undefined {
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
export const DEFAULT_VARIANT = 'default';

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

/** Whether a client error is the server's "no such thing" — 404, or the
 *  declared not-found error it answers a missing session with (whose body's
 *  `_tag`, e.g. `ShellNotFoundError`, the client sets as the error's name). */
export function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; cause?: { status?: unknown } };
  if (typeof e.cause?.status === 'number') return e.cause.status === 404;
  return typeof e.name === 'string' && /NotFound/.test(e.name);
}
