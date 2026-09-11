/**
 * A native-backed `BridgeApiLike` (migration F2b) — the replacement for
 * `BridgeApi` when the phone is fully re-pointed at the Rust core: every
 * method dispatches the matching `Intent` instead of building, NIP-44
 * encrypting, signing, and publishing the wire command itself (Rust already
 * owns that whole pipeline, proven end to end this session's `Intent`
 * additions and the Layer 2 contract-harness gate).
 *
 * `dispatch` here is optimistic — it resolves `true` once the Intent was
 * accepted for processing, not once the bridge actually answered. This
 * matches every other native adapter's "the next view refresh is the real
 * state" contract, and is no different from what `BridgeApi.send` itself
 * promises: `true` there means "a relay accepted the publish," never "the
 * bridge processed it."
 *
 * Three methods are deliberate, documented rejections rather than
 * like-for-like shims:
 * - `createFolder`: a correlated request/response (folder-ack) with no
 *   `Intent` or `CoreEvent` on the Rust side at all yet — a real gap, not
 *   an oversight papered over here.
 * - `uploadImageBlossom`/`uploadImageChunk`: their two-stage shape (upload
 *   raw bytes to Blossom, THEN separately publish the resulting hash/key
 *   reference; or fall back to relay chunks) is already re-implemented as
 *   ONE unconditional step inside `Intent::SendSessionImage` — the Rust
 *   core does its own Blossom upload via the `HttpFetch` port and decides
 *   the chunk fallback internally. Shimming these two callbacks
 *   individually would either upload the image TWICE (once via the
 *   existing TS `uploadToBlossom` helper the caller already ran, once more
 *   inside the dispatched Intent) or silently swallow the fallback the
 *   caller expects to invoke independently. Neither is an acceptable
 *   "close enough": the native call site needs to skip `sendSessionImage()`
 *   (`apps/mobile/src/ui/imageFile.ts`) entirely and
 *   `dispatch({ sendSessionImage: {...} })` directly with the raw bytes —
 *   a UI-level change, not something this backend shim can paper over.
 */
import type { NativeCore } from '../../platform/nativeCore';
import type { BridgeApiLike } from './bridgeApi';
import type { PhoneToBridgeMessage } from '@codedeck/protocol';
import type { Intent } from '../nativeCoreTypes';

export interface NativeBridgeApiDeps {
  core: NativeCore;
  log?(msg: string): void;
}

export function createNativeBridgeApi(deps: NativeBridgeApiDeps): BridgeApiLike {
  const dispatch = async (intent: Intent): Promise<boolean> => {
    try {
      await deps.core.dispatch(intent);
      return true;
    } catch (err) {
      deps.log?.(`[nativeBridgeApi] dispatch failed: ${err}`);
      return false;
    }
  };

  return {
    // Rust's Router owns inbound routing and the outbox lifecycle entirely
    // under full F2b native mode, so none of these three are ever actually
    // called — they exist only so BridgeApiLike is satisfied for the tests
    // and the F1 in-process-runtime branch (main.tsx) still typed against it.
    diagnostics: { decryptFailures: 0, decodeFailures: 0, invalid: [] },
    input: () => Promise.resolve(false),
    ingest: () => {},
    dispatchDecoded: () => {},

    // The only real call sites (permission/plan-approval/question cards)
    // send exactly these three message types — each already has its own
    // Intent (confirmed by search across src/ui/transcript/rows).
    send: (_machinePubkey, msg: PhoneToBridgeMessage) => {
      const machine = _machinePubkey;
      switch (msg.type) {
        case 'permission-res':
          return dispatch({
            respondPermission: {
              machine,
              sessionId: msg.sessionId,
              requestId: msg.requestId,
              allow: msg.allow,
              modifier: msg.modifier ?? null,
            },
          });
        case 'keypress':
          return dispatch({
            keypress: { machine, sessionId: msg.sessionId, key: msg.key, context: msg.context ?? null },
          });
        case 'question-input':
          return dispatch({
            answerQuestion: {
              machine,
              sessionId: msg.sessionId,
              text: msg.text,
              optionCount: msg.optionCount,
            },
          });
        default:
          deps.log?.(`[nativeBridgeApi] send: no Intent mapping for message type "${msg.type}"`);
          return Promise.resolve(false);
      }
    },

    createSession: (machine, opts = {}) =>
      dispatch({
        createSession: {
          machine,
          cwd: opts.cwd ?? null,
          createCwd: opts.createCwd ?? null,
          model: opts.model ?? null,
          defaultEffort: opts.defaultEffort ?? null,
          providerId: opts.providerId ?? null,
          testSession: opts.testSession ?? null,
        },
      }),
    refreshSessions: (machine) => dispatch({ refreshSessions: { machine } }),
    closeSession: (machine, sessionId) => dispatch({ closeSession: { machine, sessionId } }),
    interrupt: (machine, sessionId) => dispatch({ interrupt: { machine, sessionId } }),
    permissionResponse: (machine, sessionId, requestId, allow, modifier) =>
      dispatch({
        respondPermission: { machine, sessionId, requestId, allow, modifier: modifier ?? null },
      }),
    keypress: (machine, sessionId, key, context) =>
      dispatch({ keypress: { machine, sessionId, key, context: context ?? null } }),
    questionInput: (machine, sessionId, text, optionCount) =>
      dispatch({ answerQuestion: { machine, sessionId, text, optionCount } }),
    modeChange: (machine, sessionId, mode) => dispatch({ setMode: { machine, sessionId, mode } }),
    effortChange: (machine, sessionId, level) => dispatch({ setEffort: { machine, sessionId, level } }),
    modelChange: (machine, sessionId, model) => dispatch({ setModel: { machine, sessionId, model } }),
    usageRequest: (machine, sessionId) => dispatch({ requestUsage: { machine, sessionId } }),
    gsdRequest: (machine, sessionId) => dispatch({ requestGsd: { machine, sessionId } }),
    modelsRequest: (machine) => dispatch({ requestModels: { machine } }),

    setCredentials: (machine, creds) =>
      dispatch({
        setCredentials: {
          machine,
          ...(creds.anthropicApiKey !== undefined ? { anthropicApiKey: creds.anthropicApiKey } : {}),
          ...(creds.githubPat !== undefined ? { githubPat: creds.githubPat } : {}),
        },
      }),
    setProviderProfile: (machine, profileId, profile) =>
      dispatch({ setProviderProfile: { machine, profileId, profile: profile ?? null } }),
    requestProviderProfiles: (machine) => dispatch({ requestProviderProfiles: { machine } }),
    setDeviceConfig: (machine, config) => dispatch({ setDeviceConfig: { machine, config } }),

    createFolder: (_machine, _path, _root, _timeoutMs) =>
      Promise.resolve({
        type: 'folder-ack',
        requestId: '',
        success: false,
        error: 'createFolder is not supported by the native bridge API yet — no Intent exists for it',
      }),
    uploadImageBlossom: () =>
      Promise.reject(
        new Error(
          'uploadImageBlossom is not supported by the native bridge API — dispatch sendSessionImage directly instead of going through sendSessionImage()/BridgeApi',
        ),
      ),
    uploadImageChunk: () =>
      Promise.reject(
        new Error(
          'uploadImageChunk is not supported by the native bridge API — dispatch sendSessionImage directly instead of going through sendSessionImage()/BridgeApi',
        ),
      ),
  };
}
