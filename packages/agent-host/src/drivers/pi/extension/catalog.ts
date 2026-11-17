/**
 * What Pi's own model catalog knows about a provider profile's model.
 *
 * A profile is an endpoint and a list of model ids: a provider's own API, or
 * a gateway in front of several (claude-code-router, LiteLLM). Its model
 * list rarely says how large a model's context is, whether it reasons, or how
 * long an answer may be — and a profile registered without them runs every
 * model at a guess: the wrong meter on the phone, compaction far too early,
 * thinking off. Pi ships a catalog of every model its built-in providers
 * serve, with exactly those facts, so the profile's models borrow them.
 *
 * The match is on the model, not the endpoint. A gateway's ids name its
 * upstream route before the model (`OpenCode Go/deepseek-v4.1-flash`) and a
 * provider may name the vendor (`deepseek/deepseek-v4.1-flash`): only the
 * part after the last `/` is the model, compared without case. When several
 * of Pi's providers serve it, the one the route names wins (`OpenCode Go` is
 * Pi's `opencode-go`); otherwise the smallest context, so a session never
 * plans for more than the endpoint may accept.
 */

/** One model of Pi's catalog, as far as a profile borrows from it. */
export interface CatalogModel {
  id: string;
  provider: string;
  api: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  input?: string[];
  thinkingLevelMap?: Record<string, unknown>;
  compat?: Record<string, unknown>;
}

/** A name compared loosely: no case, no punctuation or spaces. */
function loose(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function lastSegment(id: string): string {
  return id.slice(id.lastIndexOf('/') + 1).toLowerCase();
}

/** Pi's description of the model a profile names `id`, when it has one. */
export function describeModel(id: string, catalog: readonly CatalogModel[]): CatalogModel | undefined {
  const model = lastSegment(id);
  if (model === '') return undefined;
  const candidates = catalog.filter(
    (entry) => lastSegment(entry.id) === model && entry.contextWindow > 0 && entry.maxTokens > 0,
  );
  if (candidates.length === 0) return undefined;
  const slash = id.lastIndexOf('/');
  const route = slash > 0 ? loose(id.slice(0, slash)) : '';
  if (route !== '') {
    const named = candidates.find((entry) => loose(entry.provider) === route);
    if (named) return named;
  }
  return candidates.reduce((smallest, entry) => (entry.contextWindow < smallest.contextWindow ? entry : smallest));
}
