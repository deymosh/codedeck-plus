/**
 * The only place wire JSON is parsed. Both sides call these at ingest —
 * `JSON.parse` + cast is banned everywhere else. Invalid payloads come back as
 * a structured error to log-and-drop, never an exception or a lying cast.
 */
import { z } from 'zod';
import {
  phoneToBridgeSchema,
  type PhoneToBridgeMessage,
} from './schemas/commands';
import {
  bridgeToPhoneSchema,
  type BridgeToPhoneMessage,
} from './schemas/events';

export type DecodeResult<T> =
  | { ok: true; msg: T }
  | { ok: false; error: string };

function decode<T>(schema: z.ZodType<T>, json: string): DecodeResult<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const type =
      typeof raw === 'object' && raw !== null && 'type' in raw
        ? String((raw as { type: unknown }).type)
        : '<missing>';
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: `schema mismatch for type "${type}": ${issue ? `${issue.path.join('.')} ${issue.message}` : 'unknown issue'}`,
    };
  }
  return { ok: true, msg: parsed.data };
}

/** Bridge-side ingest: decode a message sent by a phone. */
export function decodePhoneToBridge(json: string): DecodeResult<PhoneToBridgeMessage> {
  return decode(phoneToBridgeSchema, json);
}

/** Phone-side ingest: decode a message sent by a bridge. */
export function decodeBridgeToPhone(json: string): DecodeResult<BridgeToPhoneMessage> {
  return decode(bridgeToPhoneSchema, json);
}

/** Encode any protocol message for the wire. Validates on the way out too, so a
 *  malformed message fails loudly at the sender (where the bug is) instead of
 *  being silently dropped at the receiver. */
export function encodePhoneToBridge(msg: PhoneToBridgeMessage): string {
  return JSON.stringify(phoneToBridgeSchema.parse(msg));
}

export function encodeBridgeToPhone(msg: BridgeToPhoneMessage): string {
  return JSON.stringify(bridgeToPhoneSchema.parse(msg));
}
