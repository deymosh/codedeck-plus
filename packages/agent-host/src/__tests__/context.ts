/**
 * A SessionContext that records what a driver session reports and answers
 * its requests with scripted handlers — the bridge's side, for driver tests.
 */
import type { SessionContext } from '../driver';
import type {
  OptionChoice,
  OutputEntry,
  PermissionRequest,
  QuestionOutcome,
  QuestionSpec,
  SelectOutcome,
  SessionEvent,
} from '../types';

export interface Handlers {
  permission?: (request: Omit<PermissionRequest, 'sessionId'>) => SelectOutcome | Promise<SelectOutcome>;
  question?: (requestId: string, questions: QuestionSpec[]) => QuestionOutcome | Promise<QuestionOutcome>;
  plan?: (requestId: string, options: OptionChoice[]) => SelectOutcome | Promise<SelectOutcome>;
  tool?: (tool: string, args: Record<string, unknown>) => { text: string; isError: boolean };
}

export interface RecordingContext extends SessionContext {
  events: SessionEvent[];
  permissions: Array<Omit<PermissionRequest, 'sessionId'>>;
  questions: Array<{ requestId: string; questions: QuestionSpec[] }>;
  plans: Array<{ requestId: string; options: OptionChoice[] }>;
  logs: string[];
  /** Every entry reported so far, in order. */
  entries(): OutputEntry[];
  /** Resolves with the `ended` event (rejects after `timeoutMs`). */
  ended(timeoutMs?: number): Promise<Extract<SessionEvent, { type: 'ended' }>>;
  /** Resolves once an event matching `pred` has been reported. */
  waitFor(pred: (e: SessionEvent) => boolean, timeoutMs?: number): Promise<SessionEvent>;
}

const DENY: SelectOutcome = { outcome: 'selected', optionId: 'deny' };

export function recordingContext(handlers: Handlers = {}, sessionId = 's1'): RecordingContext {
  const waiters: Array<{ pred: (e: SessionEvent) => boolean; resolve: (e: SessionEvent) => void }> = [];
  const ctx: RecordingContext = {
    sessionId,
    events: [],
    permissions: [],
    questions: [],
    plans: [],
    logs: [],
    emit(event) {
      ctx.events.push(event);
      for (const w of [...waiters]) {
        if (w.pred(event)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(event);
        }
      }
    },
    async requestPermission(request) {
      ctx.permissions.push(request);
      return handlers.permission ? handlers.permission(request) : DENY;
    },
    async askQuestion(requestId, questions) {
      ctx.questions.push({ requestId, questions });
      return handlers.question ? handlers.question(requestId, questions) : { outcome: 'cancelled', reason: 'no handler' };
    },
    async requestPlanApproval(requestId, options) {
      ctx.plans.push({ requestId, options });
      return handlers.plan ? handlers.plan(requestId, options) : { outcome: 'cancelled', reason: 'no handler' };
    },
    async callHostTool(tool, args) {
      return handlers.tool ? handlers.tool(tool, args) : { text: 'no tool', isError: true };
    },
    log(message) {
      ctx.logs.push(message);
    },
    entries() {
      return ctx.events.flatMap((e) => (e.type === 'entries' ? e.entries : []));
    },
    waitFor(pred, timeoutMs = 2000) {
      const seen = ctx.events.find(pred);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for a session event')), timeoutMs);
        waiters.push({
          pred,
          resolve: (e) => {
            clearTimeout(timer);
            resolve(e);
          },
        });
      });
    },
    async ended(timeoutMs) {
      return (await ctx.waitFor((e) => e.type === 'ended', timeoutMs)) as Extract<SessionEvent, { type: 'ended' }>;
    },
  };
  return ctx;
}
