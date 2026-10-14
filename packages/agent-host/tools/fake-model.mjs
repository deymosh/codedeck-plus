/**
 * A local model server: the endpoint Claude Code, the DeepSeek Harness and
 * OpenCode can each be pointed at, so a driver can be driven end to end with
 * no account, no network and the same bytes every run.
 *
 * What a real model will not reliably produce — a tool call, a question
 * form, a plan to approve, an API error, an answer long enough to move the
 * context figure — is what a driver change most needs to see, and is exactly
 * what a scripted reply decides. Which scenario a request gets is read from
 * the prompt the agent sent, in the same vocabulary the `fake` agent uses
 * (src/drivers/fake/driver.ts), so one set of prompts covers both:
 *
 *   /tool [command]  call the shell tool the request itself offers (Claude
 *                    Code's `Bash`, OpenCode's `shell`, the Harness's `bash`)
 *                    — the same call a permission card is raised for, and on
 *                    OpenCode one is; the tool's own result then gets a plain
 *                    answer, which is what ends the turn
 *   /question        ask one multiple-choice question through the request's
 *                    own question tool, then answer with the reply the agent
 *                    hands back
 *   /plan-approval   propose a plan for the agent's own plan tool, for the
 *                    card the approval travels through
 *   /error           answer with a 400 API error, so the failure path is
 *                    exercised
 *   /long            answer with a lot of text, for the transcript and for a
 *                    context figure that has moved
 *   anything else    echoed back (`echo: <text>`)
 *
 * The model id and the token counts are fixed (FAKE_MODEL_ID, USAGE), so a
 * cost an agent computes from the usage it was given is the same every run.
 * The CONTEXT figure is not the model's to set: each agent counts the
 * conversation it holds and reports that (Claude Code asks
 * `/v1/messages/count_tokens` for each piece of its own prompt, which this
 * server answers), so `/long` moves it by making the conversation bigger.
 *
 * A request is answered in the shape it asked for, which is not cosmetic:
 * Claude Code's auto-mode safety classifier asks WITHOUT `stream`, and SSE
 * frames sent to a reader waiting for one JSON body are not a reply it can
 * read — it then refuses the tool call as unclassifiable.
 *
 * Two wire shapes are served, because the three agents do not agree on one:
 * `POST /v1/messages` (Anthropic messages — Claude Code and the DeepSeek
 * Harness) and `POST /v1/chat/completions` (OpenAI chat completions —
 * DeepSeek's own API shape and an OpenCode custom provider). `GET /v1/models`
 * answers both readers from one body.
 *
 * Run standalone for poking at it by hand:
 *
 *   node tools/fake-model.mjs [--port N] [--host IP] [--log PATH] [--dump DIR]
 *
 * or in-process, which is what `./codedeck live <agent> --fake-model` does
 * (live-probe.mjs starts it, binds the session to it and closes it again):
 *
 *   const model = await startFakeModel();
 *   … a provider profile whose baseUrl is model.url …
 *   await model.close();
 */
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

/** The one model both shapes answer with. */
export const FAKE_MODEL_ID = 'fake-model-1';
/** Its display name, for a list that carries one. */
export const FAKE_MODEL_LABEL = 'Fake model';

/**
 * The token counts every reply reports — every reply, so an agent's own cost
 * arithmetic over them is the same figure every run.
 */
export const USAGE = { input: 4_242, output: 17, cached: 0 };

/** `/long`'s text: long enough to wrap, truncate and scroll in a client, and
 *  long enough that the context figure the agent derives from it has moved. */
export const LONG_TEXT = Array.from(
  { length: 80 },
  (_, i) => `line ${i + 1} of the long answer: ${'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod'.repeat(1)}`,
).join('\n');

/** The scenario commands, in the order the vocabulary lists them. */
export const SCENARIOS = ['tool', 'question', 'plan-approval', 'error', 'long'];

/**
 * How long a streamed reply is held between pieces, and the longest a text can
 * be before it is split at all: long enough that a driver coalescing at ~250 ms
 * sends several updates for `/long` rather than one, which is what makes live
 * text observable against a scripted model that has no streaming pace of its
 * own. Short replies still stream whole.
 */
export const STREAM_CHUNK_DELAY_MS = 60;

/**
 * A text as the pieces its stream carries, in order: a short one whole, a long
 * one split on newline boundaries where it can — the same shape a real model's
 * token stream has, which is what a coalescing driver turns into a few
 * observable updates.
 */
export function textPieces(text) {
  if (text.length <= 400) return [text];
  const count = Math.min(20, Math.max(2, Math.ceil(text.length / 400)));
  const target = Math.ceil(text.length / count);
  const pieces = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + target);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      if (nl > start) end = nl + 1;
    }
    pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces;
}

/** A prompt line that is a scenario command: `/tool`, `/question rest…`. */
const COMMAND_RE = /^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/;

/**
 * The scenario a text asks for, or null for the echo default. Whatever
 * follows the command on its line is the command's argument.
 *
 * The LAST command line wins, not the first: an agent appends its own output
 * to the prompt it was given — Claude Code answers a slash command of its
 * own with `<local-command-stdout>…</local-command-stdout>` right there in
 * the text — so the newest line is the one the user actually typed. Reading
 * the first would re-run a scenario the agent has since moved past.
 */
export function parsePrompt(text) {
  const trimmed = text.trim();
  const lines = trimmed.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = COMMAND_RE.exec(lines[i].trim());
    if (match && SCENARIOS.includes(match[1])) {
      return { scenario: match[1], text: (match[2] ?? '').trim() };
    }
  }
  return { scenario: null, text: trimmed };
}

/**
 * The text the agent's own user typed last, and whether that turn carries
 * nothing but tool results.
 *
 * Both shapes carry the conversation as `messages`; the difference is where
 * a turn's text lives and how a tool result is marked. A message can hold
 * both — Claude Code sends the previous turn's tool result in the same user
 * message as the prompt that follows it — so a turn is a tool result only
 * when it carries no text of its own, and the result text never counts as
 * something the user typed.
 *
 * Reminders are removed by their delimiters rather than by position: Claude
 * Code's own note can precede the prompt, follow it, or sit in a block of
 * its own, and a reminder listing slash commands must not read as one the
 * user sent.
 */
export function lastTurn(body, shape) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (shape === 'openai') {
      if (message?.role === 'tool') return { toolResult: true, text: readContent(message.content).text, own: '' };
      if (message?.role !== 'user') continue;
      return turnOf(readContent(message.content));
    }
    if (message?.role !== 'user') continue;
    return turnOf(readContent(message.content));
  }
  return { toolResult: false, text: '', own: '' };
}

function turnOf(read) {
  return {
    toolResult: read.text === '' && read.results.length > 0,
    text: read.text || read.results.join('\n'),
    own: read.own,
  };
}

/** Text blocks of a message's content, and the text of any tool results
 *  among them — kept apart, because one is the user talking and the other is
 *  a tool answering.
 *
 *  `text` is every block joined, which is what a scenario marker is looked
 *  for in; `own` is the first block that carries anything, which is the
 *  user's own words — an agent appends its own context to a prompt as
 *  further blocks (the DeepSeek Harness adds its runtime context to every
 *  message), and an echo of those is noise rather than a reply.
 *
 *  Reminders are removed by their delimiters rather than by position: Claude
 *  Code's own note can precede the prompt, follow it, or sit in a block of
 *  its own, and a reminder listing slash commands must not read as one the
 *  user sent. */
function readContent(content) {
  const texts = [];
  const results = [];
  if (typeof content === 'string') texts.push(content);
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'string') texts.push(block);
      else if (block?.type === 'tool_result') {
        const inner = readContent(block.content);
        results.push(inner.text || inner.results.join('\n'));
      } else if (typeof block?.text === 'string') texts.push(block.text);
    }
  }
  const stripped = texts
    .map((text) => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim())
    .filter((text) => text !== '');
  return { text: stripped.join('\n'), own: stripped[0] ?? '', results };
}

/** The title a title request is answered with: fixed, so a session's name is
 *  the same every run (see isTitleRequest for which requests those are). */
export const TITLE_REPLY = 'Fake model session';

/** The tools a request offers, newest shape first: the model may only call
 *  one of these, and which shell/question tool exists is the agent's own
 *  business, not this server's. */
export function offeredTools(body, shape) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return tools
    .map((tool) => (shape === 'openai' ? tool?.function?.name : tool?.name))
    .filter((name) => typeof name === 'string' && name !== '');
}

/** Names that are a shell tool, in the order Claude Code, OpenCode and the
 *  DeepSeek Harness name theirs. */
const SHELL_TOOLS = ['Bash', 'bash', 'shell', 'execute', 'run_command'];
/** Names that ask the user a question. */
const QUESTION_TOOLS = ['AskUserQuestion', 'ask_user_question', 'question', 'ask_user'];
/** Names that propose a plan for approval. */
const PLAN_TOOLS = ['ExitPlanMode', 'exit_plan_mode'];
/** What each scenario's call prefers to be named — the agent's own tool for
 *  it, when the request offers one. */
const SCENARIO_TOOLS = { question: QUESTION_TOOLS, 'plan-approval': PLAN_TOOLS, tool: SHELL_TOOLS };

/**
 * The tool a scenario calls, or null when the request offers none this server
 * would name for it. `/tool` is the loose one — any tool the request offers is
 * a tool call, so its own first serves as well as its shell's. The others ask
 * for something specific, and a fallback would be a lie: a Bash call carrying
 * question arguments is a tool error, not a question form.
 */
function toolFor(offered, scenario) {
  const preferred = SCENARIO_TOOLS[scenario] ?? SHELL_TOOLS;
  const found = preferred.find((name) => offered.includes(name));
  if (found) return found;
  return scenario === 'tool' ? (offered[0] ?? null) : null;
}

/** The plan a `/plan-approval` call proposes, for the approval card. */
export const PLAN_TEXT = '1. Do the thing\n2. Check it';

/** The default command a `/tool` call runs: a write, which is the kind of
 *  call an agent's permission policy has an opinion about (`echo` alone is
 *  on Claude Code's own safe list, so it would say nothing about that
 *  path). Harmless either way — it runs in the session's own scratch
 *  directory. */
export const TOOL_COMMAND = 'echo codedeck-fake-model > codedeck-fake-model.txt';

/** The option list both question shapes accept: a label each, and a line
 *  saying what the choice does. */
const QUESTION_OPTIONS = [
  { label: 'Red', description: 'The first option' },
  { label: 'Blue', description: 'The second option' },
];

/**
 * The call that asks one question, in the shape the tool being called takes.
 * The shape is the tool's, not the agent's, and they differ: Claude Code's
 * `AskUserQuestion` takes `{question, header, options, multiSelect}`, while
 * the DeepSeek Harness's `ask_user_question` wants an `id` on each question
 * and refuses the call without one.
 */
function questionArguments(name, question) {
  if (name === 'ask_user_question') {
    return { questions: [{ id: 'q0', question, header: 'Color', options: QUESTION_OPTIONS }] };
  }
  return { questions: [{ question, header: 'Color', multiSelect: false, options: QUESTION_OPTIONS }] };
}

/** The argument object a scenario's tool call carries. The shell tool reads
 *  `command` in all three agents; a question tool reads its own shape. A
 *  `/tool <command>` names the command to run instead of the default. */
export function toolArguments(name, scenario, argument = '') {
  if (scenario === 'plan-approval') return { plan: argument || PLAN_TEXT };
  if (scenario === 'question') return questionArguments(name, argument || 'Which color?');
  return { command: argument || TOOL_COMMAND, description: `A ${name} call from the fake model` };
}

/** A 400 in each shape's error body: the shape a client already parses, so
 *  the driver's own error translation is what gets exercised. */
function errorBody(shape, message) {
  return shape === 'openai'
    ? { error: { message, type: 'invalid_request_error', code: 'fake_model_error', param: null } }
    : { type: 'error', error: { type: 'invalid_request_error', message } };
}

export const ERROR_MESSAGE = 'the fake model was asked to fail (/error)';

/**
 * Claude Code's auto-mode permission classifier: a separate request, with no
 * tools and a system prompt of its own, that judges whether the tool call
 * just made may run. It reads the transcript, not a prompt of the user's, so
 * it is recognised by its system prompt rather than by a scenario marker —
 * and it is answered, because an unanswered monitor leaves the agent unable
 * to run anything (`auto mode cannot determine the safety of …`).
 */
export function isSecurityMonitor(body) {
  return systemText(body).includes('You are a security monitor');
}

/** A request's system prompt, whichever way the shape carries it: a string,
 *  Anthropic's list of blocks, or a leading system message in the OpenAI
 *  shape. */
export function systemText(body) {
  const system = body?.system;
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map((part) => part?.text ?? '').join('\n');
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages
    .filter((message) => message?.role === 'system')
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .join('\n');
}

/** Whether the request offers the agent any tool at all. A user's turn
 *  always does; an agent's own errands — a title, a summary — do not. */
export function noTools(body) {
  return offeredTools(body, 'anthropic').length === 0 && offeredTools(body, 'openai').length === 0;
}

/**
 * Whether a request is the agent naming the session rather than a turn of the
 * user's — answered with a fixed title, since a model's reply to it is what
 * the phone shows as the session's name.
 *
 * Two signals, both verified: Claude Code wraps the conversation in
 * `<session>`, and OpenCode asks in its system prompt ("You are a title
 * generator"). OpenCode's request carries the user's prompt verbatim, so
 * without this a session started with `/question` was titled after whatever
 * the server answered that with.
 */
export function isTitleRequest(body, turn) {
  if (turn.text.startsWith('<session>')) return true;
  return noTools(body) && /title generator|naming a coding session/i.test(systemText(body));
}

/**
 * What the monitor is told, on its own scale. 1 and 2 are both accepted and
 * the tool call then runs; 3 and 8 are not — the CLI re-asks the same
 * question once and then gives up ("auto mode cannot determine the safety
 * of …"), which refuses the call. So the lowest grade is the one that keeps
 * a `/tool` deterministic, and it is what every reply here says.
 */
export const MONITOR_SEVERITY = 1;

/** The text a reply carries, and the usage it reports. */
function replyFor(body, turn) {
  if (isSecurityMonitor(body)) {
    return { text: `<severity>${MONITOR_SEVERITY}</severity>`, input: USAGE.input, output: USAGE.output };
  }
  if (turn.toolResult) {
    const first = turn.text.split('\n')[0] ?? '';
    return { text: `tool-finished: ${first.slice(0, 200)}`, input: USAGE.input, output: USAGE.output };
  }
  if (isTitleRequest(body, turn)) return { text: TITLE_REPLY, input: USAGE.input, output: USAGE.output };
  const parsed = parsePrompt(turn.text);
  if (parsed.scenario === 'long') return { text: LONG_TEXT, input: USAGE.input, output: USAGE.output };
  if (parsed.scenario && SCENARIO_TOOLS[parsed.scenario]) {
    // A request offering no tool is not the user talking: it is the agent
    // asking for something of its own while quoting the conversation back at
    // the model (a title, a summary of it), so a marker inside that quote is
    // context to echo, not a command to obey. A request WITH tools that
    // offers the wrong kind is a real mismatch, and planReply says so.
    if (noTools(body)) return { text: `echo: ${turn.own || turn.text}`, input: USAGE.input, output: USAGE.output };
    return { scenario: parsed.scenario, argument: parsed.text };
  }
  return { text: `echo: ${turn.own || turn.text}`, input: USAGE.input, output: USAGE.output };
}

// --- The two wire shapes ---

/**
 * One reply, decided before it is shaped for a wire: what to say, or which
 * tool to call, plus the ids and the usage every form of it carries.
 *
 * `seq` is the request's own number. It names the message and any tool call
 * this reply makes, and both must differ from every earlier reply's: a
 * client keys a tool result by its call id, and a repeated message id reads
 * as the same message still streaming, so it appends where it should start
 * over.
 *
 * Which tool a call names is the request's own business: the agent lists
 * what it offers, and the shell or question tool among them is picked from
 * that list, so the call is one the agent can actually run.
 */
export function planReply(body, shape, seq = 1) {
  const turn = lastTurn(body, shape);
  const reply = replyFor(body, turn);
  const ids =
    shape === 'anthropic'
      ? { messageId: `msg_fake_${seq}`, callId: `toolu_fake_${seq}` }
      : { messageId: `chatcmpl-fake-${seq}`, callId: `call_fake_${seq}` };
  const usage = { input: reply.input ?? USAGE.input, output: reply.output ?? USAGE.output };
  if (reply.text !== undefined) return { kind: 'text', text: reply.text, ...ids, ...usage };
  // A scenario that asks for a tool cannot be answered by a request that
  // offers none (Claude Code's classifier sends no tools at all), nor by one
  // whose tools are all of another kind: saying so beats calling a tool the
  // request did not offer.
  const name = toolFor(offeredTools(body, shape), reply.scenario);
  if (!name) return { kind: 'text', text: `no ${reply.scenario} tool in this request`, ...ids, ...usage };
  return { kind: 'tool', name, args: toolArguments(name, reply.scenario, reply.argument), ...ids, ...usage };
}

/** Anthropic messages, as an SSE frame list. A long reply's text streams in
 *  pieces; each frame's third element is how long to hold before the next. */
export function anthropicFrames(body, seq = 1) {
  const reply = planReply(body, 'anthropic', seq);
  const usage = (input, output) => ({
    input_tokens: input,
    cache_creation_input_tokens: USAGE.cached,
    cache_read_input_tokens: USAGE.cached,
    output_tokens: output,
  });
  const frames = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: reply.messageId,
          type: 'message',
          role: 'assistant',
          model: FAKE_MODEL_ID,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: usage(reply.input, 0),
        },
      },
    ],
  ];
  if (reply.kind === 'text') {
    frames.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }]);
    const pieces = textPieces(reply.text);
    pieces.forEach((piece, i) => {
      frames.push([
        'content_block_delta',
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } },
        i < pieces.length - 1 ? STREAM_CHUNK_DELAY_MS : 0,
      ]);
    });
    frames.push(['content_block_stop', { type: 'content_block_stop', index: 0 }]);
  } else {
    const json = JSON.stringify(reply.args);
    // Split the arguments across two deltas, as a real stream does: a client
    // that only reads the first one is a bug this makes visible.
    const cut = Math.ceil(json.length / 2);
    frames.push([
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: reply.callId, name: reply.name, input: {} } },
    ]);
    for (const part of [json.slice(0, cut), json.slice(cut)]) {
      frames.push(['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: part } }]);
    }
    frames.push(['content_block_stop', { type: 'content_block_stop', index: 0 }]);
  }
  frames.push([
    'message_delta',
    {
      type: 'message_delta',
      delta: { stop_reason: reply.kind === 'text' ? 'end_turn' : 'tool_use', stop_sequence: null },
      usage: { output_tokens: reply.output },
    },
  ]);
  frames.push(['message_stop', { type: 'message_stop' }]);
  return frames;
}

/** The same reply as one Anthropic message, for a request that did not ask
 *  to stream — SSE frames sent to a reader expecting JSON are not a reply it
 *  can read at all. */
export function anthropicMessage(body, seq = 1) {
  const reply = planReply(body, 'anthropic', seq);
  return {
    id: reply.messageId,
    type: 'message',
    role: 'assistant',
    model: FAKE_MODEL_ID,
    content:
      reply.kind === 'text'
        ? [{ type: 'text', text: reply.text }]
        : [{ type: 'tool_use', id: reply.callId, name: reply.name, input: reply.args }],
    stop_reason: reply.kind === 'text' ? 'end_turn' : 'tool_use',
    stop_sequence: null,
    usage: {
      input_tokens: reply.input,
      cache_creation_input_tokens: USAGE.cached,
      cache_read_input_tokens: USAGE.cached,
      output_tokens: reply.output,
    },
  };
}

/** OpenAI chat completions, as an SSE chunk list: each entry is a chunk and
 *  how long to hold before the next, so a long reply's text streams in
 *  pieces. */
export function openaiChunks(body, seq = 1) {
  const reply = planReply(body, 'openai', seq);
  const chunk = (delta, finish = null) => ({
    id: reply.messageId,
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: FAKE_MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const out = [[chunk({ role: 'assistant', content: '' }), 0]];
  if (reply.kind === 'text') {
    const pieces = textPieces(reply.text);
    pieces.forEach((piece, i) => {
      out.push([chunk({ content: piece }), i < pieces.length - 1 ? STREAM_CHUNK_DELAY_MS : 0]);
    });
  } else {
    out.push([
      chunk({
        tool_calls: [
          {
            index: 0,
            id: reply.callId,
            type: 'function',
            function: { name: reply.name, arguments: JSON.stringify(reply.args) },
          },
        ],
      }),
      0,
    ]);
  }
  out.push([chunk({}, reply.kind === 'text' ? 'stop' : 'tool_calls'), 0]);
  out.push([
    {
      id: reply.messageId,
      object: 'chat.completion.chunk',
      created: 1_700_000_000,
      model: FAKE_MODEL_ID,
      choices: [],
      usage: {
        prompt_tokens: reply.input,
        completion_tokens: reply.output,
        total_tokens: reply.input + reply.output,
      },
    },
    0,
  ]);
  return out;
}

/** The same reply as one OpenAI completion, for a request that did not ask
 *  to stream. */
export function openaiMessage(body, seq = 1) {
  const reply = planReply(body, 'openai', seq);
  return {
    id: reply.messageId,
    object: 'chat.completion',
    created: 1_700_000_000,
    model: FAKE_MODEL_ID,
    choices: [
      {
        index: 0,
        message:
          reply.kind === 'text'
            ? { role: 'assistant', content: reply.text }
            : {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: reply.callId,
                    type: 'function',
                    function: { name: reply.name, arguments: JSON.stringify(reply.args) },
                  },
                ],
              },
        finish_reason: reply.kind === 'text' ? 'stop' : 'tool_calls',
      },
    ],
    usage: {
      prompt_tokens: reply.input,
      completion_tokens: reply.output,
      total_tokens: reply.input + reply.output,
    },
  };
}

/** The one model list both readers accept: each entry carries the Anthropic
 *  keys (`display_name`, `type`) and the OpenAI ones, and the wrapper has
 *  both `has_more`/`first_id`/`last_id` and `object`. */
export const MODEL_LIST = {
  object: 'list',
  data: [
    {
      id: FAKE_MODEL_ID,
      object: 'model',
      type: 'model',
      display_name: FAKE_MODEL_LABEL,
      created: 1_700_000_000,
      created_at: '2023-11-14T00:00:00Z',
      owned_by: 'codedeck',
    },
  ],
  has_more: false,
  first_id: FAKE_MODEL_ID,
  last_id: FAKE_MODEL_ID,
};

/** Which shape a request is, from its path. */
export function shapeOf(url) {
  const path = (url ?? '').split('?')[0];
  if (path === '/v1/messages') return 'anthropic';
  if (path === '/v1/chat/completions') return 'openai';
  return null;
}

/** A pause between two streamed frames (see STREAM_CHUNK_DELAY_MS). */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The token count for a `POST /v1/messages/count_tokens`: the characters of
 * what is being counted over four, the crude rule of thumb.
 *
 * Claude Code asks this for each piece of its own prompt (the system
 * prompt, the tool schemas, the skills, the messages) and builds the context
 * figure the phone shows from the answers, so this is what makes that figure
 * move with the conversation — a constant here would freeze every category
 * and the `/long` text would change nothing.
 */
export function estimateTokens(body) {
  const counted = JSON.stringify({
    messages: body?.messages ?? [],
    system: body?.system ?? [],
    tools: body?.tools ?? [],
  });
  return Math.max(1, Math.ceil(counted.length / 4));
}

/**
 * Start the server. Resolves once it is listening, with the URL to point an
 * agent at, the port it took (0 means the OS chose), and a `close()` that
 * releases it — every run of a probe ends with one.
 */
export function startFakeModel(options = {}) {
  const log = options.log ?? (() => {});
  const dump = options.dump ?? null;
  if (dump) mkdirSync(dump, { recursive: true });
  let requests = 0;

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', async () => {
      const route = (req.url ?? '').split('?')[0];
      const shape = shapeOf(req.url);
      requests += 1;
      let body;
      if (raw !== '') {
        try {
          body = JSON.parse(raw);
        } catch {
          body = null;
        }
      }
      if (dump) {
        const file = path.join(dump, `${String(requests).padStart(3, '0')}${route.replace(/[^\w.-]/g, '_')}.json`);
        writeFileSync(file, JSON.stringify({ method: req.method, url: req.url, body }, null, 2));
      }
      const turn = body ? lastTurn(body, shape ?? 'anthropic') : { text: '', toolResult: false };
      const what =
        shape ?? (route === '/api/hello' ? 'hello' : route === '/v1/messages/count_tokens' ? 'count_tokens' : 'unknown');
      log(`${req.method} ${req.url} -> ${what}${shape && body ? ` prompt=${JSON.stringify(turn.text.slice(0, 120))}` : ''}`);

      // Claude Code asks this before its first message; anything that is not
      // a 2xx makes it treat the base URL as a plain endpoint instead of a
      // gateway, which is fine either way but noisier to debug.
      if (route === '/api/hello') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      if (route === '/v1/models' || route === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(MODEL_LIST));
        return;
      }
      // Claude Code's own token accounting, asked per prompt piece. Answered
      // rather than refused: refused, the CLI falls back to an estimate of
      // its own and the context figure stops following the conversation.
      if (route === '/v1/messages/count_tokens') {
        const tokens = estimateTokens(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: tokens }));
        log(`-> count_tokens ${tokens}`);
        return;
      }
      if (shape === null || req.method !== 'POST') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify(errorBody('anthropic', `the fake model serves /v1/messages and /v1/chat/completions, not ${req.method} ${route}`)));
        return;
      }

      // Guarded exactly as `replyFor` is, and for the same reason: a request
      // an agent makes for its own purposes is not the user's turn, however
      // the conversation quoted inside it reads. A Claude Code session-title
      // request wraps the first prompt in `<session>` — a session whose first
      // prompt was `/error` would otherwise get a 400 for the TITLE and never
      // a title at all — and the safety classifier quotes the same prompts.
      if (
        body &&
        !turn.toolResult &&
        !isSecurityMonitor(body) &&
        !isTitleRequest(body, turn) &&
        parsePrompt(turn.text).scenario === 'error'
      ) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify(errorBody(shape, ERROR_MESSAGE)));
        log(`-> 400 ${ERROR_MESSAGE}`);
        return;
      }

      // Streaming only when the request asked for it. Claude Code's own
      // safety classifier asks without `stream`, and SSE frames sent to a
      // reader waiting for one JSON body are not a reply it can read: the
      // agent then treats the model as unavailable and refuses the call.
      const stream = body?.stream === true;
      const seq = requests;
      res.writeHead(200, {
        'content-type': stream ? 'text/event-stream' : 'application/json',
        ...(stream ? { 'cache-control': 'no-cache', connection: 'keep-alive' } : {}),
      });
      if (shape === 'anthropic') {
        if (stream) {
          for (const [event, data, delay = 0] of anthropicFrames(body, seq)) {
            if (res.destroyed) return;
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            if (delay) await sleep(delay);
          }
        } else {
          res.write(JSON.stringify(anthropicMessage(body, seq)));
        }
      } else if (stream) {
        for (const [chunk, delay = 0] of openaiChunks(body, seq)) {
          if (res.destroyed) return;
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          if (delay) await sleep(delay);
        }
        res.write('data: [DONE]\n\n');
      } else {
        res.write(JSON.stringify(openaiMessage(body, seq)));
      }
      res.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      const address = server.address();
      const host = typeof address === 'object' && address ? address.address : '127.0.0.1';
      const port = typeof address === 'object' && address ? address.port : 0;
      const url = `http://${host === '::' ? '127.0.0.1' : host}:${port}`;
      log(`fake model listening on ${url} (model ${FAKE_MODEL_ID})`);
      resolve({
        url,
        port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

/** `node fake-model.mjs …` — the standalone form, for poking at by hand. */
function main() {
  const value = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
  };
  const log = (line) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`);
  startFakeModel({
    port: Number(value('port', 0)),
    host: value('host', '127.0.0.1'),
    dump: value('dump', null),
    log,
  }).then((model) => {
    log('Ctrl-C to stop');
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => {
        void model.close().then(() => process.exit(0));
      });
    }
  }, (err) => {
    process.stderr.write(`fake-model: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main();
