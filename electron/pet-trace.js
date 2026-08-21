import fs from 'node:fs';

/**
 * A record of what the pet window believed, and when.
 *
 * ## Why a log rather than another fix
 *
 * "The pet is on screen but cannot be pressed" has now been reported by six
 * routes. Every previous round reasoned about which of the half-dozen sticky
 * flags — the shell's `carrying`, `interactive`, `hidden`, `suppressed`,
 * `hasPet`, the page's `dragging` and `pointerOver` — had gone wrong, shipped a
 * repair for that one, and got the next report by a route nobody had listed.
 *
 * The `pet-invariant` harness answered that for the paths it knows. What it
 * cannot do is tell us which flag is wrong on *the machine where it happens*,
 * during the navigation that provokes it — and that is the only question left.
 * So the state is written down instead of inferred.
 *
 * Off unless `TAILS_PET_TRACE` names a file, and cheap when off: one falsy
 * check per call. Line-buffered JSONL because the interesting case is a state
 * that never recovers, so the process is often still running when the log is
 * read.
 */

const target = process.env.TAILS_PET_TRACE || '';
let stream = null;

if (target) {
  try {
    stream = fs.createWriteStream(target, { flags: 'a' });
    stream.write(`${JSON.stringify({ at: Date.now(), event: 'trace-open' })}\n`);
  } catch {
    stream = null;
  }
}

export const tracing = Boolean(stream);

/**
 * One line per state change.
 *
 * Callers pass the whole state, not a delta: reconstructing a state machine
 * from deltas is how a log ends up needing its own debugging.
 */
export function trace(event, state) {
  if (!stream) return;
  try {
    stream.write(`${JSON.stringify({ at: Date.now(), event, ...state })}\n`);
  } catch {
    // A log that cannot be written must not take the feature with it.
  }
}
