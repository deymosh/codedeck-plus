/**
 * Tool-call safety rules drivers apply before (or instead of) asking the
 * user.
 */
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Secret-bearing paths a device-test session must never read (signing
 * keystores + their cleartext password files + env files, SSH keys, cloud
 * and registry credentials, PEM material, git credential stores). Matched
 * case-insensitively anywhere in a tool's string arguments. This is the
 * enforced half of the "dev builds only, never touch release keystores"
 * rule for test sessions.
 */
const SECRET_PATH_PATTERNS = [
  String.raw`\.keystore`,
  String.raw`\.jks`,
  String.raw`\.p12`,
  String.raw`\.pfx`,
  String.raw`key\.properties`,
  String.raw`keystore\.properties`,
  String.raw`(?<![A-Za-z0-9])\.env`,
  String.raw`\.ssh`,
  String.raw`id_(?:rsa|ed25519|ecdsa|dsa)`,
  String.raw`\.pem`,
  String.raw`\.netrc`,
  String.raw`\.npmrc`,
  String.raw`\.aws/credentials`,
  String.raw`\.git-credentials`,
  String.raw`\.credentials\.json`,
];

const SECRET_PATH_RE = new RegExp(`(${SECRET_PATH_PATTERNS.join('|')})(?![A-Za-z0-9])`, 'i');

/** Tools whose arguments can name a filesystem path or a shell command.
 *  Lower-case: agents differ in capitalization (`Read` vs `read`). */
const PATH_BEARING_TOOLS = new Set(['read', 'bash', 'grep', 'glob', 'edit', 'write', 'notebookedit', 'multiedit', 'list', 'patch', 'apply_patch']);

/** True if a tool call references a secret-bearing path in any of its string args. */
export function touchesSecretPath(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (!PATH_BEARING_TOOLS.has(toolName.toLowerCase())) return false;
  return SECRET_PATH_RE.test(JSON.stringify(toolInput ?? {}));
}

/** The refusal an agent sees for a secret-path call. */
export const SECRET_PATH_DENIAL =
  'Blocked: device-test sessions may not read signing keystores or secret files (keystore/.jks/.p12/key.properties/keystore.properties/.env). This is a hard security boundary.';

/** Absolute path of Claude Code's plan-authoring directory (`~/.claude/plans`, honoring CLAUDE_CONFIG_DIR). */
function plansDirPath(): string {
  const env = process.env.CLAUDE_CONFIG_DIR;
  const base = env && env.trim() ? env.trim() : path.join(os.homedir(), '.claude');
  return path.join(base, 'plans');
}

/**
 * Detect a benign write confined to Claude Code's plan directory (`~/.claude/plans`).
 *
 * In plan mode the SDK gates writes through canUseTool. A plan sub-agent's `mkdir -p ~/.claude/plans`
 * (or writing the plan file itself) would otherwise block on phone approval — and if that prompt is
 * never surfaced/answered it deadlocks the whole session (the sub-agent never returns to the parent).
 * Auto-allowing ONLY this narrow, safe path breaks that deadlock without weakening plan mode for real
 * edits. Fails CLOSED: anything ambiguous returns false and falls through to normal phone approval.
 */
export function isBenignPlanDirWrite(toolName: string, toolInput: Record<string, unknown>): boolean {
  const plansDir = plansDirPath();
  // Expand ONLY a bare `~` / `~/...` (current user's home). `~otheruser` is deliberately left
  // unexpanded so it cannot resolve into our plans dir — it falls through to phone approval.
  const expandTilde = (p: string): string =>
    p === '~' ? os.homedir()
    : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2))
    : p;
  const underPlans = (p: unknown): boolean => {
    if (typeof p !== 'string' || !p) return false;
    const resolved = path.resolve(expandTilde(p));
    return resolved === plansDir || resolved.startsWith(plansDir + path.sep);
  };

  switch (toolName) {
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return underPlans(toolInput.file_path);
    case 'NotebookEdit':
      return underPlans(toolInput.notebook_path ?? toolInput.file_path);
    case 'Bash': {
      let command = typeof toolInput.command === 'string' ? toolInput.command.trim() : '';
      if (!command) return false;
      // Strip harmless trailing `echo "<literal>"` status messages the harness appends. Only
      // string-literal echoes (no $, backtick, backslash, or redirection) are removed.
      command = command.replace(/(^|;)\s*echo\s+(?:"[^"$`\\]*"|'[^']*')\s*(?=;|$)/g, '$1');
      command = command.replace(/^\s*;+|;+\s*$/g, '').trim();
      // Strip a harmless stderr-suppression redirect on the mkdir.
      command = command.replace(/\s+2>\s*\/dev\/null\b/g, '').trim();
      // Whatever remains must be a single simple mkdir with no chaining/redirection metacharacters.
      // `~` is allowed through (expandTilde handles it below); `..` is still rejected.
      if (/[;&|`$<>]|\.\./.test(command)) return false;
      const m = command.match(/^mkdir\s+(?:-p\s+)?(['"]?)([^'"]+)\1$/);
      if (!m) return false;
      return underPlans(m[2]);
    }
    default:
      return false;
  }
}
