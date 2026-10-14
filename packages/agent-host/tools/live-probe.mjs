/**
 * A driver-protocol client that runs ONE real session and prints everything
 * the host reports — what `./codedeck live` runs.
 *
 * It speaks to the built agent host over stdio exactly as the bridge does
 * (`{v, id, kind, payload}` lines, `initialize` first), so what it prints is
 * what the phone would be shown: transcript entries, turn states, context
 * figures, errors. Asking an agent a question in a real session is otherwise
 * a throwaway harness per session — this is that harness, kept in the tree.
 *
 * Usage (normally through ./codedeck live, which sets the environment):
 *   node tools/live-probe.mjs --host dist/main.js --agent opencode \
 *     [--prompt TEXT]… [--mode MODE] [--model ID] [--effort ID] [--cwd DIR] \
 *     [--timeout SECONDS] [--log PATH] [--fake-model]
 *
 * Every frame is echoed as one line (JSON for anything it does not render),
 * so the output is greppable and a tail of --log shows the same thing live.
 * Exit code: 0 when every turn finished without an error, 1 otherwise.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { FAKE_MODEL_ID, startFakeModel } from './fake-model.mjs';

const PROTOCOL_VERSION = 1;

/** The key the agent is handed for the local server. Any non-empty string
 *  will do — nothing authenticates here — and a dummy keeps an operator's
 *  own credential out of the request the server logs. */
const FAKE_MODEL_KEY = 'codedeck-fake-model';

/** The provider profile the local server is reached as. The id is the same
 *  for every agent; OpenCode is the one that spells its models
 *  `<provider>/<model>`. */
const FAKE_MODEL_PROVIDER = 'codedeck-fake';
const FAKE_MODEL_LABEL = 'Fake model';

/** Flags that stand alone, with no value after them. */
const FLAGS = new Set(['models', 'fake-model']);

/**
 * What makes one session run the local model server, or null for an agent
 * this does not know how to point at it.
 *
 * An endpoint that is not the agent's own is a provider profile in this
 * product — the phone adds one, the bridge hands it to the agent — so that
 * is what a fake run is bound to, rather than a stray environment variable.
 * It is also what makes the model name the local one: a profile's models are
 * what a session may name, so the session asks for `fake-model-1` and every
 * banner an agent prints names that, instead of the real model the agent
 * would otherwise default to.
 *
 * OpenCode is the exception twice over: it refuses a session-bound provider
 * ("a session is not bound to one") and takes its providers from the config
 * of the server it starts, handed over in its environment — so there the
 * profile is a config entry, and the model is `codedeck-fake/fake-model-1`.
 * Its config is the operator's own with this provider added beside it, the
 * same placement the driver gives a profile.
 */
function fakeModelSession(agent, url) {
  const provider = {
    id: FAKE_MODEL_PROVIDER,
    label: FAKE_MODEL_LABEL,
    baseUrl: url,
    authToken: FAKE_MODEL_KEY,
    models: [{ id: FAKE_MODEL_ID, label: FAKE_MODEL_LABEL }],
    defaultModel: FAKE_MODEL_ID,
  };
  switch (agent) {
    case 'claude-code':
      return { provider, model: FAKE_MODEL_ID };
    case 'deepseek-harness':
      // Bound, so its endpoint is the stub, but no model named: the harness
      // answers an id it does not know with an error entry ("unknown model
      // option"), and a profile's model list does not teach it one. The
      // session therefore keeps its own default name while every request
      // still goes to the stub — nothing is spent on that name.
      return { provider };
    case 'opencode': {
      // `aisdk:@ai-sdk/openai-compatible` is the package the driver uses for
      // an endpoint OpenCode's own catalog does not know.
      let base = {};
      try {
        const parsed = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed;
      } catch {
        base = {};
      }
      process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        ...base,
        providers: {
          ...(base.providers ?? {}),
          [FAKE_MODEL_PROVIDER]: {
            package: 'aisdk:@ai-sdk/openai-compatible',
            name: FAKE_MODEL_LABEL,
            settings: { baseURL: `${url}/v1`, apiKey: FAKE_MODEL_KEY },
            // The declared window matters: OpenCode compacts a conversation
            // that outgrows what its model claims, and a model with no limit
            // of its own would send `/long` straight into a compaction.
            models: { [FAKE_MODEL_ID]: { name: FAKE_MODEL_LABEL, limit: { context: 200_000, output: 8_192 } } },
          },
        },
      });
      return { model: `${FAKE_MODEL_PROVIDER}/${FAKE_MODEL_ID}` };
    }
    default:
      return null;
  }
}

/** `--flag value` and repeated `--prompt`: the whole surface, parsed here so
 *  the shell has nothing to quote. */
function parseArgs(argv) {
  const args = { prompts: [], timeout: 300 };
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if (!name.startsWith('--')) throw new Error(`unexpected argument: ${name}`);
    const key = name.slice(2);
    if (FLAGS.has(key)) {
      args[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
    i += 1;
    if (key === 'prompt') args.prompts.push(value);
    else if (key === 'timeout') args.timeout = Number(value);
    else args[key] = value;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.host) throw new Error('--host is required');
  if (!args.agent) throw new Error('--agent is required');
  const prompts = args.prompts.length > 0 ? args.prompts : ['Reply with exactly: codedeck-live-ok'];
  const cwd = args.cwd ?? process.cwd();
  /** How long a single request to the host may go unanswered. Generous — a
   *  turn is not a request/reply pair — but not unbounded. */
  const requestTimeout = Math.max(args.timeout, 30) * 1000;

  const logPath = args.log ?? '/tmp/codedeck-live.log';
  mkdirSync(path.dirname(logPath), { recursive: true });
  writeFileSync(logPath, '');

  /** One line, to stdout and to the log — the log is what a watcher tails
   *  while the session runs, since a probe can take minutes. */
  const say = (line) => {
    const stamped = `${new Date().toISOString().slice(11, 19)} ${line}`;
    process.stdout.write(`${stamped}\n`);
    appendFileSync(logPath, `${stamped}\n`);
  };
  say(`probe: agent=${args.agent} mode=${args.mode ?? '(default)'} model=${args.model ?? '(agent default)'}`);
  say(`probe: cwd=${cwd} log=${logPath}`);

  // The local model server, started before anything spawns: it is what the
  // session is pointed at, and `--fake-model` is therefore not only what
  // starts it but what decides the session's model — an agent that names no
  // model of its own would run a real one, on a real account.
  let fakeModel = null;
  let fakeSession = null;
  if (args['fake-model'] && args.agent === 'fake') {
    // Nothing to point and no model to name: the fake agent answers from the
    // prompt itself, and a server behind it would be decoration.
    say('model: the fake agent runs no model, so --fake-model has nothing to do (it is for claude-code, opencode and deepseek-harness)');
  } else if (args['fake-model']) {
    fakeModel = await startFakeModel({ log: (line) => say(`model: ${line}`), dump: args.dump ?? null });
    fakeSession = fakeModelSession(args.agent, fakeModel.url);
    if (!fakeSession) say(`!! --fake-model does not know how to point '${args.agent}' at a local endpoint`);
    else {
      // For the record, because an agent's banner names the model it asks
      // for and a real model name there reads like a bill: the model is the
      // local one in any case, and nothing leaves this machine.
      say(`model: ${args.agent} runs ${fakeSession.model} at ${fakeModel.url} — no account is reached`);
    }
  }
  if (args.dump && !args['fake-model']) {
    // The requests are written by the fake model server, so there is nothing
    // to write without it; said out loud because the run would otherwise
    // look like it dumped something.
    say('!! --dump writes nothing without --fake-model: it is the fake model that records what the agent sent');
  }
  const model = args.model ?? fakeSession?.model ?? undefined;

  const host = spawn(process.execPath, [args.host], { stdio: ['pipe', 'pipe', 'pipe'] });
  let nextId = 0;
  const pending = new Map();
  const waits = [];
  let failed = false;

  const send = (kind, payload) => {
    const id = `p${(nextId += 1)}`;
    host.stdin.write(`${JSON.stringify({ v: PROTOCOL_VERSION, id, kind, payload })}\n`);
    return new Promise((resolve, reject) => {
      // Every request has a deadline of its own: a host that takes the frame
      // and never answers would otherwise leave the probe waiting with no
      // output at all, which reads exactly like an agent thinking.
      const timer = setTimeout(() => {
        pending.delete(id);
        say(`!! ${kind}: no reply within ${Math.round(requestTimeout / 1000)}s`);
        failed = true;
        reject(new Error(`${kind} was not answered`));
      }, requestTimeout);
      timer.unref?.();
      pending.set(id, {
        kind,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
    });
  };
  const reply = (id, kind, payload) => {
    host.stdin.write(`${JSON.stringify({ v: PROTOCOL_VERSION, id, kind, payload })}\n`);
  };

  /** Resolves on the first session event matching `match`; rejects on the
   *  probe's deadline, which is what keeps a stuck agent from eating a
   *  session. */
  const waitFor = (what, match) =>
    new Promise((resolve, reject) => {
      const entry = { what, match, resolve, reject };
      waits.push(entry);
      deadline.arm(entry);
    });

  const deadline = {
    entries: new Set(),
    timeout: (args.timeout + 30) * 1000,
    arm(entry) {
      entry.timer = setTimeout(() => {
        this.entries.delete(entry);
        waits.splice(waits.indexOf(entry), 1);
        entry.reject(new Error(`timed out waiting for ${entry.what}`));
      }, this.timeout);
      this.entries.add(entry);
    },
    clear(entry) {
      clearTimeout(entry.timer);
      this.entries.delete(entry);
    },
  };

  // A UUID, because a driver may hand the id to its agent (Claude Code takes
  // it as `--session-id`, which the CLI rejects unless it is one) and because
  // it is what the bridge sends: bridge-runtime's own ids are v4 UUIDs.
  const sessionId = randomUUID();
  /** Set once the probe is done with the host, so the SIGTERM it sends to
   *  stop it is not read back as the host dying on its own. */
  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    for (const entry of deadline.entries) clearTimeout(entry.timer);
    host.kill('SIGTERM');
    setTimeout(() => host.kill('SIGKILL'), 3000).unref?.();
    // The model server holds the loop open; a probe that finished must let
    // the process end without waiting on it.
    void fakeModel?.close();
    process.exitCode = code;
  };

  host.on('error', (err) => {
    say(`probe: could not start the host: ${err.message}`);
    finish(1);
  });

  // A driver protocol frame per line. Anything this probe was waiting for is
  // handed to the waiter; everything else is rendered and printed.
  let buffer = '';
  host.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim() === '') continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        say(`host (not JSON): ${line}`);
        continue;
      }
      handleFrame(frame);
    }
  });
  // The host logs to stderr; it is where an install or a driver failure says
  // why, so it is shown as it comes.
  host.stderr.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim() !== '') say(`host: ${line}`);
    }
  });
  host.on('exit', (code) => {
    if (finished) return;
    say(`probe: the host exited on its own (${code ?? 'killed by a signal'})`);
    finish(code === 0 && !failed ? 0 : 1);
  });

  function settled(id) {
    const entry = pending.get(id);
    if (entry) pending.delete(id);
    return entry;
  }

  function handleFrame(frame) {
    const { id, kind, payload } = frame;
    if (id && pending.has(id)) {
      const entry = settled(id);
      if (kind === 'error') {
        failed = true;
        say(`!! ${entry.kind}: ${payload?.message ?? 'error'}`);
      }
      entry.resolve(payload ?? {});
      return;
    }
    if (kind === 'error') {
      failed = true;
      say(`!! error: ${payload?.message ?? 'unknown'}`);
      return;
    }
    if (kind === 'session-event') {
      handleEvent(payload.event);
      return;
    }
    if (kind === 'agent-changed') {
      say(`agent-changed: ${payload.agent.id} ${payload.agent.install?.state ?? 'ready'}`);
      notify({ kind: 'agent-changed', agent: payload.agent });
      return;
    }
    if (kind === 'request-permission') {
      // Answered the way the auto-approve mode does: the first allow, or the
      // first option when the agent offers nothing else.
      const options = payload.options ?? [];
      const chosen = options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind === 'allow_always') ?? options[0];
      say(`permission: ${payload.title}${payload.description ? ` — ${payload.description}` : ''} -> ${chosen?.label ?? 'cancel'}`);
      reply(id, 'permission-outcome', chosen ? { outcome: 'selected', optionId: chosen.id } : { outcome: 'cancelled', reason: 'no options' });
      return;
    }
    if (kind === 'ask-question') {
      // Answered with the first option of each question, which is what a user
      // tapping the card's first choice would send.
      const questions = payload.questions ?? [];
      const answers = questions.map((q) => {
        const first = q.options?.[0];
        return first ? { type: 'selected', labels: [first.label] } : { type: 'text', text: '' };
      });
      say(`question: ${questions.map((q) => q.question).join(' | ')} -> ${JSON.stringify(answers)}`);
      reply(id, 'question-outcome', { outcome: 'answered', answers });
      return;
    }
    if (kind === 'request-plan-approval') {
      say(`plan approval requested: ${JSON.stringify(payload.options ?? [])}`);
      reply(id, 'plan-outcome', { outcome: 'cancelled', reason: 'the probe approves no plan' });
      return;
    }
    say(`frame: ${JSON.stringify(frame)}`);
  }

  function handleEvent(event) {
    switch (event.type) {
      case 'ready':
        say('ready');
        break;
      case 'info': {
        const parts = [];
        if (event.model) parts.push(`model=${event.model}`);
        if (event.mode) parts.push(`mode=${event.mode}`);
        if (event.title) parts.push(`title=${JSON.stringify(event.title)}`);
        if (event.contextWindow != null) parts.push(`window=${event.contextWindow}`);
        if (event.contextPercentage != null) parts.push(`context=${event.contextPercentage}%`);
        if (event.nativeSessionId) parts.push(`native=${event.nativeSessionId}`);
        say(`info: ${parts.join(' ')}`);
        break;
      }
      case 'entries':
        for (const entry of event.entries) say(`entry: ${render(entry)}`);
        break;
      case 'partial':
        // Live reply text: the key it streams under and the slice it carries
        // (offset in, length added) — chained offsets are what the phone's
        // live row grows by.
        say(`partial: ${event.key} ${event.entryType} offset=${event.offset} +${String(event.text).length}`);
        break;
      case 'turn':
        say(`turn: ${event.state}`);
        break;
      case 'ended':
        say(`ended${event.error ? `: ${event.error}` : ''}`);
        if (event.error) failed = true;
        break;
      default:
        say(`event: ${JSON.stringify(event)}`);
    }
    notify(event);
  }

  function notify(value) {
    for (const entry of [...waits]) {
      if (!entry.match(value)) continue;
      waits.splice(waits.indexOf(entry), 1);
      deadline.clear(entry);
      entry.resolve(value);
    }
  }

  /** A transcript entry as one readable line: what the phone shows, without
   *  the payloads a reader does not need. */
  function render(entry) {
    const sub = entry.subagent ? `[sub-agent ${entry.subagent.label ?? entry.subagent.parentCallId}] ` : '';
    const cut = (text, n = 160) => {
      const one = String(text ?? '').replace(/\s+/g, ' ').trim();
      return one.length > n ? `${one.slice(0, n)}…` : one;
    };
    const body = (() => {
      switch (entry.entryType) {
        case 'text':
          // The part names the live row this entry replaces, when it streamed.
          return `${entry.role}: ${cut(entry.text, 400)}${entry.part ? ` [part ${entry.part}]` : ''}`;
        case 'thinking':
          return `thinking: ${cut(entry.text)}`;
        case 'status':
          return `status: ${cut(entry.text)}`;
        case 'error':
          return `error: ${cut(entry.text, 400)}`;
        case 'notice':
          return `notice(${entry.kind}): ${cut(entry.text)}`;
        case 'tool_call':
          // The title is what the phone shows as the call's one-line summary
          // (a Bash call's command, a read's path); the input is the longer
          // text beside it, and only some calls carry one.
          return `tool_call ${entry.toolName}${entry.title ? ` ${cut(entry.title)}` : ''}${entry.input ? ` ${cut(JSON.stringify(entry.input))}` : ''}`;
        case 'tool_result':
          return `tool_result${entry.isError ? ' (failed)' : ''}: ${cut(entry.text)}`;
        case 'diff':
          return `diff ${entry.path} (${entry.lines?.length ?? 0} lines)`;
        case 'turn_complete':
          return 'turn_complete';
        case 'permission_request':
          return `permission_request ${entry.toolName}: ${cut(entry.title)}`;
        case 'question':
          return `question: ${cut(entry.question)}`;
        case 'plan_approval':
          return `plan_approval: ${cut(entry.text)}`;
        default:
          return `${entry.entryType}: ${cut(JSON.stringify(entry))}`;
      }
    })();
    return `${sub}${body}`;
  }

  (async () => {
    const initialized = await send('initialize', { bridgeVersion: 'live-probe' });
    const agents = initialized.agents ?? [];
    say(`host ${initialized.hostVersion}: ${agents.map((a) => `${a.id}(${a.install?.state ?? 'ready'})`).join(' ')}`);

    let agent = agents.find((a) => a.id === args.agent);
    if (!agent) {
      say(`!! this host does not know agent '${args.agent}' — is it in CODEDECK_AGENT_HOST_DRIVERS?`);
      failed = true;
      return finish(1);
    }
    if (agent.install?.state !== 'ready') {
      say(`installing ${agent.id} at the version this build pins (once; it stays in the cache)`);
      // The host announces an install the moment it starts and again when it
      // lands, so the wait is for the landing — ready or failed — and not for
      // the first thing it says about the agent.
      const installing = waitFor(
        `${agent.id} to be installed`,
        (value) =>
          value.kind === 'agent-changed' &&
          value.agent.id === args.agent &&
          (value.agent.install?.state === 'ready' || value.agent.install?.state === 'failed'),
      );
      await send('install-agent', { agent: args.agent });
      agent = (await installing).agent;
      if (agent.install?.state !== 'ready') {
        say(`!! ${agent.id} is not ready: ${agent.install?.state} ${agent.install?.reason ?? ''}`);
        failed = true;
        return finish(1);
      }
    }
    say(`modes: ${(agent.modes ?? []).map((m) => m.id).join(', ') || '(none)'}`);

    // What the agent offers, and which of it a session with no `--model` runs.
    // Free of charge: this asks the host, and starts nothing.
    const listed = await send('list-models', { agent: args.agent });
    if (args.models) {
      for (const model of listed.models ?? []) say(`model: ${model.id}${model.label ? ` — ${model.label}` : ''}`);
      say(`default: ${listed.defaultModel ?? '(the agent picks its own)'}`);
      await send('end-session', { sessionId });
      return finish(0);
    }
    if (!model && listed.defaultModel) {
      say(`note: no --model given, so this runs the agent's default: ${listed.defaultModel}`);
    }
    if (model && !args.model) say(`model: the session runs ${model} (the fake model's own)`);

    await send('start-session', {
      sessionId,
      agent: args.agent,
      cwd,
      ...(args.mode ? { mode: args.mode } : {}),
      ...(model ? { model } : {}),
      ...(args.effort ? { effort: args.effort } : {}),
      ...(fakeSession?.provider ? { provider: fakeSession.provider } : {}),
    });
    await waitFor('the session to be ready', (value) => value.type === 'ready');

    for (const prompt of prompts) {
      say(`> ${prompt}`);
      const done = waitFor('the turn to end', (value) => value.type === 'turn' && value.state === 'idle');
      await send('prompt', { sessionId, text: prompt });
      await done;
    }

    const usage = await send('get-usage', { sessionId });
    if (usage.usage?.context) {
      const c = usage.usage.context;
      say(`context: ${c.usedTokens} of ${c.windowTokens} tokens — ${(c.categories ?? []).map((x) => `${x.name} ${x.tokens}`).join(', ')}`);
    } else {
      say('context: the agent reported none');
    }
    if (usage.usage?.sessionCostUsd !== undefined) say(`cost: $${usage.usage.sessionCostUsd}`);

    await send('end-session', { sessionId });
    finish(failed ? 1 : 0);
  })().catch((err) => {
    say(`!! probe failed: ${err?.message ?? err}`);
    finish(1);
  });
}

main().catch((err) => {
  process.stderr.write(`live-probe: ${err?.message ?? err}\n`);
  process.exit(2);
});
