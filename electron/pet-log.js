import fs from 'node:fs';
import path from 'node:path';

/**
 * A trace of the desktop pet's drag lifecycle.
 *
 * Three fixes have shipped for "the pet drifts" and each one was a real bug
 * that was not *the* bug. Every measurement so far has been taken on a machine
 * where the gesture could not be reproduced, so this stops guessing: it records
 * what actually happens on the user's own drags, and the log gets read back.
 *
 * Written for someone reading it later:
 *
 * - one line per event, timestamped, with a monotonic millisecond offset from
 *   the start of the session so gaps are readable without subtracting clocks;
 * - buffered and flushed on a timer, because a drag emits a line every few
 *   frames and a synchronous write per line would itself change the timing
 *   being measured;
 * - truncated at a megabyte on open, so leaving it on cannot fill a disk.
 */

/** Above this, the file is started fresh rather than appended to. */
const MAX_BYTES = 1024 * 1024;

/** How long lines may sit in memory before being written. */
const FLUSH_MS = 400;

let logPath = null;
let started = 0;
let buffer = [];
let flushTimer = null;

export function openDragLog(userDataPath) {
  logPath = path.join(userDataPath, 'pet-drag.log');
  started = Date.now();

  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > MAX_BYTES) {
      fs.rmSync(logPath, { force: true });
    }
    fs.appendFileSync(logPath, `\n=== session ${new Date().toISOString()} ===\n`);
  } catch {
    // A log that cannot be written must never stop the pet from working.
    logPath = null;
  }
}

function flush() {
  flushTimer = null;
  if (!logPath || buffer.length === 0) return;

  const lines = buffer.join('');
  buffer = [];
  fs.appendFile(logPath, lines, () => {});
}

/**
 * Records one event.
 *
 * `name` is a short verb, `fields` is anything JSON can hold. Keep both small:
 * the point is a file someone can scan, not a structured feed.
 */
export function logDrag(name, fields = {}) {
  if (!logPath) return;

  const offset = String(Date.now() - started).padStart(7);
  buffer.push(`${offset}ms ${name} ${JSON.stringify(fields)}\n`);

  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}

/** Writes anything still buffered. Called before the app goes away. */
export function closeDragLog() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (!logPath || buffer.length === 0) return;

  try {
    fs.appendFileSync(logPath, buffer.join(''));
  } catch {
    // Quitting matters more than the last few lines of a debug log.
  }
  buffer = [];
}
