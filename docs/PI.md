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
  providers): any OpenAI-compatible endpoint. A session bound to one runs on
  it, and its models are the ones the picker offers.
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
on. CodeDeck installs an extension into every session —
`<home>/codedeck/codedeck-pi.js`, rewritten when the bridge's version of it
changes and loaded with `-e` — that holds each tool call until the phone
answers:

- **Ask** (the default): a card for every tool call, except Pi's read-only
  tools (`read`, `grep`, `find`, `ls`), which run without one. The card
  offers Allow, Allow `<tool>` for this session, and Deny; a denied call
  never runs, and Pi tells the model it was denied. A tool that another
  extension or an MCP server adds asks like any other.
- **Auto edit**: Pi's own file tools (`edit`, `write`) also run without a
  card; a command, and any tool an extension or an MCP server adds, still
  asks.
- **YOLO**: every tool call runs without a card.

What "for this session" allows is kept by the session only: Pi saves no
rules, so the next session asks again.

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
a URL) or a path, and is how Pi gains tools it does not ship — subagents,
LSP diagnostics and the like come from packages rather than from CodeDeck.
A package runs code with the bridge's permissions: install only ones you
trust. An npm package needs `npm` on the machine (the container image has
it, a release archive does not); `CODEDECK_NPM_REGISTRY` is passed on to it.
Packages cannot be switched off, only removed; sessions started after a
change load it.

## What this does not have

- **No question or plan tool**: Pi has neither, so the session shows no
  question forms or plan cards of its own.
- **No subscription usage** to ask for (the context meter still works), no
  background tasks and no saved permission rules.
- **Accounts need Pi's package**: with `CODEDECK_PI_PATH` naming an
  executable rather than a `cli.js`, they cannot be listed or changed.

## Offline and container notes

Like the DeepSeek Harness it is a package tree in the `agents` volume. A host
without npm registry access installs it from a copied `agents/` directory,
points `CODEDECK_NPM_REGISTRY` at a mirror, or points `CODEDECK_PI_PATH` at
its own.
