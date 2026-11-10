# Qwen Code backend

[Qwen Code](https://github.com/QwenLM/qwen-code) runs over its ACP profile
(`qwen --acp`), on the agent host's generic ACP base (`src/acp/`) like the
DeepSeek Harness. The driver is `packages/agent-host/src/drivers/qwen/`.

## Getting it running

Nothing to install by hand: `@qwen-code/qwen-code` is installed on demand at
the version and sha512 `pnpm-lock.yaml` pins, into `<home>/agents/` — Install
on the phone, or `codedeck-bridge agents install qwen-code`.
`CODEDECK_QWEN_PATH` names a CLI of your own to use instead.

Qwen Code has no provider API of its own: it runs on OpenAI-compatible
providers. Add one on the phone (the agent's page → AI providers); each
profile's models appear in the model picker. A session with no profile has
no model to run on.

## Its own home

Its settings and conversations live in `$QWEN_HOME`: `CODEDECK_QWEN_HOME`,
else a `qwen` directory beside the agent cache. The driver writes only what
it owns into `settings.json` — its providers, the selected auth type, the
default model, and self-update and the usage ping turned off — and keeps
everything else, your own `openai` providers included. A profile's token
never touches the file (anything on the machine can read it): the file names
an environment variable, `CODEDECK_QWEN_KEY_<hash>`, that only the session's
own process carries.

Qwen Code keeps its own memory of your conversations, as it does in a
terminal: after each turn it sends the provider one more request to pick
out what is worth remembering, so a turn costs that request too. Set
`memory.enableManagedAutoMemory` to `false` in that `settings.json` to turn
it off; the driver leaves the setting alone.

## Modes and reasoning

Qwen Code's own approval modes: Ask (`default`), Auto edit, Plan, Auto (an
LLM classifier approves what it judges safe) and YOLO. Reasoning: Off, Low,
Medium, High, Extra high, Max.

## MCP servers

The MCP screen manages the `mcpServers` of that same `settings.json`, so a
server added from the phone is also there for `qwen` in a terminal, and the
servers you added there show up on the phone. Switching one off adds it to
`mcp.excluded` (what Qwen Code's own disable does) rather than removing it.
A Qwen Code process loads its servers as it starts: a change applies to the
sessions started after it, while a running session keeps the set it began
with. A server's env and header values are stored in the file, as every
agent stores them in its own configuration; on Linux and macOS the driver
writes the file readable by its owner only (Windows keeps the folder's own
permissions). A session's MCP panel shows a server added after its process
started as pending: the next session loads it.

## Extensions

The Plugins screen manages Qwen Code's extensions, the ones under
`$QWEN_HOME/extensions` that `qwen` in a terminal sees too. Changes go through
Qwen Code's own `qwen extensions` commands; the list is read from the
directory, since the CLI prints its list as text only.

- **Install** takes what `qwen extensions install` takes: a Git URL, a local
  path or archive, or an npm package. The phone's install button is the
  consent the CLI would otherwise ask for in a terminal.
- **Switching one off** turns it off in every workspace on the machine. Qwen
  Code's own `disable` only covers workspaces under your home directory (it
  writes the rule `!$HOME/*`), which would leave it loading in the image's
  `/data/workspaces`; the phone writes `!/*` instead (on Windows, the root of
  the drive `$QWEN_HOME` is on, such as `!/C:/*`, so a workspace on another
  drive is not covered). A narrower rule you set
  in a terminal (`--scope workspace`) still applies, but the phone's switch
  shows only the machine-wide one.
- **Update** runs `qwen extensions update <name>`, and the row shows what it
  says (for example that it is already up to date).
- A Qwen Code process loads its extensions as it starts, the same way it loads
  MCP servers: a change applies to sessions started after it.
- The MCP servers an extension brings run in its sessions but are not on the
  MCP screen, which shows the servers of `settings.json`.

Qwen Code's marketplace `sources` (Claude-format marketplaces) are not on the
phone: the CLI has no way to list what a source offers.

## Background shells

When Qwen Code runs a command in the background (`run_shell_command` with
`is_background`, for a dev server or a watcher), the session shows it as a
background task: running once it starts, then completed, failed or stopped,
with Qwen Code's own words for how it ended. Stopping it from the phone uses
Qwen Code's own task cancel. Its output stays in the file Qwen Code writes
(the shell's tool result names it); the phone does not stream it.

When a background shell ends, Qwen Code tells the model in a turn of its own,
which the phone shows as the agent working. That turn is a model request
like any other and is billed as one. A shell that ends before the turn that
started it is reported within that turn. A message sent during that turn
cuts it short — Qwen Code drops the rest of its reply and answers the
message — and so does Stop. A shell that ends after its session was closed
starts no turn (no request is made): Qwen Code keeps the result for the
conversation's next message while its process runs.

## What this does not have

- **No subscription usage** to ask for (the context meter still works).

## Offline and container notes

Like the DeepSeek Harness it is a package tree in the `agents` volume. A host
without npm registry access installs it from a copied `agents/` directory,
points `CODEDECK_NPM_REGISTRY` at a mirror, or points `CODEDECK_QWEN_PATH` at
its own.
