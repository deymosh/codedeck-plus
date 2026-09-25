/**
 * Host tools for Claude Code: the tools the bridge offers a session (the
 * device-test tools) exposed as an in-process MCP server named `codedeck`. The
 * handlers do nothing themselves — every call goes back to the bridge.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z, type ZodTypeAny } from 'zod';
import type { HostToolSpec } from '../../types';

export const HOST_MCP_SERVER = 'codedeck';

/** A zod shape for an object JSON Schema whose properties are scalars — the
 *  only shape host tools use. Unknown property types accept anything. */
export function zodShape(schema: unknown): Record<string, ZodTypeAny> {
  const s = (schema ?? {}) as { properties?: Record<string, { type?: unknown; description?: unknown }>; required?: unknown };
  const required = new Set(Array.isArray(s.required) ? s.required.filter((r): r is string => typeof r === 'string') : []);
  const shape: Record<string, ZodTypeAny> = {};
  for (const [name, prop] of Object.entries(s.properties ?? {})) {
    let field: ZodTypeAny;
    switch (prop?.type) {
      case 'string':
        field = z.string();
        break;
      case 'number':
        field = z.number();
        break;
      case 'integer':
        field = z.number().int();
        break;
      case 'boolean':
        field = z.boolean();
        break;
      default:
        field = z.unknown();
    }
    if (typeof prop?.description === 'string') field = field.describe(prop.description);
    shape[name] = required.has(name) ? field : field.optional();
  }
  return shape;
}

export function hostToolsServer(
  specs: HostToolSpec[],
  call: (tool: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>,
): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: HOST_MCP_SERVER,
    version: '1.0.0',
    tools: specs.map((spec) =>
      tool(spec.name, spec.description, zodShape(spec.inputSchema), async (args) => {
        const result = await call(spec.name, args as Record<string, unknown>);
        return { content: [{ type: 'text' as const, text: result.text }], isError: result.isError };
      }),
    ),
  });
}
