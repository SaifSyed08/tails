import fs from 'node:fs/promises';

import { readLocalUrl } from '@/modules/preview/preview.tools.js';
import { LIMITS, type Watch } from '@/modules/surface/widget-spec.js';

/**
 * What keeps a monitor monitoring once the turn is over.
 *
 * The agent can only redraw a panel while it is running. A monitor without this
 * is a label that says "watching" and then stops — frozen at exactly the moment
 * the user walked away, which is the moment the whole feature is for.
 *
 * ## Read-only, on purpose
 *
 * Two sources, both of which look and neither of which acts. See the note on
 * `watchSchema` in `widget-spec.ts` for why there is no command source: a shell
 * command on a repeating timer is a standing grant to execute, and there is no
 * turn for it to be approved inside.
 *
 * ## The probe is separate from the decision
 *
 * `probeHttp`/`probeFile` touch the outside world and `decide` does not, so the
 * part with the rules — what counts as a match, what an unreachable service
 * means, when a file has changed rather than merely been looked at — is a pure
 * function with tests. The alternative is a feature whose behaviour can only be
 * checked by standing up a server and waiting five seconds.
 */

/** How much of a response body is read before giving up on finding a phrase. */
const MAX_BODY_BYTES = 64 * 1024;

/** A single fetch may not hold a watcher's tick open longer than this. */
const PROBE_TIMEOUT_MS = 2_000;

/** What a look at the world found. Deliberately small and serialisable. */
export type Probe =
  | { ok: false; reason: string }
  | { ok: true; kind: 'http'; status: number; body: string }
  | { ok: true; kind: 'file'; changedAt: string; bytes: number };

/** The fields a tick may change on the monitor it belongs to. */
export type MonitorPatch = {
  status: 'watching' | 'match' | 'error';
  detail: string;
  match?: string;
};

/**
 * What a probe means for the monitor showing it.
 *
 * `seen` is what the previous tick recorded — the last file timestamp, or the
 * last body that matched — so a change can be told from a state. Without it a
 * file that changed once would report a match for ever, and a monitor that
 * never stops celebrating has stopped being a signal.
 */
export function decide(probe: Probe, watch: Watch, seen: string | null): MonitorPatch {
  if (!probe.ok) return { status: 'error', detail: probe.reason };

  if (probe.kind === 'http') {
    if (probe.status >= 400) {
      return { status: 'error', detail: `Answered ${probe.status}.` };
    }
    if (watch.source !== 'http' || !watch.expect) {
      return { status: 'watching', detail: `Answering ${probe.status}.` };
    }
    if (!probe.body.includes(watch.expect)) {
      return { status: 'watching', detail: `Answering ${probe.status}, no sign of it yet.` };
    }
    // The line it appeared on, not the whole body: a match is worth reading and
    // 64 KB of HTML is not.
    const line = probe.body
      .split('\n')
      .find((candidate) => candidate.includes(watch.expect as string))
      ?.trim() ?? watch.expect;

    return { status: 'match', detail: `Found "${watch.expect}".`, match: line.slice(0, 200) };
  }

  // A file that has not moved since the last look is not news. The first look
  // establishes the baseline rather than reporting one.
  if (seen === null) {
    return { status: 'watching', detail: `Watching. Last changed ${probe.changedAt}.` };
  }
  if (seen === probe.changedAt) {
    return { status: 'watching', detail: `No change since ${probe.changedAt}.` };
  }
  return {
    status: 'match',
    detail: `Changed at ${probe.changedAt}.`,
    match: `${probe.changedAt} · ${probe.bytes} bytes`,
  };
}

/** What the next tick should compare against, given what this one saw. */
export function nextSeen(probe: Probe, previous: string | null): string | null {
  if (!probe.ok) return previous;
  return probe.kind === 'file' ? probe.changedAt : previous;
}

async function probeHttp(url: string): Promise<Probe> {
  // Loopback only, checked on the parsed hostname — the same guard, and the
  // same reasoning, as the preview pane. A watcher is a repeating request made
  // while nobody is looking, which is the last place to relax it.
  const safe = readLocalUrl(url);
  if (!safe) return { ok: false, reason: 'Only addresses on this machine can be watched.' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(safe, { signal: controller.signal });
    const raw = await response.text();
    return { ok: true, kind: 'http', status: response.status, body: raw.slice(0, MAX_BODY_BYTES) };
  } catch {
    return { ok: false, reason: 'Not responding.' };
  } finally {
    clearTimeout(timer);
  }
}

async function probeFile(path: string): Promise<Probe> {
  try {
    const stat = await fs.stat(path);
    return { ok: true, kind: 'file', changedAt: stat.mtime.toISOString(), bytes: stat.size };
  } catch {
    return { ok: false, reason: 'Not there.' };
  }
}

const probe = (watch: Watch): Promise<Probe> => (
  watch.source === 'http' ? probeHttp(watch.url) : probeFile(watch.path)
);

type Running = {
  timer: NodeJS.Timeout;
  seen: string | null;
};

/**
 * The watchers currently running, keyed by conversation and then widget.
 *
 * Keyed by widget id rather than by index so a redraw that reorders the panel
 * does not hand one monitor another's history — the ids are minted server-side
 * per write, so in practice a redraw replaces every watcher, and that is the
 * intended behaviour: a rebuilt panel is a fresh statement of what to watch.
 */
const running = new Map<string, Map<string, Running>>();

export type WatchTick = (widgetId: string, patch: MonitorPatch) => void;

/** Stops and forgets every watcher a conversation had. */
export function stopWatchers(sessionId: string): void {
  const session = running.get(sessionId);
  if (!session) return;
  for (const entry of session.values()) clearInterval(entry.timer);
  running.delete(sessionId);
}

/**
 * Starts the watchers a freshly-shown panel asks for.
 *
 * Always preceded by `stopWatchers`, because a panel is replaced whole: leaving
 * the previous set running would mean a monitor the user can no longer see
 * still polling, and two generations of the same watcher racing to describe one
 * widget.
 */
export function startWatchers(
  sessionId: string,
  widgets: readonly { id: string; kind: string; watch?: Watch }[],
  onTick: WatchTick,
): void {
  stopWatchers(sessionId);

  const watchable = widgets
    .filter((widget) => widget.kind === 'monitor' && widget.watch)
    .slice(0, LIMITS.watchers);
  if (watchable.length === 0) return;

  const session = new Map<string, Running>();
  running.set(sessionId, session);

  for (const widget of watchable) {
    const watch = widget.watch as Watch;

    const tick = async () => {
      const entry = session.get(widget.id);
      // The panel was replaced while this tick was in flight. Reporting now
      // would write a result into a widget that no longer exists.
      if (!entry) return;

      const result = await probe(watch);
      if (!session.has(widget.id)) return;

      // The baseline this tick is judged against is the one the *previous* tick
      // left. Advancing it first would compare the file to itself, and a watched
      // file would report "no change" for ever.
      const previous = entry.seen;
      entry.seen = nextSeen(result, previous);
      onTick(widget.id, decide(result, watch, previous));
    };

    const timer = setInterval(() => { void tick(); }, watch.everyMs);
    // Nothing here should hold the process open. A watcher is a convenience
    // attached to a window; it must never be the reason the server cannot exit.
    timer.unref?.();
    session.set(widget.id, { timer, seen: null });

    // One immediate look, so a panel does not sit on "not started" for the
    // first interval. Every monitor should say something true by the time the
    // user has finished reading its label.
    void tick();
  }
}

/** For shutdown: nothing should be left ticking. */
export function stopAllWatchers(): void {
  for (const sessionId of [...running.keys()]) stopWatchers(sessionId);
}
