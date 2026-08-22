/**
 * Marmot platform seam (CDX-012) — `MarmotPlatform` over the Tauri
 * `marmot_*` commands (src-tauri/src/marmot.rs, the MDK engine).
 *
 * Same degrade discipline as mesh/stt: under Tauri (Android AND desktop — the
 * Rust engine ships in both) the real seam is returned; in plain-browser dev
 * `createMarmotPlatform` returns null and the marmot store stays unavailable
 * (the UI shows NIP-17 only).
 *
 * Every command result crosses the boundary as untyped JSON — zod-parsed here
 * (zod 3) so a Rust/JS drift fails loudly at the seam, not deep in the store.
 * The identity secret passes through `init` exactly once per run and is never
 * logged.
 */
import { z } from 'zod';
import type { NostrEvent } from 'nostr-tools/core';
import type {
  MarmotGroupCreated,
  MarmotGroupInfo,
  MarmotIngested,
  MarmotOutgoing,
  MarmotPlatform,
  MarmotWelcomeInfo,
} from '../core/stores/marmot';
import type { Logger } from '../core/ports';

// --- zod schemas for the Rust (snake_case) command results ---

const eventJsonSchema = z.string().transform((raw, ctx): NostrEvent => {
  try {
    return JSON.parse(raw) as NostrEvent;
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'unparseable event JSON' });
    return z.NEVER;
  }
});

const groupInfoSchema = z.object({
  group_id: z.string(),
  h_tag: z.string(),
  name: z.string(),
  members: z.array(z.string()),
  admins: z.array(z.string()),
  active: z.boolean(),
});

const welcomeInfoSchema = z.object({
  welcome_id: z.string(),
  wrapper_id: z.string(),
  group_id: z.string(),
  h_tag: z.string(),
  name: z.string(),
  welcomer: z.string(),
  member_count: z.number(),
});

const groupCreatedSchema = z.object({
  group_id: z.string(),
  h_tag: z.string(),
  welcome_event_json: eventJsonSchema,
});

const outgoingSchema = z.object({
  event_json: eventJsonSchema,
  rumor_id: z.string(),
  created_at: z.number(),
});

const ingestedSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('welcome'),
    welcome_id: z.string(),
    wrapper_id: z.string(),
    group_id: z.string(),
    h_tag: z.string(),
    name: z.string(),
    welcomer: z.string(),
    member_count: z.number(),
  }),
  z.object({
    type: z.literal('message'),
    group_id: z.string(),
    id: z.string(),
    sender: z.string(),
    kind: z.number(),
    content: z.string(),
    created_at: z.number(),
  }),
  z.object({ type: z.literal('not_joined'), h_tag: z.string() }),
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('ignored'), reason: z.string() }),
]);

const toGroupInfo = (g: z.infer<typeof groupInfoSchema>): MarmotGroupInfo => ({
  groupId: g.group_id,
  hTag: g.h_tag,
  name: g.name,
  members: g.members,
  admins: g.admins,
  active: g.active,
});

const toWelcomeInfo = (w: z.infer<typeof welcomeInfoSchema>): MarmotWelcomeInfo => ({
  welcomeId: w.welcome_id,
  wrapperId: w.wrapper_id,
  groupId: w.group_id,
  hTag: w.h_tag,
  name: w.name,
  welcomer: w.welcomer,
  memberCount: w.member_count,
});

const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** Exported for tests: the seam over an injectable invoke. */
export function marmotPlatformOverInvoke(invoke: Invoke): MarmotPlatform {
  return {
    init: async (secretHex) => invoke<string>('marmot_init', { secretHex }),

    publishKeyPackage: async (relays) =>
      eventJsonSchema.parse(
        await invoke<string>('marmot_publish_key_package', { relays: [...relays] }),
      ),

    createGroup: async (peerPubkey, peerKeyPackage, relays): Promise<MarmotGroupCreated> => {
      const raw = await invoke<unknown>('marmot_create_group', {
        peerPubkey,
        peerKeyPackageJson: JSON.stringify(peerKeyPackage),
        relays: [...relays],
      });
      const parsed = groupCreatedSchema.parse(raw);
      return {
        groupId: parsed.group_id,
        hTag: parsed.h_tag,
        welcomeEvent: parsed.welcome_event_json,
      };
    },

    send: async (groupId, text): Promise<MarmotOutgoing> => {
      const parsed = outgoingSchema.parse(
        await invoke<unknown>('marmot_send', { groupId, text }),
      );
      return {
        event: parsed.event_json,
        rumorId: parsed.rumor_id,
        createdAt: parsed.created_at,
      };
    },

    ingest: async (event): Promise<MarmotIngested> => {
      const raw = await invoke<unknown>('marmot_ingest', {
        eventJson: JSON.stringify(event),
      });
      const parsed = ingestedSchema.parse(raw);
      switch (parsed.type) {
        case 'welcome':
          return {
            type: 'welcome',
            welcome: {
              welcomeId: parsed.welcome_id,
              wrapperId: parsed.wrapper_id,
              groupId: parsed.group_id,
              hTag: parsed.h_tag,
              name: parsed.name,
              welcomer: parsed.welcomer,
              memberCount: parsed.member_count,
            },
          };
        case 'message':
          return {
            type: 'message',
            groupId: parsed.group_id,
            id: parsed.id,
            sender: parsed.sender,
            kind: parsed.kind,
            content: parsed.content,
            createdAt: parsed.created_at,
          };
        case 'not_joined':
          return { type: 'not_joined', hTag: parsed.h_tag };
        case 'none':
          return { type: 'none' };
        case 'ignored':
          return { type: 'ignored', reason: parsed.reason };
      }
    },

    pendingWelcomes: async () =>
      z.array(welcomeInfoSchema).parse(await invoke<unknown>('marmot_pending_welcomes')).map(toWelcomeInfo),

    acceptWelcome: async (welcomeId) =>
      toGroupInfo(
        groupInfoSchema.parse(await invoke<unknown>('marmot_accept_welcome', { welcomeId })),
      ),

    listGroups: async () =>
      z.array(groupInfoSchema).parse(await invoke<unknown>('marmot_list_groups')).map(toGroupInfo),
  };
}

/** The production seam: real under Tauri, null in plain-browser dev. */
export async function createMarmotPlatform(log?: Logger): Promise<MarmotPlatform | null> {
  if (!isTauri()) {
    log?.('[Marmot] no Tauri runtime — Marmot DMs unavailable (NIP-17 only)');
    return null;
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return marmotPlatformOverInvoke(invoke);
}
