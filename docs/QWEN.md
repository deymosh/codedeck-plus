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

## What this does not have

- **No subscription usage** to ask for (the context meter still works).
- **No plugin management** from the phone: Qwen Code's extensions are its
  own.
- **No background tasks.**

## Offline and container notes

Like the DeepSeek Harness it is a package tree in the `agents` volume. A host
without npm registry access installs it from a copied `agents/` directory,
points `CODEDECK_NPM_REGISTRY` at a mirror, or points `CODEDECK_QWEN_PATH` at
its own.
