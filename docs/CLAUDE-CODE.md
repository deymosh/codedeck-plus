# Claude Code

A Claude Code session on the phone is the official Claude Code CLI, run on
the bridge's machine. The driver (`packages/agent-host/src/drivers/claude/`)
uses Anthropic's Claude Agent SDK, which starts the `claude` binary as a
subprocess and talks to it over the CLI's own JSON control channel. It is
therefore the same Claude Code as in a terminal: the same settings, `CLAUDE.md`
files, plugins, hooks, MCP servers and skills, and the same conversations
(under `~/.claude/projects`, or `$CLAUDE_CONFIG_DIR`). The phone carries the
interaction: permission asks, questions, plan reviews.

## Getting it running

Install it from the phone (the machine's page, or New session) or with
`codedeck-bridge agents install claude-code`. The bridge installs the CLI
build its Agent SDK is locked to (about 100 MB), checked against
`pnpm-lock.yaml`. A `claude` already on the machine (`CODEDECK_CLAUDE_PATH`,
then `PATH` and the usual install locations) is used as it is.

It signs in as the CLI would on that machine:

- `CLAUDE_CODE_OAUTH_TOKEN` (for a subscription, a long-lived token from
  `claude setup-token`) or `ANTHROPIC_API_KEY` in the bridge's environment
  (under Docker, `.env`);
- an API key set from the phone (Agents → Claude Code), checked with the
  smallest request when saved; an exported key wins over it;
- or an existing `claude` login on the machine.

On Windows its Bash tool needs [Git for Windows](https://git-scm.com/downloads/win)
(`CLAUDE_CODE_GIT_BASH_PATH` if its `bash.exe` is not found).

## Modes, models and effort

- **Modes:** Plan (the default: nothing runs until you approve the plan),
  Edits (file edits run, other tools ask) and YOLO (every tool runs
  unasked). A plan approval chooses the mode the session goes on in, or
  sends the plan back with your feedback. "Always allow" on a permission
  card is saved as a project allow rule, as in the terminal.
- **Models:** the list is the CLI's own (`supportedModels`), so it follows
  the account and the CLI version. A session without a model runs Opus 5.5.
  A switch mid-session applies from the next turn.
- **Effort:** Auto (the model's own), Low, Medium (the default), High,
  XHigh, Max.
- **The 1M context window** is asked for on every model that has it — Sonnet
  and Opus, or whatever a gateway's model list says — and kept across a
  model switch.

## Gateways and provider profiles

**The bridge's own gateway.** `ANTHROPIC_BASE_URL` points every session that
is not bound to a profile at a gateway or router (claude-code-router, say).
With `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` the model list is read
from the gateway's `/v1/models`, which also says which models have the 1M
window; without it a router's models may only appear from the second
session after a start, a limit of the CLI's own discovery. The gateway must
forward the `anthropic-beta` header for the 1M window; the bridge logs a
line when a session asked for it and got 200k.

**A provider profile** (made on the phone, for any Anthropic-compatible
endpoint) binds one session to that endpoint for its whole life: it runs
only the profile's models, with the profile's token, and never falls back to
the bridge's own account. None of the operator's Anthropic, cloud-provider
or model variables reach such a session. Bound sessions publish no usage
at all — no plan limits, which would be priced for the wrong provider, and
so no context breakdown either.

## What the phone shows

- The transcript: text, reasoning, tool calls with their results and diffs,
  todos, background tasks (each one stoppable) and sub-agents, nested under
  the call that started them.
- Slash commands, as Claude Code lists them (its own, the user's, the
  project's and the plugins'), except those that only make sense in its
  terminal. A local command's report (`/model`, `/cost`) shows as a status
  line.
- A PreToolUse hook that asks shows as a permission card naming the hook
  (and its plugin, when one declares it); it asks every time, so the card
  has no "always".
- Usage: how full the context is and what fills it, part by part (its own
  `/context` data), the session's cost, and the plan's 5-hour and weekly
  limits with when they reset.

## Plugins and MCP servers

Both are managed from the machine's page and are Claude Code's own: plugins
through `claude plugin` (marketplaces, install, enable, update), MCP servers
in the user scope of its config, so a server added on the phone works in
the terminal too, and the other way round. A running session reloads them
in place. Its MCP servers can be switched off and on per session from the
model sheet.

## Test mode

`codedeck-bridge run --test-mode` (or `CODEDECK_TEST_MODE=1`) replaces the
SDK with canned sessions answering `/test-message`, `/test-tool`,
`/test-plan` and `/test-question`, with no account — for trying the phone's
flows.
