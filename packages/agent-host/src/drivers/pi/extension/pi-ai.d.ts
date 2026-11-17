/**
 * The part of Pi's `@earendil-works/pi-ai/providers/all` the extension uses.
 * Pi provides the module to extensions at run time, mapped to its own copy
 * (the bundle leaves it external); the host does not depend on the package,
 * so its types are declared here, as far as they are read.
 */
declare module '@earendil-works/pi-ai/providers/all' {
  export function getBuiltinProviders(): string[];
  export function getBuiltinModels(provider: string): Array<{
    id: string;
    provider: string;
    api: string;
    reasoning: boolean;
    contextWindow: number;
    maxTokens: number;
    input?: string[];
    thinkingLevelMap?: Record<string, unknown>;
    compat?: Record<string, unknown>;
  }>;
}
