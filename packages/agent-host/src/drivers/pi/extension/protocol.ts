/**
 * What the CodeDeck Pi extension and the driver agree on. The extension runs
 * inside Pi's process and reaches the driver only through Pi's RPC records,
 * so every name both sides match on is defined here, once, and bundled into
 * both.
 */

/** The prefix the `tool_call` dialog's title carries, before the call's id.
 *  The driver matches on it to tell CodeDeck's gate from another extension's
 *  own dialog. */
export const PI_PERMISSION_PREFIX = 'codedeck-permission:';
