/**
 * A request to the driver that waits for its answer: an extension `editor`
 * dialog titled `PI_REQUEST_PREFIX` + the operation, with the request as
 * JSON in its prefill (protocol.ts). The driver answers with the reply as
 * JSON; a cancelled dialog (an interrupt, the session ending, the phone not
 * answering) resolves to nothing.
 */
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { PI_REQUEST_PREFIX, type PiRequest } from './protocol';

export type RequestUi = Pick<ExtensionContext['ui'], 'editor'>;

export async function request<T>(ui: RequestUi, body: PiRequest): Promise<T | undefined> {
  const value = await ui.editor(PI_REQUEST_PREFIX + body.op, JSON.stringify(body));
  if (value === undefined || value === '') return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}
