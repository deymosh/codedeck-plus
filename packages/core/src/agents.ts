/**
 * The agents this bridge can run sessions on, as the v11 heartbeat advertises
 * them (`AgentDescriptor`), plus the small per-agent facts the engine needs to
 * translate between an agent's own vocabulary and the agent-neutral wire:
 * tool kinds, one-line tool titles, and the permission choices an agent can
 * honor.
 *
 * Mode ids are the values the session runner and permission broker track. The
 * broker auto-approves every tool call in the `default` mode (YOLO) and asks
 * the phone in any other mode, for every agent.
 */
import type {
  AgentDescriptor,
  CredentialStatus,
  OptionChoice,
  PermissionOption,
  ToolKind,
} from '@codedeck/protocol';

export const CLAUDE_CODE_AGENT_ID = 'claude-code';
export const OPENCODE_AGENT_ID = 'opencode';

/** The mode in which the broker approves everything without asking. */
export const AUTO_APPROVE_MODE = 'default';

/** Credential ids on the wire. */
export const ANTHROPIC_API_KEY_CREDENTIAL = 'anthropic_api_key';
export const GITHUB_PAT_CREDENTIAL = 'github_pat';

const CLAUDE_MODES: OptionChoice[] = [
  { id: 'plan', label: 'Plan', description: 'Plan first; nothing runs until you approve the plan' },
  { id: AUTO_APPROVE_MODE, label: 'YOLO', description: 'Run every tool without asking' },
  { id: 'acceptEdits', label: 'Edits', description: 'Accept file edits; ask before other tools' },
];

const CLAUDE_EFFORTS: OptionChoice[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'XHigh' },
  { id: 'max', label: 'Max' },
];

const OPENCODE_MODES: OptionChoice[] = [
  { id: 'ask', label: 'Ask', description: 'Ask before each tool call' },
  { id: AUTO_APPROVE_MODE, label: 'YOLO', description: 'Run every tool without asking' },
];

/** The mode a new session starts in when the phone does not pick one. */
export function defaultModeFor(agent: string): string {
  return agent === OPENCODE_AGENT_ID ? 'ask' : 'plan';
}

/** Is `mode` one of `agent`'s advertised modes? */
export function isKnownMode(agent: string, mode: string): boolean {
  const modes = agent === OPENCODE_AGENT_ID ? OPENCODE_MODES : CLAUDE_MODES;
  return modes.some((m) => m.id === mode);
}

/** Is `effort` one of `agent`'s advertised effort levels? */
export function isKnownEffort(agent: string, effort: string): boolean {
  return agent !== OPENCODE_AGENT_ID && CLAUDE_EFFORTS.some((e) => e.id === effort);
}

export function claudeCodeDescriptor(credentials: CredentialStatus[]): AgentDescriptor {
  return {
    id: CLAUDE_CODE_AGENT_ID,
    displayName: 'Claude Code',
    modes: CLAUDE_MODES,
    efforts: CLAUDE_EFFORTS,
    defaultMode: defaultModeFor(CLAUDE_CODE_AGENT_ID),
    supports: { models: true, usage: true, providers: true, gsd: true, interrupt: true },
    credentials,
  };
}

export function openCodeDescriptor(): AgentDescriptor {
  return {
    id: OPENCODE_AGENT_ID,
    displayName: 'OpenCode',
    modes: OPENCODE_MODES,
    efforts: [],
    defaultMode: defaultModeFor(OPENCODE_AGENT_ID),
    // OpenCode reports no subscription usage and always uses the providers
    // configured on its own server.
    supports: { models: true, usage: false, providers: false, gsd: true, interrupt: true },
    credentials: [],
  };
}

// --- permission choices ---

export const PERMISSION_ALLOW: PermissionOption = { id: 'allow', label: 'Allow', kind: 'allow_once' };
export const PERMISSION_ALLOW_ALWAYS: PermissionOption = {
  id: 'allow_always',
  label: 'Always allow',
  kind: 'allow_always',
};
export const PERMISSION_DENY: PermissionOption = { id: 'deny', label: 'Deny', kind: 'reject_once' };

/** The choices a permission card offers. "Always allow" persists a project
 *  allow rule, which only Claude Code can honor. */
export function permissionOptionsFor(agent: string): PermissionOption[] {
  return agent === OPENCODE_AGENT_ID
    ? [PERMISSION_ALLOW, PERMISSION_DENY]
    : [PERMISSION_ALLOW, PERMISSION_ALLOW_ALWAYS, PERMISSION_DENY];
}

// --- plan approval choices ---

/** Plan approval option ids are the mode the session continues in, except
 *  `revise`, which keeps it planning. */
export const PLAN_REVISE = 'revise';

export const PLAN_APPROVAL_OPTIONS: OptionChoice[] = [
  { id: 'acceptEdits', label: 'Approve, auto-accept edits' },
  { id: AUTO_APPROVE_MODE, label: 'Approve and run without asking' },
  { id: PLAN_REVISE, label: 'Keep planning', description: 'Stay in plan mode and send feedback' },
];

// --- tools ---

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
