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

## Modes and reasoning

Qwen Code's own approval modes: Ask (`default`), Auto edit, Plan, Auto (an
LLM classifier approves what it judges safe) and YOLO. Reasoning: Off, Low,
Medium, High, Extra high, Max.

## What this does not have

- **No subscription usage** to ask for (the context meter still works).
- **No plugin or MCP management** from the phone: both are Qwen Code's own
  configuration files.
- **No background tasks.**

## Offline and container notes

Like the DeepSeek Harness it is a package tree in the `agents` volume. A host
without npm registry access installs it from a copied `agents/` directory,
points `CODEDECK_NPM_REGISTRY` at a mirror, or points `CODEDECK_QWEN_PATH` at
its own.
