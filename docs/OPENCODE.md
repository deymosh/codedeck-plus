# OpenCode

CodeDeck+ runs sessions on any agent its agent host has a driver for, and
[OpenCode](https://opencode.ai) is the default one: a bridge with no OpenCode
installs it when it first starts (see "Agent binaries" in
[`BRIDGE.md`](BRIDGE.md)). A phone picks the agent per session from the "New
session" sheet, which lists the agents the bridge advertises in its
heartbeat; OpenCode can be removed from the machine's page like any agent
CodeDeck installed, and is then not installed again until someone asks.

The bridge never manages OpenCode's model access itself — the OpenCode driver
(`packages/agent-host/src/drivers/opencode/`) talks to a running
`opencode serve` HTTP server through `@opencode/client`, OpenCode 2.x's own
client. There are two ways to give it that server:

## Mode 1 — point at an external OpenCode server

Run `opencode serve` yourself (on the same machine, another machine, or
wherever), and tell the bridge its URL:

```bash
codedeck-bridge run --opencode-server-url http://127.0.0.1:4096
# or: CODEDECK_OPENCODE_SERVER_URL=http://127.0.0.1:4096 codedeck-bridge run
# or in config.json: { "openCodeServerUrl": "http://127.0.0.1:4096" }
```

This is the right choice when you already run OpenCode for other purposes
(e.g. driving its own TUI), or when the bridge and the OpenCode server live on
different machines. Precedence is the same as every other bridge setting:
`--opencode-server-url` flag > `CODEDECK_OPENCODE_SERVER_URL` env >
`openCodeServerUrl` in `config.json`.

## Mode 2 — let the bridge manage its own OpenCode server (the default)

Without a server URL, the bridge spawns `opencode serve` itself once
OpenCode is installed, and shuts it down cleanly when the bridge stops.
Nothing needs setting: this is the simplest option when the bridge runs in a
container (the same container runs OpenCode too, with nothing else to
deploy) or as a plain local process on a machine you control.

Settings for this mode:

- `--opencode-path <path>` / `CODEDECK_OPENCODE_PATH` / `"openCodePath"` —
  explicit path to the `opencode` binary. Otherwise the agent host looks for
  it on `PATH` and in a few well-known global-install locations (mirroring
  how it resolves `claude`), and when there is none it **installs it**: the
  `@opencode/cli-<os>-<arch>` build pinned in `pnpm-lock.yaml` (the `baseline`
  variant on x64, which needs no AVX2), downloaded in the background into
  `<home>/agents/`. The phone shows it as installing meanwhile, and new
  sessions start on it once it is ready.
- `CODEDECK_OPENCODE_PORT` / `"openCodePort"` (env/config-file only, no flag —
  a rarely hand-typed knob) — fixes the port instead of leaving the choice to
  OpenCode (which takes 4096 when it is free). Useful if you also want to
  point OpenCode's own TUI at the same running instance for debugging.

The embedded server always binds to `127.0.0.1` only — it is spawned
exclusively for the bridge's own use and is never configurable to listen on
any wider interface — and is guarded by a password made for each start
(`OPENCODE_PASSWORD`), which OpenCode 2 requires before it will start at all.
It runs with self-updating off (its version is the one `pnpm-lock.yaml`
pins). Web search is offered to every model rather than only OpenCode's own
providers': 2.x gates it behind a connected search provider with no keyless
default of its own, so the driver names the one provider its list serves
without a key.

The driver speaks OpenCode 2's API and nothing older. A binary from the 1.x
line will not work with it — set `CODEDECK_OPENCODE_PATH` to a 2.x install if
the machine has an older one on `PATH`.

If an installed `opencode` fails to come up, the agent host logs one
actionable line and reports OpenCode as unavailable (a session on it fails
with that reason). If the install fails, the phone shows OpenCode as failed
with the reason and offers Retry. Either way, OpenCode never blocks the other agents'
sessions.

A server URL wins over everything in this mode: with one set, nothing is
installed or started.

## Provider credentials

OpenCode knows about 230 providers. The phone connects them on the
machine's page: **AI providers → OpenCode → Connect a provider**. Pick one,
then either type its API key or sign in to a subscription. This goes through
OpenCode's own API, so it takes effect on the running server at once — the
provider's models join the list, with no restart and no session cut.

- **A key** is kept in OpenCode's database on the machine; the phone does not
  keep it, and nothing sends it back. A provider can hold several keys; the
  page marks the one in use and switches between them.
- **A device sign-in** (GitHub Copilot, OpenCode Console for Zen/Go, xAI)
  shows a code: open the sign-in page on any device and enter it. OpenCode
  watches the provider itself; the page says when it is done.
- **A sign-in that returns to the machine** (Sign in with ChatGPT, GitLab)
  sends the browser back to a listener on the machine's loopback, which a
  phone cannot open. After signing in, copy the address the browser fails to
  load and paste it on the page: the machine opens it itself. Only that
  sign-in's own address is accepted, so nothing else on the machine can be
  reached this way.

The environment still counts: whatever reaches the `opencode` process (the
bridge's own environment, for the server it starts; or however you started
the external server) is what OpenCode sees, including provider variables like
`ANTHROPIC_API_KEY`. Such a provider shows as connected "from the machine's
environment", and only the machine can change it.

Under Docker the image redirects OpenCode's config and auth storage under
`/data`, the volume the bridge's identity lives in, so keys and sign-ins
survive container recreation. `opencode auth login` on the machine
(`docker compose exec codedeck-bridge opencode auth login`) still works and
shows on the phone the same way.

## Provider profiles

A provider profile made on the phone for OpenCode (any OpenAI-compatible
endpoint or gateway) adds the endpoint's models to OpenCode's model list,
beside every provider it already has; a session picks one like any other
model. OpenCode's own catalog places each profile: an endpoint it knows
(DeepSeek's, OpenRouter's) signs in to that provider, and a gateway's models
get the catalog's limits, tool calls, image input and reasoning levels. A
profile whose name one of OpenCode's providers already has is refused, with
the reason.

OpenCode reads its providers only when it starts, so a changed list restarts
the bridge's server: its sessions end and the bridge resumes each on the new
server, where OpenCode still has the conversation (the transcript shows a
restart notice). An external server gets no profiles.

## When a provider fails

OpenCode retries a provider that fails, waiting longer each time (about a
minute in all). Each retry shows in the transcript with the provider's
reason, so a model that is down can be switched rather than waited out.

## "Always allow"

A permission card offers "Always allow "<pattern>" in this project" when
OpenCode offers to save a rule for the call: the pattern is OpenCode's own
(`git push *` for `git push origin main`), usually wider than the call.
Choosing it answers OpenCode's `always`, and OpenCode saves the rule for the
project in its database. Every later session in that project — whatever its
mode, Ask included — runs matching calls without asking, and the rule
survives a restart of the server. The machine's page on the phone lists them
under Permissions → OpenCode, by project, and removes them (OpenCode then
asks again).

## What this does not do

- No connection method that reads the machine's own setup (Amazon Bedrock's
  and Google Vertex's "external" credentials, AWS profiles and the like):
  those are configured on the machine. Their key methods are offered.
- No support for multiple simultaneous OpenCode servers.
- No change to the wire — this only controls how the OpenCode driver finds its
  server.
