# OpenCode backend

CodeDeck+ runs sessions on any agent its agent host has a driver for: Claude
Code (always available) and [OpenCode](https://opencode.ai). A phone picks the
agent per session from the "New session" sheet, which lists the agents the
bridge advertises in its heartbeat. OpenCode is optional: without its
configuration it is simply not advertised.

The bridge never manages OpenCode's model access itself — the OpenCode driver
(`packages/agent-host/src/drivers/opencode/`) talks to a running
`opencode serve` HTTP server through `@opencode-ai/sdk`. There are two ways to
give it that server:

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

## Mode 2 — let the bridge manage its own OpenCode server

Have the bridge spawn `opencode serve` itself at boot, and shut it down
cleanly when the bridge stops:

```bash
codedeck-bridge run --opencode-auto-start
# or: CODEDECK_OPENCODE_AUTO_START=1 codedeck-bridge run
# or in config.json: { "openCodeAutoStart": true }
```

This is the simplest option when the bridge runs in a container (the same
container can run OpenCode too, with nothing else to deploy) or as a plain
local process on a machine you control.

Additional settings for this mode:

- `--opencode-path <path>` / `CODEDECK_OPENCODE_PATH` / `"openCodePath"` —
  explicit path to the `opencode` binary. Otherwise the agent host looks for
  it on `PATH` and in a few well-known global-install locations (mirroring
  how it resolves `claude`), and when there is none it **installs it**: the
  `opencode-<os>-<arch>` build pinned in `pnpm-lock.yaml` (the `baseline`
  variant on x64, which needs no AVX2), downloaded in the background into
  `<home>/agents/` — see "Agent binaries" in [`BRIDGE.md`](BRIDGE.md).
  Sessions started meanwhile wait for it.
- `CODEDECK_OPENCODE_PORT` / `"openCodePort"` (env/config-file only, no flag —
  a rarely hand-typed knob) — fixes the port instead of the default OS-assigned
  ephemeral one. Useful if you also want to point OpenCode's own TUI at the
  same running instance for debugging.

The embedded server always binds to `127.0.0.1` only — it is spawned
exclusively for the bridge's own use and is never configurable to listen on
any wider interface.

If an installed `opencode` fails to come up, the agent host logs one
actionable line and reports OpenCode as unavailable (a session on it fails
with that reason). If the on-demand install or the server it starts fails,
the session that waited on it fails with the reason and the next session
tries again. Either way, OpenCode never blocks Claude Code sessions.

If both `openCodeServerUrl` and `openCodeAutoStart` are set, the external URL
wins (logged as a warning — usually a leftover setting from switching modes).

## Provider credentials

OpenCode supports 75+ model providers with no single credential shape, so
CodeDeck+ does not manage them for you. Whatever environment reaches the
`opencode` process (the bridge's own environment, for auto-start; or however
you started the external server) is what OpenCode sees — including common
provider env vars like `ANTHROPIC_API_KEY`. See
[OpenCode's own docs](https://opencode.ai/docs) for the full list of supported
providers and how to configure each.

For **auto-start under Docker**, run the one-time interactive login once the
container is up and OpenCode has been installed (the bridge log says
`OpenCode installed at …`; the image puts it on `PATH`). The login survives
container recreation: the image redirects OpenCode's config/auth storage
under `/data`, the same volume the bridge's own identity lives in.

```bash
docker compose exec codedeck-bridge opencode auth login
```

## What this does not do

- No automated credential setup — that one `opencode auth login` step (or
  equivalent env vars) is on you.
- No support for multiple simultaneous OpenCode servers.
- No change to the wire — this only controls how the OpenCode driver finds its
  server.
