/**
 * Helpers every driver uses to describe tool calls in the wire's
 * agent-neutral terms: a tool kind, a one-line title, the files touched, and
 * the standard permission choices.
 */
import type { PermissionOption, ToolKind } from './types';

const TOOL_KINDS: Record<string, ToolKind> = {
  read: 'read',
  notebookread: 'read',
  list: 'read',
  ls: 'read',
  write: 'edit',
  edit: 'edit',
  multiedit: 'edit',
  notebookedit: 'edit',
  patch: 'edit',
  bash: 'execute',
  bashoutput: 'execute',
  killshell: 'execute',
  killbash: 'execute',
  glob: 'search',
  grep: 'search',
  codesearch: 'search',
  webfetch: 'fetch',
  websearch: 'fetch',
  todowrite: 'think',
  todoread: 'think',
  exitplanmode: 'switch_mode',
  enterplanmode: 'switch_mode',
};

/** Normalize an agent's tool name (Claude Code's `Bash`, OpenCode's `bash`)
 *  to the wire's tool kind. */
export function toolKindOf(toolName: string): ToolKind {
  return TOOL_KINDS[toolName.toLowerCase()] ?? 'other';
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** One-line human summary of a tool call, e.g. `npm test` or `src/main.rs`. */
export function toolTitle(toolName: string, input: Record<string, unknown>): string {
  switch (toolName.toLowerCase()) {
    case 'bash':
      return str(input.command) || str(input.description);
    case 'read':
    case 'write':
    case 'edit':
    case 'multiedit':
      return str(input.file_path) || str(input.filePath);
    case 'notebookedit':
      return str(input.notebook_path) || str(input.file_path);
    case 'glob':
    case 'grep':
      return str(input.pattern);
    case 'task':
    case 'agent': {
      const desc = str(input.description);
      const sub = str(input.subagent_type);
      return sub ? `${desc} (${sub})` : desc;
    }
    case 'websearch':
      return str(input.query);
    case 'webfetch':
      return str(input.url);
    default:
      return JSON.stringify(input ?? {}).slice(0, 200);
  }
}

/** The files a tool call touches, when its input names them. */
export function toolLocations(input: Record<string, unknown>): string[] {
  const path = str(input.file_path) || str(input.filePath) || str(input.notebook_path);
  return path ? [path] : [];
}

export const PERMISSION_ALLOW: PermissionOption = { id: 'allow', label: 'Allow', kind: 'allow_once' };
export const PERMISSION_ALLOW_ALWAYS: PermissionOption = {
  id: 'allow_always',
  label: 'Always allow',
  kind: 'allow_always',
};
export const PERMISSION_DENY: PermissionOption = { id: 'deny', label: 'Deny', kind: 'reject_once' };

/** Current time as a transcript timestamp. */
export function now(): string {
  return new Date().toISOString();
}
