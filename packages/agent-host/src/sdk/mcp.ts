/**
 * What every driver reports about an MCP server, agent-neutral: enough to
 * recognise it and never a secret. A stdio server shows the program it runs
 * (its arguments may carry a token); a remote one its URL without user info,
 * query or fragment; env variables and headers by name only.
 */
import type { McpServerInfo, McpServerSetup, McpStatus } from './types';

/** `url` without the parts that may carry a credential. */
export function redactUrl(url: string): string {
  const cut = url.split(/[?#]/, 1)[0] ?? '';
  const scheme = cut.indexOf('://');
  if (scheme < 0) return cut;
  const rest = cut.slice(scheme + 3);
  const slash = rest.indexOf('/');
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  const host = authority.slice(authority.lastIndexOf('@') + 1);
  return `${cut.slice(0, scheme + 3)}${host}${slash < 0 ? '' : rest.slice(slash)}`;
}

export interface RawServer {
  name: string;
  transport: McpServerInfo['transport'];
  command?: string;
  url?: string;
  envKeys?: string[];
  headerKeys?: string[];
  enabled: boolean;
}

export function serverInfo(raw: RawServer): McpServerInfo {
  const target = raw.transport === 'stdio' ? (raw.command ?? '').trim() : redactUrl(raw.url ?? '');
  return {
    name: raw.name,
    transport: raw.transport,
    target,
    ...(raw.envKeys?.length ? { envKeys: [...raw.envKeys].sort() } : {}),
    ...(raw.headerKeys?.length ? { headerKeys: [...raw.headerKeys].sort() } : {}),
    enabled: raw.enabled,
  };
}

/**
 * The credential values one server's setup carries: env and header values,
 * and — for a stdio server — its arguments, which commonly hold a token.
 * These are removed from any error text about the server before it is logged
 * or sent on.
 */
export function setupSecrets(setup: McpServerSetup): string[] {
  if (setup.type === 'stdio') {
    return [...(setup.args ?? []), ...Object.values(setup.env ?? {})];
  }
  return [setup.url, ...Object.values(setup.headers ?? {})];
}

/** An agent's own status word for a server, mapped onto the wire's. */
export function mcpStatus(raw: string | undefined): McpStatus {
  switch (raw) {
    case 'connected':
      return 'connected';
    case 'disabled':
      return 'disabled';
    case 'needs-auth':
    case 'needs_auth':
    case 'needs_client_registration':
      return 'needs-auth';
    case 'pending':
    case 'connecting':
      return 'pending';
    default:
      return 'failed';
  }
}
