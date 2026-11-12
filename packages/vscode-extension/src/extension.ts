/**
 * The extension: a launcher for the bridge, nothing more. It installs the
 * bridge of the release it was built with (or runs `codedeck.bridgePath`),
 * runs `codedeck-bridge run` on the workspace's folders, shows the pairing
 * QR from `codedeck-bridge pair --json`, and keeps a status bar entry and a
 * log. It knows no agent: the bridge and its agent host do the rest.
 */

import type { ChildProcess } from 'node:child_process';

import * as vscode from 'vscode';

import { Bridge, runLines, type BridgeState, type Command } from './bridge.js';
import { ensureBridge } from './install.js';
import { pairPage, type PairView } from './pairPage.js';
import { parsePairLine } from './pairing.js';
import { downloadUrl, parseRelease, platformKey } from './release.js';

/** The release manifest, baked in by build.mjs; `null` in a developer's build. */
declare const __CODEDECK_RELEASE__: unknown;

let bridge: Bridge | undefined;
/** Every open pairing panel, so deactivating stops their commands. */
const activePairings = new Set<Pairing>();

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('CodeDeck+');
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.name = 'CodeDeck+ bridge';
  item.command = 'codedeck.menu';
  context.subscriptions.push(output, item);

  let installing = false;
  /** A Stop while the bridge was still installing: do not start it once it is in. */
  let cancelStart = false;
  /** A stop in flight, which a Start waits for. */
  let stopping: Promise<void> | undefined;
  let binary: string | undefined;
  /** A pair command between its click and its panel. */
  let pairStarting = false;
  let pairing: Pairing | undefined;

  const render = (): void => {
    const state = bridge?.state ?? { kind: 'stopped' };
    const look = installing
      ? { icon: 'cloud-download', tip: 'Installing the bridge…' }
      : statusLook(state);
    item.text = `$(${look.icon}) CodeDeck+`;
    item.tooltip = `${look.tip}\nClick for the bridge's actions.`;
    item.backgroundColor =
      state.kind === 'failed' && !installing ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    item.show();
  };

  bridge = new Bridge(
    (state) => {
      render();
      if (state.kind === 'failed') {
        void vscode.window
          .showErrorMessage(`The CodeDeck+ bridge stopped: ${state.message}`, 'Show the log')
          .then((pick) => pick && output.show());
      }
    },
    (line) => output.appendLine(line),
  );

  const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('codedeck');
  const homeArgs = (): string[] => {
    const home = config().get<string>('home', '').trim();
    return home ? ['--home', home] : [];
  };

  /** The bridge binary to run: the configured one, or this release's, installed on first use. */
  const resolveBinary = async (): Promise<string> => {
    const configured = config().get<string>('bridgePath', '').trim();
    if (configured) return configured;
    const release = parseRelease(__CODEDECK_RELEASE__);
    if (!release) {
      throw new Error('this build of the extension carries no release to install: set codedeck.bridgePath to a bridge binary');
    }
    const key = platformKey(process.platform, process.arch);
    const asset = key ? release.assets[key] : undefined;
    if (!asset) {
      throw new Error(
        `no bridge is built for ${process.platform}-${process.arch}: set codedeck.bridgePath to one built from source`,
      );
    }
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Installing the CodeDeck+ bridge ${release.version}` },
      async (progress) => {
        let reported = 0;
        return ensureBridge({
          url: downloadUrl(release, asset),
          asset,
          version: release.version,
          storage: context.globalStorageUri.fsPath,
          onProgress: (received, total) => {
            if (!total) return;
            const percent = Math.floor((received / total) * 100);
            if (percent > reported) {
              progress.report({ increment: percent - reported, message: `${Math.round(received / 1e6)} of ${Math.round(total / 1e6)} MB` });
              reported = percent;
            }
          },
        });
      },
    );
  };

  const start = async (): Promise<boolean> => {
    if (stopping) await stopping;
    if (!bridge || installing || bridge.state.kind === 'starting' || bridge.state.kind === 'running') return true;
    cancelStart = false;
    const folders = (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === 'file')
      .map((folder) => folder.uri.fsPath);
    if (folders.length === 0) {
      void vscode.window.showWarningMessage('Open a folder first: the bridge runs its sessions in the workspace’s folders.');
      return false;
    }
    installing = true;
    render();
    try {
      binary = await resolveBinary();
    } catch (err) {
      void vscode.window.showErrorMessage(`CodeDeck+: ${(err as Error).message}`);
      return false;
    } finally {
      installing = false;
      render();
    }
    if (cancelStart) return false;
    const args = [...homeArgs(), 'run', ...folders.flatMap((folder) => ['--workspace', folder])];
    output.appendLine(`> ${binary} ${args.join(' ')}`);
    bridge.start({ command: binary, args });
    return true;
  };

  /**
   * Resolves once the bridge serves (true), or has stopped trying or not
   * served within a minute of starting (false). An install still
   * downloading is waited for: it ends one way or the other.
   */
  const serving = (): Promise<boolean> =>
    new Promise((resolve) => {
      let giveUpAt = Date.now() + 60_000;
      const check = (): boolean => {
        const kind = bridge?.state.kind;
        if (kind === 'running' || kind === 'elsewhere') return (resolve(true), true);
        if (installing) {
          giveUpAt = Date.now() + 60_000;
          return false;
        }
        if (kind !== 'starting' || Date.now() > giveUpAt) return (resolve(false), true);
        return false;
      };
      if (check()) return;
      const timer = setInterval(() => check() && clearInterval(timer), 200);
    });

  /**
   * Shows the pairing panel, following a new `pair --json` unless one is
   * still waiting for a phone; an ended panel ("Show a new code") is reused.
   */
  const pair = async (): Promise<void> => {
    if (pairing && !pairing.ended) {
      pairing.panel.reveal();
      return;
    }
    if (pairStarting) return;
    pairStarting = true;
    try {
      const kind = bridge?.state.kind;
      if (kind !== 'running' && kind !== 'elsewhere') {
        if (!(await start()) || !(await serving())) return;
      }
      if (!binary) return;
      const command = { command: binary, args: [...homeArgs(), 'pair', '--json'] };
      if (pairing) {
        pairing.panel.reveal();
        pairing.follow(command);
      } else {
        const opened: Pairing = openPairing(command, output, () => {
          if (pairing === opened) pairing = undefined;
        });
        pairing = opened;
      }
    } finally {
      pairStarting = false;
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('codedeck.start', start),
    vscode.commands.registerCommand('codedeck.stop', async () => {
      if (installing) cancelStart = true;
      stopping ??= (bridge?.stop() ?? Promise.resolve()).finally(() => (stopping = undefined));
      await stopping;
    }),
    vscode.commands.registerCommand('codedeck.pair', pair),
    vscode.commands.registerCommand('codedeck.showLogs', () => output.show()),
    vscode.commands.registerCommand('codedeck.menu', async () => {
      const kind = bridge?.state.kind ?? 'stopped';
      const live = installing || kind === 'running' || kind === 'starting';
      const items: (vscode.QuickPickItem & { command: string })[] = [
        { label: '$(device-mobile) Pair a phone', command: 'codedeck.pair' },
        live
          ? { label: '$(debug-stop) Stop the bridge', command: 'codedeck.stop' }
          : { label: '$(play) Start the bridge', command: 'codedeck.start' },
        { label: '$(output) Show the log', command: 'codedeck.showLogs' },
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: statusLook(bridge?.state ?? { kind: 'stopped' }).tip });
      if (pick) await vscode.commands.executeCommand(pick.command);
    }),
  );

  render();
  if (config().get<boolean>('autoStart', false) && vscode.workspace.workspaceFolders?.length) {
    void start();
  }
}

export async function deactivate(): Promise<void> {
  activePairings.forEach((p) => p.stop());
  await bridge?.stop();
}

function statusLook(state: BridgeState): { icon: string; tip: string } {
  switch (state.kind) {
    case 'stopped':
      return { icon: 'circle-slash', tip: 'The bridge is stopped.' };
    case 'starting':
      return { icon: 'loading~spin', tip: 'The bridge is starting…' };
    case 'running':
      return { icon: 'radio-tower', tip: 'The bridge is running for this workspace.' };
    case 'elsewhere':
      return {
        icon: 'radio-tower',
        tip: 'Another bridge runs on this machine (a service, a terminal or another window); phones pair through it.',
      };
    case 'failed':
      return { icon: 'error', tip: `The bridge stopped: ${state.message}` };
  }
}

interface Pairing {
  panel: vscode.WebviewPanel;
  /** Whether its `pair --json` has ended (paired, expired, closed or failed). */
  readonly ended: boolean;
  /** Follows a new `pair --json` in the same panel. */
  follow(command: Command): void;
  /** Stops the command it follows, if any. */
  stop(): void;
}

/**
 * A pairing panel following `pair --json`. Closing the panel stops the
 * command; the window it showed simply expires on the bridge.
 */
function openPairing(command: Command, output: vscode.OutputChannel, onClose: () => void): Pairing {
  const panel = vscode.window.createWebviewPanel('codedeck.pair', 'Pair a phone', vscode.ViewColumn.Active, {
    enableScripts: false,
    enableCommandUris: ['codedeck.pair'],
  });
  let disposed = false;
  let child: ChildProcess | undefined;
  let ended = true;
  // A line readline still holds, or the exit, can arrive after the panel
  // closed: a disposed webview must not be written to.
  const show = (view: PairView): void => {
    if (!disposed) panel.webview.html = pairPage(view, panel.webview.cspSource);
  };

  const follow = (next: Command): void => {
    child?.kill();
    ended = false;
    let lastError = '';
    show({ state: 'waiting' });
    const run = runLines(next, (line, stream) => {
      if (child !== run.child) return;
      const status = stream === 'stdout' ? parsePairLine(line) : undefined;
      if (status) {
        ended = status.state !== 'open';
        show(status);
        if (status.state === 'paired') {
          void vscode.window.showInformationMessage(
            `CodeDeck+: ${status.phone ? `“${status.phone.label}”` : 'a phone'} is paired with this machine.`,
          );
        }
      } else if (line.trim()) {
        if (stream === 'stderr') lastError = line.trim().replace(/^error: /, '');
        output.appendLine(`[pair] ${line}`);
      }
    });
    child = run.child;
    void run.exited.then((code) => {
      if (child !== run.child) return;
      child = undefined;
      if (!ended && code !== null) show({ state: 'failed', message: lastError || `pair exited with code ${code}` });
      ended = true;
    });
  };

  const pairing: Pairing = {
    panel,
    get ended() {
      return ended;
    },
    follow,
    stop: () => child?.kill(),
  };
  activePairings.add(pairing);
  panel.onDidDispose(() => {
    disposed = true;
    pairing.stop();
    activePairings.delete(pairing);
    onClose();
  });
  follow(command);
  return pairing;
}
