/**
 * The session's shells, as the machine has them. On Windows a session has
 * both of Pi's shell tools: `powershell`, which every Windows can run, and
 * `bash`, which runs Git Bash or a bash on PATH. Where Pi finds no bash, its
 * tool could only fail — every call a wasted turn — so it is switched off as
 * the session starts and PowerShell is the session's shell. Whether there is
 * a bash is asked of Pi's own resolution (its `getShellConfig`, with its own
 * environment and settings), never guessed from outside it.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export function installShellCheck(
  pi: Pick<ExtensionAPI, 'on' | 'getActiveTools' | 'setActiveTools'>,
  bashAvailable: () => boolean,
): void {
  pi.on('session_start', async () => {
    const active = pi.getActiveTools();
    // Only when there is another shell to fall back to: without one, bash's
    // own error is the clearest thing the model can get.
    if (!active.includes('bash') || !active.includes('powershell') || bashAvailable()) return;
    pi.setActiveTools(active.filter((name) => name !== 'bash'));
  });
}
