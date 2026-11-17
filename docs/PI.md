# Pi backend

[Pi](https://github.com/earendil-works/pi) runs over its RPC mode
(`pi --mode rpc`: JSON lines on stdio), one Pi process per session. The
driver is `packages/agent-host/src/drivers/pi/`.

## Getting it running

Nothing to install by hand: `@earendil-works/pi-coding-agent` is installed on
demand at the version and sha512 `pnpm-lock.yaml` pins, into `<home>/agents/`
— Install on the phone, or `codedeck-bridge agents install pi`. It is a
pure-JS package tree, like the DeepSeek Harness's. `CODEDECK_PI_PATH` names a
CLI of your own to use instead (its `cli.js`, run with the bridge's Node, or
an executable).

A session needs a model Pi can reach, any of:

- **An account** connected on the phone (the agent's page → Accounts): an
  API key for any of Pi's providers, or a sign-in to a subscription where
  Pi has one (Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot, xAI and
  others). Pi's own code stores it, in its home (below), exactly where its
  `/login` would. The model picker then lists that provider's models.
- **A provider profile** added on the phone (the agent's page → AI
  providers): any OpenAI-compatible endpoint — a provider's own API or a
  gateway in front of several (claude-code-router, LiteLLM). A session bound
  to one runs on it, and its models are the ones the picker offers. A
  profile's model list rarely says how large a model's context is or
  whether it reasons, so each model borrows those facts from Pi's own
  catalog: matched on the part of its id after the last `/` (a gateway's
  `OpenCode Go/deepseek-v4.1-flash` is Pi's `deepseek-v4.1-flash`), from the
  provider the route names when Pi has it, else the entry with the smallest
  context. That sets the context meter, when Pi compacts, the reasoning
  levels and the longest answer. A size the endpoint states wins; a model Pi
  does not know runs at 128k context without reasoning.
- **The bridge's environment**: the keys Pi reads itself, such as
  `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY`. Accounts shows them as the
  machine's, which only the machine can change.

## Accounts

The list is Pi's own: every provider the installed Pi knows, with a key
form where Pi takes a key and a sign-in where it has one. A key is checked
by Pi only when a session uses it.

A sign-in gives a page to open on any device. Some providers then show a
code to enter there and finish on their own; the others send the browser
back to an address on the bridge's machine, which a phone cannot open: paste
the address it fails to load, and Pi finishes the sign-in with it. A
provider whose login asks something more than a key or a sign-in (a
resource name, a region) is refused with Pi's question — run Pi's own
`/login` on the machine for it.

## Its own home

Pi's settings, credentials, models and conversations live in the directory
the driver points `PI_CODING_AGENT_DIR` at: `CODEDECK_PI_HOME`, else a `pi`
directory beside the agent cache. Pi in a terminal shares all of it when
pointed there (`PI_CODING_AGENT_DIR=<that directory>`): accounts, MCP
servers and packages added either way are there for both. Conversations are files under its `sessions/`, which is what a session
resumes from after a restart and what deleting a conversation removes.

A profile's token never touches a file: the driver hands the session's
process the profile in one environment variable and the token in another,
which the registration names (`$CODEDECK_PI_PROVIDER_TOKEN`), so Pi reads
the token from its own environment.

Pi runs with `--offline`, version checks and telemetry off: it makes no
network request of its own beyond the model's. Its model catalog is therefore
the one its release shipped with, plus your own `models.json`.

## Permissions

Pi has no permission system of its own: it runs every tool call it decides
on. CodeDeck installs an extension into every session — the CodeDeck Pi
extension, `<home>/codedeck/codedeck-pi.js`, rewritten when the bridge's
version of it changes and loaded with `-e` — that holds each tool call until
the phone answers:

- **Ask** (the default): a card for every tool call, except Pi's read-only
  tools (`read`, `grep`, `find`, `ls`) and the extension's own tools that
  change nothing (below), which run without one. The card offers Allow,
  Allow `<tool>` for this session, and Deny; a denied call never runs, and
  Pi tells the model it was denied. A tool that another extension or an MCP
  server adds asks like any other.
- **Auto edit**: Pi's own file tools (`edit`, `write`) also run without a
  card; a command, a web fetch, and any tool an extension or an MCP server
  adds, still asks.
- **Plan**: the session explores and changes nothing. Read-only tools and
  read-only shell commands (`git status`, `git diff`, `cat`, `grep`… without
  their writing options, no redirection) run; anything else is refused, and
  the model is told to present its plan instead. The plan arrives as a plan
  card: approve it to switch the session to Ask or Auto edit, or send it
  back with what to change.
- **YOLO**: every tool call runs without a card.

What "for this session" allows is kept by the session only: Pi saves no
rules, so the next session asks again.

## Tools

Pi ships `read`, `bash`, `edit` and `write` on by default. A session also
turns on its `ls`, and its `grep` and `find` where ripgrep and fd are on the
machine (the container image has both; Pi runs offline, so it never
downloads them). The CodeDeck Pi extension adds what a session driven from a
phone needs, shown with the same cards as the other agents:

- **`todo`**: the model's checklist, shown as the session's checklist.
- **`ask`**: up to four questions with options, shown as a question card.
- **`exit_plan`**: the plan card of Plan mode.
- **`task`**: a sub-agent — a second Pi with a fresh context — for one job,
  answering with its conclusion; several run in parallel. `explore` has the
  read-only tools only, so it changes nothing and never asks; `general` has
  the session's tools, and each of its tool calls asks exactly as the
  session's own would, on a card that names the sub-agent. Its work shows
  under its call.
- **`bash_background`**, **`task_output`**, **`task_stop`**: a command that
  keeps running after its call (a dev server, a watcher), whose output the
  model reads later. Each is a background task the phone can stop; whatever
  still runs when the session's Pi exits is stopped with it.
- **`web_fetch`**: one web page read as text, asking first every time. It
  sends no cookies or credentials, follows at most five redirects and
  never into a local or private address the first URL did not name, reads
  text only, and tells the model the page is data, not instructions.
- **`memory`**: notes about the project that later sessions start with —
  one file per note and an index the system prompt carries, in Pi's home
  under `codedeck/memory/<project>/`, never in the working tree. Each save
  shows on the phone as a `memory` call; a note that looks like it holds a
  secret is refused.

The checklist, questions, sub-agents and background shells need no card of
their own beyond what they start.

## Reasoning and messages

Reasoning is Pi's thinking level: Off, Minimal, Low, Medium (Pi's default),
High, Extra high, Max. A model without one of them runs at the nearest it
has, as in Pi's own terminal UI.

A message sent while a turn runs is steered into that turn: Pi hands it to
the model after the tool calls in flight, before its next request. Stop
aborts the turn and answers any card still open as cancelled.

When a request fails and Pi retries it, the session shows one line per
retry instead of an error; only an error Pi gives up on, or one it does not
retry, is shown as an error.

Dialogs that your own Pi extensions open (`select`, `confirm`, `input`,
`editor`) reach the phone as question cards; their notifications show as a
status line in the session.

## MCP servers

The MCP screen manages the `mcpServers` of `mcp.json` in Pi's home, the file
`pi mcp add` and `/mcp` edit. Stdio and streamable HTTP servers only: Pi
rejects the legacy SSE transport, and server names other than letters,
digits, `_` and `-`. Switching one off keeps it with Pi's own
`enabled: false`. A Pi process connects its servers as its session starts:
a change applies to the sessions started after it, and a session's MCP
panel shows a server changed since as not loaded yet. Env and header values
are kept in the file, which is written readable by its owner only on Linux
and macOS.

## Packages

The Plugins screen manages Pi's packages, through Pi's own `pi install`,
`pi update` and `pi remove`. A package bundles extensions, skills, prompt
templates and themes from npm (`npm:<package>`), git (`git:github.com/…` or
a URL) or a path, and is how Pi gains tools neither it nor CodeDeck ships,
such as LSP diagnostics.
A package runs code with the bridge's permissions: install only ones you
trust. An npm package needs `npm` on the machine (the container image has
it, a release archive does not); `CODEDECK_NPM_REGISTRY` is passed on to it.
Packages cannot be switched off, only removed; sessions started after a
change load it.

## What this does not have

- **No subscription usage** to ask for (the context meter still works) and
  no saved permission rules.
- **No LSP diagnostics** of CodeDeck's own: a Pi package can add them.
- **Accounts need Pi's package**: with `CODEDECK_PI_PATH` naming an
  executable rather than a `cli.js`, they cannot be listed or changed.

## Offline and container notes

Like the DeepSeek Harness it is a package tree in the `agents` volume. A host
without npm registry access installs it from a copied `agents/` directory,
points `CODEDECK_NPM_REGISTRY` at a mirror, or points `CODEDECK_PI_PATH` at
its own.
