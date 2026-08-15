import type { NormalizedMessage, PendingPermission } from '@/shared/types.js';

/**
 * How many events one session keeps for replay.
 *
 * Sized to cover a refresh in the middle of a long agentic run. Beyond this
 * the client refetches history instead, which is correct — replay exists to
 * bridge a gap of seconds, not to be a transcript store.
 */
const REPLAY_BUFFER_LIMIT = 5000;

/** How long a finished run stays available for late reconnects. */
const COMPLETED_RUN_TTL_MS = 5 * 60 * 1000;

type Run = {
  sessionId: string;
  status: 'running' | 'completed';
  lastSeq: number;
  events: NormalizedMessage[];
  pendingPermissions: Map<string, PendingPermission>;
  abort: () => void;
  completedAt: number | null;
};

type Listener = (event: NormalizedMessage) => void;

/**
 * Owns the lifecycle of in-flight chat runs.
 *
 * Three responsibilities that are easy to get subtly wrong separately and are
 * therefore kept together: monotonic sequencing (so a client can say "I have
 * up to N"), bounded replay (so a refresh mid-run recovers), and the
 * guarantee that exactly one terminal `complete` is delivered per run (so the
 * spinner cannot leak).
 */
export function createRunRegistry() {
  const runs = new Map<string, Run>();
  const listeners = new Set<Listener>();

  /** Drops finished runs whose replay window has expired. */
  const evictExpiredRuns = () => {
    const now = Date.now();
    for (const [sessionId, run] of runs) {
      if (run.status === 'completed' && run.completedAt !== null
        && now - run.completedAt > COMPLETED_RUN_TTL_MS) {
        runs.delete(sessionId);
      }
    }
  };

  const emit = (event: NormalizedMessage) => {
    for (const listener of listeners) listener(event);
  };

  return {
    /** Subscribes to every sequenced event. Returns an unsubscribe function. */
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    isRunning(sessionId: string): boolean {
      return runs.get(sessionId)?.status === 'running';
    },

    /**
     * Begins a run, or returns null if one is already in flight.
     *
     * Rejecting rather than queueing is intentional: two concurrent runs on
     * one conversation would interleave into the same transcript.
     */
    startRun(sessionId: string, abort: () => void): Run | null {
      evictExpiredRuns();
      const existing = runs.get(sessionId);
      if (existing?.status === 'running') return null;

      const run: Run = {
        sessionId,
        status: 'running',
        // Sequence continues across runs within a session so a client's
        // `lastSeq` stays meaningful after a completed run.
        lastSeq: existing?.lastSeq ?? 0,
        events: existing?.events ?? [],
        pendingPermissions: new Map(),
        abort,
        completedAt: null,
      };
      runs.set(sessionId, run);
      return run;
    },

    /** Stamps an event with the next sequence number, buffers it, and emits it. */
    record(sessionId: string, event: NormalizedMessage): NormalizedMessage | null {
      const run = runs.get(sessionId);
      if (!run) return null;

      // A second terminal event means the runtime's own exit handler raced an
      // abort. The first one wins; the duplicate is dropped.
      if (event.kind === 'complete' && run.status === 'completed') return null;

      run.lastSeq += 1;
      const sequenced: NormalizedMessage = { ...event, sessionId, seq: run.lastSeq };

      run.events.push(sequenced);
      if (run.events.length > REPLAY_BUFFER_LIMIT) {
        run.events.splice(0, run.events.length - REPLAY_BUFFER_LIMIT);
      }

      if (event.kind === 'complete') {
        run.status = 'completed';
        run.completedAt = Date.now();
        run.pendingPermissions.clear();
      }

      emit(sequenced);
      return sequenced;
    },

    /** Events after `afterSeq`, for a reconnecting client. */
    replay(sessionId: string, afterSeq = 0): NormalizedMessage[] {
      const run = runs.get(sessionId);
      if (!run) return [];
      return run.events.filter((event) => (event.seq ?? 0) > afterSeq);
    },

    abortRun(sessionId: string): boolean {
      const run = runs.get(sessionId);
      if (!run || run.status !== 'running') return false;
      run.abort();
      return true;
    },

    addPendingPermission(sessionId: string, permission: PendingPermission): void {
      runs.get(sessionId)?.pendingPermissions.set(permission.requestId, permission);
    },

    removePendingPermission(sessionId: string, requestId: string): void {
      runs.get(sessionId)?.pendingPermissions.delete(requestId);
    },

    /** Re-delivered on subscribe so a refresh does not strand a waiting agent. */
    listPendingPermissions(sessionId: string): PendingPermission[] {
      return [...(runs.get(sessionId)?.pendingPermissions.values() ?? [])];
    },
  };
}

export type RunRegistry = ReturnType<typeof createRunRegistry>;

/** The process-wide registry used by the chat gateway and the SDK runtime. */
export const runRegistry = createRunRegistry();
