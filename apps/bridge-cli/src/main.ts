/**
 * codedeck-bridge — headless VPS/CLI connector (CDX-006, spec CDB-036).
 *
 * `codedeck-bridge` in a project directory, scan the QR, done — no clone, no
 * build, no editor. (Installed from the release tarball: this is NOT on npm,
 * so `npx @codedeck/bridge` does not work.) Subcommands: run (default), pair, status,
 * unpair, folders. Config precedence: flags > CODEDECK_* env >
 * ~/.codedeck/config.json. Argv parsing + dispatch only — everything real
 * lives in ./commands and @codedeck/core.
 */
import { parseArgs } from 'node:util';
import { PROTOCOL_VERSION } from '@codedeck/protocol';
import { installProcessGuards } from '@codedeck/core';
import { loadCliConfig, type CliFlags } from './config';
import { cmdFolders, cmdPair, cmdRun, cmdStatus, cmdUnpair } from './commands';

const USAGE = `codedeck-bridge — CodeDeck's headless bridge (protocol v${PROTOCOL_VERSION})

Usage: codedeck-bridge [command] [options]

Commands:
  run           Run the bridge (default): connect to relays, serve paired phones
  pair          Show a pairing QR / URL and wait for a phone to pair
  status        Show configuration, identity, paired phones, and run state
  unpair        Remove a paired phone: unpair <npub|pubkey-hex|label> | --all
  folders       List the project folders a paired phone can start sessions in
  version       Print the version

Options:
  --home <dir>            State/config directory (env CODEDECK_HOME, default ~/.codedeck)
  --machine-name <name>   Display name on the phone (env CODEDECK_MACHINE_NAME,
                          default "<hostname> (cli)")
  --relay <url>           Relay URL, repeatable (env CODEDECK_RELAYS, comma-separated)
  --workspace <dir>       Workspace root sessions may run in, repeatable
                          (env CODEDECK_WORKSPACE_ROOTS, comma-separated; default cwd)
  --claude-path <path>    Path to the claude executable (env CODEDECK_CLAUDE_PATH)
  --service               Advertise as a systemd service (auto-detected via INVOCATION_ID)
  --all                   With unpair: remove every paired phone
  -h, --help              Show this help
  -v, --version           Print the version

Config file: <home>/config.json — { "machineName", "relays", "workspaceRoots",
"claudePath", "relayRegisterEndpoint", "relayRegisterToken",
"blossomRegisterEndpoint", "blossomRegisterToken" }.
Precedence: flags > environment > config file > defaults.
State: <home>/state.json (bridge secret key + pairings, mode 0600).`;

async function main(): Promise<number> {
  let values: {
    home?: string;
    'machine-name'?: string;
    relay?: string[];
    workspace?: string[];
    'claude-path'?: string;
    service?: boolean;
    all?: boolean;
    help?: boolean;
    version?: boolean;
  };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        home: { type: 'string' },
        'machine-name': { type: 'string' },
        relay: { type: 'string', multiple: true },
        workspace: { type: 'string', multiple: true },
        'claude-path': { type: 'string' },
        service: { type: 'boolean' },
        all: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    }));
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : e}\n\n${USAGE}\n`);
    return 1;
  }

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const command = positionals[0] ?? 'run';
  if (values.version || command === 'version') {
    process.stdout.write(`codedeck-bridge (protocol v${PROTOCOL_VERSION})\n`);
    return 0;
  }

  const flags: CliFlags = {
    ...(values.home ? { home: values.home } : {}),
    ...(values['machine-name'] ? { machineName: values['machine-name'] } : {}),
    ...(values.relay?.length ? { relays: values.relay } : {}),
    ...(values.workspace?.length ? { workspaces: values.workspace } : {}),
    ...(values['claude-path'] ? { claudePath: values['claude-path'] } : {}),
    ...(values.service ? { service: true } : {}),
  };

  let resolved;
  try {
    resolved = loadCliConfig(flags);
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : e}\n`);
    return 1;
  }

  const io = { out: process.stdout, err: process.stderr };
  switch (command) {
    case 'run':
      return cmdRun(resolved, io);
    case 'pair':
      return cmdPair(resolved, io);
    case 'status':
      return cmdStatus(resolved, io);
    case 'unpair':
      return cmdUnpair(resolved, io, positionals[1], values.all ?? false);
    case 'folders':
      return cmdFolders(resolved, io);
    default:
      process.stderr.write(`error: unknown command '${command}'\n\n${USAGE}\n`);
      return 1;
  }
}

// CDX-074: installed BEFORE anything else runs, because the window a stray
// rejection can kill starts at the first await. `run` is a long-lived process
// whose only job is to stay up for the phone, so a fire-and-forget failure logs
// loudly and the bridge keeps serving; a genuine uncaught exception still exits
// 1. See packages/core/src/process/guards.ts for why the two differ, and for
// why neither can hold the event loop open past a SIGTERM (CDX-023).
installProcessGuards({ log: (line) => process.stderr.write(`${line}\n`) });

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`codedeck-bridge: fatal: ${err instanceof Error ? err.stack ?? err.message : err}\n`);
    process.exitCode = 1;
  },
);
