import { BrowserWindow, ipcMain, screen } from 'electron';
import path from 'node:path';

import { addAlert, clearAlert, describeAlerts } from './pet-alerts.js';
import { clientPointToDip, sizeForScaleFactor } from './pet-geometry.js';
import { trace, tracing } from './pet-trace.js';


/**
 * The desktop pet.
 *
 * A frameless, transparent, always-on-top window that holds one animated
 * sprite and floats over every other application. Its page is served by our own
 * server (`/api/pets/window`), which is what lets it work identically in dev
 * and packaged without a second bundler entry point.
 *
 * ## The thing that must not go wrong
 *
 * The window is a transparent rectangle. If it swallows clicks, the user's
 * desktop stops working and the app looks like it broke the machine — so the
 * window ignores mouse events by default (`forward: true`, which still delivers
 * move events) and only becomes clickable while the pointer is over the pet's
 * **opaque pixels**, which the page hit-tests against the sprite's alpha.
 *
 * Two things guard the failure mode where it gets stuck interactive:
 *
 * - the page reports `over: false` on `mouseleave` as well as on move, and
 * - this module runs a watchdog while interactive and forces click-through back
 *   on as soon as the cursor is outside the window, even if no event arrived.
 *
 * Both exist because the consequence of missing one event is not a cosmetic
 * glitch — it is a rectangle of dead desktop the user cannot get rid of.
 */

/** Fallback size before the page reports the sprite's real box. */
const DEFAULT_SIZE = { width: 160, height: 180 };

/**
 * The largest this window may ever be.
 *
 * Generous next to the ~143x152 a pet actually needs, and far below the sizes a
 * scaling bug produces. Its job is to keep a geometry fault visible and
 * harmless instead of leaving a screen-sized transparent window over the
 * desktop.
 */
const MAX_WINDOW = { width: 320, height: 360 };

/**
 * Quiet time after the last move before the pet is considered put down.
 *
 * The OS move loop reports no beginning and no end, only positions, so the drop
 * is inferred. Long enough to survive a pause mid-drag, short enough that the
 * pet stops running promptly once it is set down.
 */
const SETTLE_MS = 220;

/**
 * How long an app-driven carry survives without a new frame, in ms.
 *
 * A carry the app is driving has no natural end — the shell cannot see the hand
 * open — so there has to be a floor under it. Placements arrive every frame
 * while a hand is moving, so this is refreshed long before it can fire during a
 * real drag; what it catches is the drag that ends without a final word, which
 * otherwise leaves a carry running forever. That state is the worst this window
 * has: the page stops watching the pointer and the shell stops polling for it,
 * so nothing can make the window clickable again.
 */
const HOLD_TIMEOUT_MS = 2000;

/**
 * How recently a carry frame must have arrived for the carry to count as live.
 *
 * Used where being wrong is expensive rather than untidy: deciding whether a
 * window being shown is mid-handoff, and so whether to leave its input state
 * alone instead of putting it back together.
 */
const HOLD_FRESH_MS = 400;

/**
 * How far the OS may disagree with our record before we believe the OS.
 *
 * A DIP round trip loses at most a pixel on a fractionally scaled display, so
 * anything larger is not rounding — it is the record having come adrift.
 */
const POSITION_TOLERANCE = 2;

/** How often to check that an interactive window still has the pointer over it. */
const WATCHDOG_INTERVAL_MS = 250;


let petWindow = null;
let readState = () => ({});
let writeState = () => {};
let onOpenPetDetails = () => {};
let onOpenSession = () => {};
let onDockPet = () => {};
let onToggleVoice = () => {};

/**
 * Whether the app is showing a conversation this pet lives in.
 *
 * Reported by the renderer, because only it can answer: the question is whether
 * the pet on the desktop is the one assigned to the chat on screen. Held here so
 * the pet page can be told, and re-told whenever either window moves.
 */
let dockable = false;

/** Where the app's window is, for pointing the arrow at it. */
let appBounds = null;

/**
 * Conversations that finished while the user was elsewhere.
 *
 * Held here rather than in the renderer because the pet has to be able to say
 * so while the app is minimised, and here rather than in the pet page because
 * the page is reloaded whenever the active pet changes — an announcement should
 * survive the pet changing his shirt.
 */
let alerts = [];

/** Set by the page: whether a pet is active at all. */
let hasPet = false;
/** The user's own choice, persisted. The context menu's Hide. */
let hidden = false;
/**
 * Set by the app when an in-window pet takes over.
 *
 * Separate from `hidden` on purpose: a handoff is temporary and must not
 * overwrite a preference the user set deliberately.
 */
let suppressed = false;

/**
 * Where the window is, according to us.
 *
 * The authoritative value, because the OS is not one. On this display
 * (scaleFactor 1.03) `setPosition(x, y)` followed by `getPosition()` returns
 * `x-1, y-1` at many coordinates — every DIP is a fractional number of device
 * pixels, and the round trip rounds. That is harmless once, and cumulative when
 * each drag re-derives its grab offset from the value read back: the pet ends
 * up sitting a pixel lower relative to the pointer every time it is picked up,
 * until the grab point is off the sprite entirely and it cannot be picked up at
 * all.
 *
 * So `setPosition` is write-only. Everything that needs to know where the pet
 * is asks this variable.
 */
let trackedPosition = null;

/**
 * True while the OS is moving the window for us.
 *
 * There is no drag loop any more: the sprite carries a `-webkit-app-region`
 * handle, so Windows performs the move and we learn of it through the window's
 * own `move` events. This flag is for the two things that must stand back
 * during a gesture — the click-through watchdog and the resize handler.
 */
let carrying = false;
/**
 * Who is doing the carrying: the OS, or us.
 *
 * They need different treatment in one place. A resize during an OS drag is the
 * old feedback loop and is refused; a resize during an app-driven flight is the
 * window catching up with a pet who has just been activated, and refusing it is
 * what draws the new sheet at the old pet's size — a sprite cut off mid-row.
 */
let carrySource = null;
/**
 * When the last carry frame arrived.
 *
 * A carry the app is driving has no natural end — the shell cannot see the hand
 * open — so "is he still being carried" has to be a question about *recency*
 * rather than about a flag. A flag that is only ever cleared by a message is a
 * flag that stays set when the message does not come, and a stuck carry is the
 * worst state this window has: the page stops watching the pointer and the
 * shell stops polling for it, so nothing can make the window clickable again.
 */
let lastCarryAt = 0;

/**
 * The size the page last asked for, in its own CSS pixels.
 *
 * Kept because the window's size is not only the page's business: the same
 * sprite needs a different number of DIPs on a differently scaled display, so
 * the request has to be re-applied whenever he moves between them.
 */
let reportedSize = null;
let carryFacing = null;
let carryFrom = null;
let settleTimer = null;

let interactive = false;
let watchdogTimer = null;
/** Frames since the current drag began, so the trace can sample rather than flood. */

/**
 * Three drag mechanisms, switchable at runtime.
 *
 * Four fixes have shipped for "the pet drifts" and the trace now shows the
 * window tracking the cursor to the pixel for an entire gesture — so the
 * remaining disagreement is between what we believe the position is and what
 * is actually drawn, and arguing about which read is authoritative has not
 * settled it. These are the three candidate answers, running side by side, so
 * the question can be decided by looking instead of by reasoning.
 *
 *   1 `tracked`   Baseline from our own record. `setPosition` is write-only and
 *                 the OS is never asked. Correct if the OS read-back is lossy.
 *
 *   2 `os`        Baseline from `getPosition()` at grab time. Correct if the OS
 *                 is telling the truth about where the window really is and our
 *                 record is the thing that has drifted.
 *
 *   3 `closed`    Baseline from the OS, then every frame reads back where the
 *                 window actually landed and folds the error into the next
 *                 target. Self-correcting: converges even if each individual
 *                 write loses a fraction, at the cost of one extra read per
 *                 frame. Correct if the loss is real but unpredictable.
 */
/** Accumulated write error, mode 3 only. Reset at the start of every drag. */
let saveTimer = null;

function isAlive() {
  return petWindow && !petWindow.isDestroyed();
}

/**
 * Everything the shell believes about this window, in one object.
 *
 * The whole state rather than the interesting field, because which field is
 * interesting is exactly what is not known — see `pet-trace.js`. Paired with
 * the page's own published beliefs (`publishState` in `desktop-window.ts`), the
 * two halves of every "visible but unusable" report can be read side by side
 * instead of argued about.
 */
function snapshot() {
  return {
    hasPet,
    hidden,
    suppressed,
    shouldShow: shouldShow(),
    visible: isAlive() ? petWindow.isVisible() : null,
    movable: isAlive() ? petWindow.isMovable() : null,
    onTop: isAlive() ? petWindow.isAlwaysOnTop() : null,
    interactive,
    carrying,
    carrySource,
    carryLive: carryIsLive(),
    sinceCarry: carrying ? Date.now() - lastCarryAt : null,
    watchdog: watchdogTimer !== null,
    settle: settleTimer !== null,
    ...geometrySnapshot(),
  };
}

/**
 * Where this window is, according to everyone who has an opinion.
 *
 * Added because of the one clue that survived every other theory: "Recall pet"
 * makes an unusable pet usable again, and the only thing Recall does that an
 * ordinary show does not is **move the window**. That points at geometry rather
 * than at any of the flags, so the flags are no longer the interesting part.
 *
 * Three views, deliberately side by side, because the failure this is looking
 * for is them disagreeing: our own record, the window's own bounds, and the
 * display the shell believes he is standing on. A pointer that lands on the pet
 * on screen but arrives at the page as a coordinate somewhere else is a pet who
 * cannot be hovered, cannot be pressed, and looks completely fine.
 */
function geometrySnapshot() {
  if (!isAlive()) return {};

  const bounds = petWindow.getBounds();
  const content = petWindow.getContentBounds();
  const at = trackedPosition;
  const display = screen.getDisplayNearestPoint({ x: content.x, y: content.y });

  return {
    tracked: at ? `${at.x},${at.y}` : null,
    bounds: `${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`,
    content: `${content.x},${content.y} ${content.width}x${content.height}`,
    reported: reportedSize ? `${reportedSize.width}x${reportedSize.height}` : null,
    // The two numbers `sizeForScaleFactor` multiplies by, which is where a
    // window twice the size of the sprite inside it comes from.
    scale: `${screen.getPrimaryDisplay().scaleFactor} -> ${display.scaleFactor}`,
    onDisplay: `${display.id}`,
    drift: at ? Math.max(Math.abs(bounds.x - at.x), Math.abs(bounds.y - at.y)) : null,
  };
}

/**
 * Counters, kept out of the change test.
 *
 * "Is the shell still asking the page where the pointer is" is the single most
 * useful thing to know about an unusable pet — a probe count that stops moving
 * says the poll gave up, one that climbs while the page never answers says the
 * page did. But a counter changes every tick, so including it in the change
 * test would make every tick a new state and fill the file with nothing.
 */
let probesSent = 0;

/** Traces only when something moved, so a 250ms poll does not fill the file. */
let lastTraced = '';
function traceState(event) {
  if (!tracing) return;
  const state = snapshot();
  const key = JSON.stringify(state);
  if (key === lastTraced && event === 'tick') return;
  lastTraced = key;
  trace(event, { ...state, probesSent });
}

/** Moves the window and records where it now is. The only caller of `setPosition`. */
function moveTo(x, y) {
  if (!isAlive()) return;
  const next = { x: Math.round(x), y: Math.round(y) };
  if (trackedPosition && trackedPosition.x === next.x && trackedPosition.y === next.y) return;

  trackedPosition = next;
  petWindow.setPosition(next.x, next.y);

  // Then check the OS actually did it.
  //
  // The record exists because `getPosition` rounds, so a one-pixel difference
  // is expected and must be ignored — reading it back every frame is what used
  // to accumulate. A *large* difference is different in kind: the window is not
  // where we think it is, and that never recovers on its own. The next grab
  // measures against a fiction, computes a target hundreds of pixels away, and
  // strands the pet in a corner. Believing the OS at that point costs nothing.
  const [actualX, actualY] = petWindow.getPosition();
  if (Math.abs(actualX - next.x) > POSITION_TOLERANCE
    || Math.abs(actualY - next.y) > POSITION_TOLERANCE) {
    trackedPosition = { x: actualX, y: actualY };
  }
}

/** Where the pet is. Falls back to the OS only before we have ever placed it. */
function positionNow() {
  if (trackedPosition) return trackedPosition;
  const [x, y] = isAlive() ? petWindow.getPosition() : [0, 0];
  trackedPosition = { x, y };
  return trackedPosition;
}

/**
 * The size of the area the page draws into.
 *
 * Content size, not window size. On Windows a frameless transparent window
 * still carries an invisible frame — here 20px across and 32px down — so
 * `setSize(143, 152)` produces `getBounds() -> 163x184`. Comparing the page's
 * measurement against the *window* size therefore never matched, and the resize
 * handler re-sized and re-positioned the pet on every single poll, forever.
 * Content size is what the page is talking about, so it is what we ask for and
 * what we compare.
 */
function sizeNow() {
  if (!isAlive()) return { width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height };
  const [width, height] = petWindow.getContentSize();
  return { width, height };
}

/** Whether the pet should be on screen right now. */
function shouldShow() {
  return hasPet && !hidden && !suppressed;
}

function persistPosition() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (!isAlive()) return;

  const { x, y } = positionNow();
  writeState({ petWindow: { x, y, hidden } });
}


/**
 * Keeps the whole window inside the work area of the display it is on.
 *
 * The *nearest* display, not the primary one: on a multi-monitor desk the pet
 * is usually not on the primary screen, and clamping to the primary's bounds
 * would teleport it back every time it was dragged across the boundary. Work
 * area rather than bounds so it cannot hide behind the taskbar.
 */
function clampToDisplay(x, y, width, height) {
  const display = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
  const area = display.workArea;

  return {
    x: Math.round(Math.min(Math.max(x, area.x), area.x + area.width - width)),
    y: Math.round(Math.min(Math.max(y, area.y), area.y + area.height - height)),
  };
}

/** Bottom-right of the primary work area, where a desktop companion belongs. */
function defaultPosition(width, height) {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: area.x + area.width - width - 32,
    y: area.y + area.height - height - 32,
  };
}

/**
 * Restores the stored position, or picks one.
 *
 * A stored point is only used if it still lands on a display: monitors get
 * unplugged, and a pet restored to a screen that no longer exists is a pet the
 * user cannot find.
 */
function restorePosition(width, height) {
  const stored = readState().petWindow;
  const x = Number(stored?.x);
  const y = Number(stored?.y);

  if (Number.isFinite(x) && Number.isFinite(y)) {
    // Most of the window has to land on a real work area, not merely touch
    // one. The old test accepted a pet parked in the very corner — including
    // 0,0, where a bad drag used to strand it, which then survived every
    // restart because it still counted as "on screen".
    const visible = Math.round(Math.min(width, height) * 0.6);
    const reachable = screen.getAllDisplays().some((display) => {
      const area = display.workArea;
      return x + width - visible >= area.x
        && x + visible <= area.x + area.width
        && y + height - visible >= area.y
        && y + visible <= area.y + area.height;
    });

    if (reachable) return clampToDisplay(x, y, width, height);
  }

  return defaultPosition(width, height);
}

function setInteractive(next) {
  if (!isAlive() || interactive === next) return;
  interactive = next;
  traceState(next ? 'interactive-on' : 'interactive-off');

  // `forward: true` keeps move events coming while the window is transparent to
  // clicks, which is the only way the page can notice the pointer arriving.
  petWindow.setIgnoreMouseEvents(!next, { forward: true });
}

/**
 * Where the pointer is, asked rather than waited for.
 *
 * Runs the whole time the pet is on screen, in both directions:
 *
 * - **Interactive, cursor gone.** Put click-through back. The page's own
 *   `mouseleave` covers the ordinary case; this covers the ones it cannot — the
 *   pointer crossing into another application in a single frame, the page
 *   hanging, a display change moving the window out from under the cursor.
 *
 * - **Click-through, cursor inside.** Ask the page whether that point is on the
 *   pet. This is the half that stops the window deadlocking. The page normally
 *   learns the pointer has arrived from a forwarded `mousemove`, and there are
 *   places it will never get one: the drag band swallows events, so a fast
 *   movement that lands *directly* on the band skips every reporting pixel on
 *   the way in; and a pointer that teleports (a window-snap shortcut, a remote
 *   session) never crosses anything at all. In both cases the window stays
 *   click-through, so it is never hit-tested, so the band is never reached —
 *   and nothing in the page can break the tie, because the page is the thing
 *   receiving no events. The shell can see the cursor, so the shell asks.
 *
 * The alpha test still decides; this only gets the question asked.
 */
function startWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    if (!isAlive()) return;

    // The window-level half of the invariant, held continuously. See the note
    // on `assertWindowState`: it is why this poll is no longer only about the
    // cursor.
    assertWindowState();
    traceState('tick');

    /*
     * A carry that has stopped producing frames has stopped.
     *
     * `carryIsLive` is the recency rule, and it was only ever being *consulted*
     * — so between a carry going stale and its 2s safety timer firing, the
     * shell knew the hand had let go while the page was still told to ignore
     * every mouse move. That is a pet who cannot be picked up for a second and
     * a half, which is long enough to try, fail, and conclude he is broken.
     * Ending it here is what keeps the two sides from ever disagreeing by more
     * than one tick of this poll.
     */
    if (carrying && !carryIsLive()) {
      endCarry();
      return;
    }
    if (carryIsLive()) return;

    /*
     * The OS's own rectangle, not our record of it.
     *
     * This test used to mix the two: `getPosition` is the *outer* origin and
     * `getContentSize` is the drawing area, and on Windows this window carries
     * an invisible frame 20px across and 32px down. So the rectangle being
     * tested was offset from the one on screen, and the watchdog could decide
     * the pointer had left while it was sitting on the pet — which turns
     * click-through back on underneath a pointer that never went anywhere.
     */
    const cursor = screen.getCursorScreenPoint();
    const at = petWindow.getBounds();
    const inside = cursor.x >= at.x && cursor.x <= at.x + at.width
      && cursor.y >= at.y && cursor.y <= at.y + at.height;

    if (inside) {
      // The page has the pointer and answers faster than this poll can; asking
      // again would only fight it.
      if (interactive) return;

      /*
       * Deliberately no "he has been dead for N ticks, do something" rule here.
       *
       * One was written and removed, because the condition it would have to
       * watch for -- the cursor inside this window while the window stays
       * transparent to the mouse -- is the *normal* state. The window is a
       * transparent rectangle larger than the sprite, so a pointer resting in
       * the empty part of it is exactly that, and a detector built on it fires
       * constantly on a perfectly healthy pet. Only the page can tell "inside
       * the window" from "on the animal", and the page cannot know that its own
       * answer is wrong.
       */

      // Into the page's own coordinates. Zoom is pinned at 1 for this window —
      // see the guards around `setZoomLevel` — but it is read rather than
      // assumed, because a page that has been zoomed is exactly the state where
      // a coordinate silently stops meaning what it says.
      const content = petWindow.getContentBounds();
      const zoom = petWindow.webContents.getZoomFactor() || 1;
      probesSent += 1;
      petWindow.webContents.send('pet:probe', {
        x: (cursor.x - content.x) / zoom,
        y: (cursor.y - content.y) / zoom,
      });
      return;
    }

    if (!interactive) return;
    setInteractive(false);

    /*
     * And tell the page, because this decision was ours.
     *
     * The page only reports the pointer *arriving*, and it dedupes: it will not
     * re-report an arrival it believes is still in effect. So a window we made
     * click-through behind the page's back can never be made clickable again —
     * the pointer is already "on the pet" as far as the page is concerned, and
     * every later move is dropped.
     */
    petWindow.webContents.send('pet:resync');
  }, WATCHDOG_INTERVAL_MS);
}

function stopWatchdog() {
  if (!watchdogTimer) return;
  clearInterval(watchdogTimer);
  watchdogTimer = null;
}

/**
 * Moves the window with the cursor.
 *
 * Driven from the main process off `getCursorScreenPoint` rather than from
 * mouse events in the page, because the window moves with the pointer: the
 * pointer's position *inside* the page barely changes during a drag, so the
 * page cannot see the gesture it is making. Screen coordinates can.
 */
/**
 * The window moved and we did not move it.
 *
 * Which means the user is carrying it by the handle. This is the whole of the
 * drag now: no grab offset, no per-frame writes, no position arithmetic — the
 * three things that produced six rounds of bugs. What is left is telling the
 * pet which way it is going, so it can face that way and run.
 */
function onCarried(x, y, source = 'os', holding = false) {
  carrySource = source;
  lastCarryAt = Date.now();
  if (!carrying) traceState(`carry-start-${source}${holding ? '-held' : ''}`);
  if (!carrying) {
    carrying = true;
    carryFrom = { x, y };
    petWindow.webContents.send('pet:carry', true);
  }

  // Sampled: a drag emits a move event per frame and this log is for reading.

  if (Math.abs(x - carryFrom.x) > 2) {
    const direction = x < carryFrom.x ? 'left' : 'right';
    if (direction !== carryFacing) {
      carryFacing = direction;
      petWindow.webContents.send('pet:facing', direction);
    }
    carryFrom = { x, y };
  }

  /*
   * The OS reports no drop, so the end of an OS drag is inferred from the moves
   * stopping. That inference is wrong for a carry the *app* is driving: a hand
   * that holds still is still a hand holding him, and the timer firing under it
   * ended the carry, dropped him to idle, and then the next pixel of movement
   * started it again — the single frame of idle in the middle of a run.
   *
   * So a holding carry has no timer at all. The app says when it lets go.
   */
  if (settleTimer) clearTimeout(settleTimer);
  if (holding) {
    /*
     * A held carry ends when the app says so — but not *only* then.
     *
     * Placements arrive every frame while a hand is moving, so this timer is
     * refreshed long before it can fire during a real drag. What it catches is
     * the drag that ends without a final word: released back inside the chat,
     * interrupted, the renderer reloaded. Without it that carry never ends, and
     * a carry that never ends is a pet nobody can pick up again.
     */
    settleTimer = setTimeout(endCarry, HOLD_TIMEOUT_MS);
    return;
  }
  settleTimer = setTimeout(endCarry, SETTLE_MS);
}

/**
 * Whether a carry is actually happening, rather than merely flagged.
 *
 * An OS drag refreshes the flag from move events and ends 220ms after the last
 * one, so there the flag is the fact. An app-driven carry has no end the shell
 * can see, so it is only believed while its frames are still arriving —
 * otherwise a carry nobody closed keeps the pointer poll switched off, which is
 * one of the two things that leaves this window impossible to click.
 */
function carryIsLive() {
  if (!carrying) return false;
  if (carrySource !== 'app') return true;
  return Date.now() - lastCarryAt < HOLD_FRESH_MS;
}

/** The end of a carry, however it ended. */
function endCarry() {
  settleTimer = null;
  carrying = false;
  traceState('carry-end');
  carrySource = null;
  carryFacing = null;
  if (!isAlive()) return;

  petWindow.webContents.send('pet:carry', false);

  // Put down, possibly on a different screen. Rescaled here rather than during
  // the drag: mid-flight `setContentSize` is the path that cut the sprite in
  // half and, before that, fed the drift — and a pet who resizes the moment he
  // lands reads as him settling rather than as a glitch.
  applyReportedSize();
  persistPosition();
}

/**
 * Puts the window's input state back together after it has been hidden.
 *
 * A hidden window receives no forwarded mouse moves, so both sides of the
 * click-through handshake can be left holding a belief that is no longer true:
 * the page still thinking the pointer is on the pet (so it never re-reports the
 * arrival that would make the window interactive), or still thinking it is
 * mid-carry (so it stops tracking the pointer at all). Either one is a pet that
 * cannot be picked up, for the rest of the session — which is what the chat
 * handoff produced, because that path hides and re-shows the window.
 *
 * So the state is asserted rather than assumed on the way back in.
 * `setIgnoreMouseEvents` is re-applied for the same reason: it is the one piece
 * of this that lives in the OS, and re-applying it costs a call.
 */
/**
 * Sizes the window for the pet, on the display he is actually on.
 *
 * Split out of the resize message because it has three callers now: the page
 * asking, the pet being put down somewhere else, and the desktop itself being
 * rearranged. All three are the same question â€” how many DIPs is this sprite
 * here â€” and the answer moved the day multi-monitor came up.
 */
function applyReportedSize() {
  if (!isAlive() || !reportedSize) return;

  const at = positionNow();
  const was = sizeNow();
  const display = screen.getDisplayNearestPoint({
    x: Math.round(at.x + was.width / 2),
    y: Math.round(at.y + was.height / 2),
  });
  const { width, height } = sizeForScaleFactor(
    reportedSize,
    screen.getPrimaryDisplay().scaleFactor,
    display.scaleFactor,
  );

  // The pet is one sprite in a small box. A request several times that size is
  // not a resize, it is a symptom â€” the zoom bug produced exactly that for four
  // sessions â€” so it is refused rather than applied.
  if (width > MAX_WINDOW.width || height > MAX_WINDOW.height) return;

  // Zoom is asserted here as well as on load and on the wheel gesture, because
  // this is the moment it does damage: a page reporting CSS pixels while zoomed
  // describes a window that is 1.5x too big.
  petWindow.webContents.setZoomLevel(0);

  // Compared with a tolerance, not for equality. `setContentSize(143, 152)`
  // comes back as 144x153 on a fractionally scaled display, so an exact test
  // never matches and the window is re-sized every time the page speaks.
  const settled = Math.abs(was.width - width) <= POSITION_TOLERANCE
    && Math.abs(was.height - height) <= POSITION_TOLERANCE;
  // An OS drag must not be resized underneath: that is the path that produced
  // the cut sprite and, before it, the drift. A flight we are driving ourselves
  // is fine â€” we place him again on the next frame anyway.
  if (settled || (carrying && carrySource !== 'app')) return;

  petWindow.setContentSize(width, height);

  // Verified, like the position is. A content size that does not come back as
  // the one we asked for means something is scaling this window underneath us â€”
  // the fault that was mistaken for drift twice. One retry, because the usual
  // cause is a zoom that has just been reset.
  const applied = sizeNow();
  if (Math.abs(applied.width - width) > POSITION_TOLERANCE
    || Math.abs(applied.height - height) > POSITION_TOLERANCE) {
    petWindow.webContents.setZoomLevel(0);
    petWindow.setContentSize(width, height);
  }

  /*
   * Anchored to his feet, not to the middle of the window.
   *
   * He stands on things, and everything that changes this window's height grows
   * it upwards: a speech bubble above his head, a larger size from the slider.
   * Anchoring the centre sank him through whatever he was standing on by half
   * the difference every time. Horizontally the centre is right, because he
   * grows sideways from the middle.
   */
  const centreX = at.x + was.width / 2;
  const bottom = at.y + was.height;
  const clamped = clampToDisplay(centreX - width / 2, bottom - height, width, height);
  moveTo(clamped.x, clamped.y);
}

/**
 * Puts the window into a state where a press can reach him.
 *
 * ## Why this is one function and not a checklist at each call site
 *
 * "The window is visible" and "the window is usable" were separate states that
 * nothing forced to agree, and they came apart four times, by four unrelated
 * routes: a drag band placed against a stale rectangle, a show that skipped the
 * page's reset, a carry flag that could never clear, and a suppression release
 * that showed a pet nobody had prepared. Every one of those fixes was correct
 * and every one of them was a repair to a *path*.
 *
 * So this is the invariant instead: everything a press needs is established
 * here, unconditionally, and `showPetWindow` is the only way the window is ever
 * shown. Adding a new reason to show him costs nothing and cannot reintroduce
 * the state, because there is no way to show him without coming through here.
 *
 * What a press needs, all of it:
 *
 * - the window movable, or the OS ignores the drag region entirely;
 * - click-through re-asserted, because it is the one piece of this that lives
 *   in the OS and does not survive everything a window can go through;
 * - the pointer poll running, which is the shell's own route in when the page
 *   is receiving no mouse events;
 * - and the page re-deriving its input state — see the resync handler there,
 *   which also rebuilds its alpha mask when the mask belongs to a pet other
 *   than the one on screen.
 *
 * The carry is *sent* rather than used to skip all this: the shell is the
 * authority on whether a carry is live, so it says so and the page agrees with
 * it. Skipping the reset to protect a live carry is what left the page carrying
 * a pet that had been put down minutes ago.
 */
function makeUsable(fromHidden) {
  if (!isAlive()) return;

  // Unconditional, both of them. They are idempotent and they are the half of
  // the invariant that has to hold continuously rather than at a moment.
  assertWindowState();
  startWatchdog();

  /*
   * And the rebuild only when there is something to rebuild.
   *
   * This used to run on every call, on the reasoning that making him usable is
   * cheap and doing it *sometimes* was what cost four rounds of bugs. The first
   * half of that is wrong: a resync is not free, it is a **reset**, and its job
   * is to make the page forget that the pointer is on the pet.
   *
   * `applyVisibility` is called for every reason the pet might need to be on
   * screen, and the renderer produces a lot of them -- a measured session had
   * 149 calls, 13 of which reset a window that had never stopped being visible.
   * Each of those arrives while the user may be hovering him, and takes the
   * window click-through, closes the pill and cancels the gesture in progress.
   * Do that every couple of seconds and the pet is not unusable in the sense of
   * a stuck flag; he is unusable in the sense that he keeps dropping you.
   *
   * A window that was never hidden cannot have gone stale *from* being hidden,
   * which is the only thing this reset repairs. And staleness by any other
   * route now heals on the next poll by itself -- see `setPointerOver` in the
   * page, which answers the probe authoritatively. That is what makes it safe
   * to stop firing this defensively: recovery stopped depending on it.
   */
  if (!fromHidden) {
    traceState('already-usable');
    return;
  }

  interactive = false;
  petWindow.setIgnoreMouseEvents(true, { forward: true });
  petWindow.webContents.send('pet:resync', { carrying: carryIsLive() });
  // The window has just been off screen, which is where every geometry fault
  // this feature has had was introduced. See `reassertGeometry`.
  reassertGeometry('shown');
  traceState('made-usable');
}

/**
 * The window-level half of usable, re-asserted rather than assumed.
 *
 * Two properties, both of which the OS owns and neither of which reliably
 * survives everything this window goes through:
 *
 * - **Movable.** A window marked immovable ignores the drag region outright.
 * - **Topmost.** This one is easy to miss because it does not look like an
 *   input bug. A pet who has fallen behind the app window is *visible* — he is
 *   over the desktop, he animates, nothing about him looks wrong — and every
 *   press on him lands in the app instead. "He appears but I cannot use him" is
 *   exactly what that looks like from outside, and it is indistinguishable
 *   from a page that has stopped reporting the pointer.
 *
 * A `focusable: false` window is the one most likely to lose the topmost
 * flag on Windows, because it is never the foreground window and never gets
 * re-raised as a side effect of being used.
 *
 * Both are cheap native getters, so this runs on every watchdog tick as well as
 * at show time. That is the point: establishing the invariant once, at the
 * moment of showing, is what has been done four times, and the reports kept
 * arriving by routes nobody had thought of. Holding it *continuously* means a
 * cause nobody has identified costs one tick rather than a restart.
 */
function assertWindowState() {
  if (!isAlive()) return;
  if (!petWindow.isMovable()) petWindow.setMovable(true);
  if (!petWindow.isAlwaysOnTop()) petWindow.setAlwaysOnTop(true, 'screen-saver');
}

/**
 * Writes the window's own geometry back to it.
 *
 * ## Why this exists, and why it is a position write
 *
 * "Recall pet" reliably brings a dead pet back to life. That button clears the
 * hide, calls `applyVisibility` and moves the window -- and the first two happen
 * on every ordinary show, so the one thing it does that a show does not is
 * **move**. That is a strong clue and it does not point at any of the flags:
 * whatever the fault is, re-applying the window's geometry clears it.
 *
 * Several candidates were ruled out by measurement rather than argument. The
 * OS's draggable region survives a hide/show intact -- `WM_NCHITTEST` still
 * answers `HTCAPTION` over his body afterwards -- so it is not that. The
 * window's bounds and our record of them agree to within a pixel. And a real
 * cursor on a real pet, on this machine, produces the handshake correctly.
 *
 * So the cause is not identified, and this does not pretend to identify it.
 * What it does is turn the known remedy into something the application applies
 * itself at the moment it is most likely to be needed: when he comes back onto
 * the screen, which is where every geometry fault this feature has had was
 * introduced. A forced `setPosition` of the position he is already at costs one
 * call and moves nothing -- the write is the point, not the destination, which
 * is why it cannot go through `moveTo` (that skips a write matching the record,
 * and here the record is not in question).
 *
 * It is deliberately *not* driven by a "he has been dead for a while" detector.
 * One was written; see the note in the watchdog for why it cannot work from the
 * shell's side.
 *
 * The pet is *not* sent home. Recall's other half -- the corner of the primary
 * display -- is a deliberate, visible action for a pet nobody can find, and
 * doing it silently would take a pet somebody parked somewhere and move him.
 */
function reassertGeometry(reason) {
  if (!isAlive()) return;

  const at = positionNow();
  petWindow.setPosition(at.x, at.y);

  // Reconciled afterwards, on the same rule as `moveTo`: a pixel is the DIP
  // round trip, more than that is the record having come adrift.
  const [actualX, actualY] = petWindow.getPosition();
  if (Math.abs(actualX - at.x) > POSITION_TOLERANCE
    || Math.abs(actualY - at.y) > POSITION_TOLERANCE) {
    trackedPosition = { x: actualX, y: actualY };
  }

  // And the size, which is the other half of the window's geometry and the half
  // that decides where the sprite and the pill land inside it.
  applyReportedSize();
  traceState(`geometry-reasserted-${reason}`);
}

/**
 * The only place this window is ever shown.
 *
 * `showInactive` rather than `show`: a companion that steals focus while the
 * user is typing is a companion they will uninstall.
 */
function showPetWindow() {
  if (!isAlive()) return;

  // Asked before the show, because it is the question `makeUsable` needs
  // answering: was he actually away, or is this the tenth call in a row about a
  // window that has been on screen the whole time.
  const fromHidden = !petWindow.isVisible();
  if (fromHidden) petWindow.showInactive();
  makeUsable(fromHidden);
}

function applyVisibility() {
  if (!isAlive()) return;
  traceState('apply-visibility');

  if (shouldShow()) {
    // Every time, not only on the transition from hidden. `applyVisibility` is
    // called for every reason the pet might need to be on screen, and making
    // him usable is cheap; making him usable *sometimes* is what this cost four
    // rounds to learn.
    showPetWindow();
    return;
  }

  if (petWindow.isVisible()) {
    setInteractive(false);
    petWindow.hide();
  }
  stopWatchdog();
}

/**
 * Tells the page what he is holding up, or that he is holding up nothing.
 *
 * Sent on every change rather than polled: the whole point of this feature is
 * that "your work is finished" arrives when it happens, and the page's own poll
 * is 2.5 seconds wide in both directions — late to appear and late to clear.
 */
function pushAlerts() {
  if (!isAlive()) return;
  petWindow.webContents.send('pet:alert', describeAlerts(alerts));
}

/**
 * A conversation finished while the user was not looking at it.
 *
 * Refused when the pet is not on screen, and *especially* when the user has
 * hidden him: putting him back to deliver a notification would override a
 * deliberate choice, which is the whole reason his hide and the app's
 * suppression are two different switches.
 *
 * Returns whether he took it. A refusal used to end the matter, which left the
 * one case nothing covered: away from the machine, pet put away, turn finished,
 * silence. The caller sends that case to the operating system instead — see
 * `main.js`. Only one of the two ever announces a given turn.
 */
export function notifyPetOfCompletion({ sessionId, title, at }) {
  if (!sessionId || !shouldShow()) return false;

  alerts = addAlert(alerts, { sessionId, title, at: at || Date.now() });
  pushAlerts();
  return true;
}

/** The user has looked at that conversation, so he has nothing left to say about it. */
export function clearPetAlert(sessionId) {
  if (!sessionId) return;
  const next = clearAlert(alerts, sessionId);
  if (next.length === alerts.length) return;

  alerts = next;
  pushAlerts();
}

/**
 * The pet's own hide, from the pill's X.
 *
 * The persisted one — the same switch the app's own control uses — so a pet put
 * away stays away across a restart. It does not clear the active pet: hiding a
 * companion is not the same as deciding you no longer have one, and the way
 * back is the marketplace, which is where the pet came from.
 */
function hideFromPill() {
  hidden = true;
  traceState('hide-from-pill');
  // Put away is put away. Keeping the queue would mean he re-appeared holding a
  // week-old announcement the next time he was let out.
  alerts = [];
  pushAlerts();
  persistPosition();
  applyVisibility();
}

/**
 * The pill's settings button: show me this pet.
 *
 * The panel lives in the app, so the shell's part is to bring the app forward
 * and say which pet. A pet window floating over a minimised app is exactly the
 * case where "open settings" has to also mean "and put the app where I can see
 * it" — otherwise the click appears to do nothing at all.
 */
function openDetails(petId) {
  onOpenPetDetails(String(petId || ''));
}

/**
 * Wires the channels the page talks over.
 *
 * Registered once for the lifetime of the app rather than per window, because
 * the window is created and destroyed as pets come and go.
 */
let ipcInstalled = false;

function installIpc() {
  // Once per process, not once per window: the window is destroyed and rebuilt
  // as the app opens and closes, and a second registration would deliver every
  // pointer report twice.
  if (ipcInstalled) return;
  ipcInstalled = true;

  ipcMain.on('pet:visibility', (_event, payload) => {
    const next = Boolean(payload?.hasPet);
    /*
     * Only when it changed.
     *
     * The page announces this whenever it re-renders a pet, which is more often
     * than the pet actually changes -- and a report that says what the shell
     * already knows used to run the whole show path anyway. Cutting it here is
     * cutting the loudest source of the resets described in `makeUsable`, at the
     * point where the redundancy is obvious.
     */
    if (next === hasPet) return;

    hasPet = next;
    traceState('page-reported-has-pet');
    applyVisibility();
  });

  ipcMain.on('pet:resize', (_event, payload) => {
    if (!isAlive()) return;
    const width = Math.max(48, Math.round(Number(payload?.width) || DEFAULT_SIZE.width));
    const height = Math.max(48, Math.round(Number(payload?.height) || DEFAULT_SIZE.height));

    reportedSize = { width, height };
    applyReportedSize();
  });

  ipcMain.on('pet:interactive', (_event, payload) => setInteractive(Boolean(payload?.over)));

  ipcMain.on('pet:details', (_event, payload) => openDetails(
    typeof payload?.petId === 'string' ? payload.petId : '',
  ));

  ipcMain.on('pet:hide', () => hideFromPill());

  /*
    The pill's microphone. Carried straight through: whether the app is
    listening, and what listening even means, is entirely the renderer's.
  */
  ipcMain.on('pet:voice-toggle', () => onToggleVoice());

  /*
   * The pill's arrow: hand the pet back to the chat.
   *
   * The shell does not decide what that means — the app owns where a pet lives —
   * so this only forwards. What it *does* own is that the button was reachable
   * at all, which is `dockable`, and the app told it that too.
   */
  ipcMain.on('pet:dock', (_event, payload) => onDockPet(
    typeof payload?.petId === 'string' ? payload.petId : '',
  ));

  /*
   * The bubble was clicked: go to that conversation.
   *
   * The obvious action, and the one that also clears the alert — an alert whose
   * only exit is "go and do the thing" is a bad neighbour, so the bubble is
   * both the notice and the way to answer it. The X beside it is the other way.
   */
  ipcMain.on('pet:alert-open', (_event, payload) => {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
    if (!sessionId) return;
    clearPetAlert(sessionId);
    onOpenSession(sessionId);
  });

  ipcMain.on('pet:alert-dismiss', (_event, payload) => {
    clearPetAlert(typeof payload?.sessionId === 'string' ? payload.sessionId : '');
  });

  /*
   * The desktop was rearranged.
   *
   * A monitor's scale factor changing, or a screen appearing or disappearing,
   * both change how many DIPs the pet needs to look the same size — and the
   * second can also leave him on a display that no longer exists, which the
   * re-clamp inside the resize handles. Registered here because this function
   * runs once per process; the window comes and goes.
   */
  for (const event of ['display-metrics-changed', 'display-added', 'display-removed']) {
    screen.on(event, () => applyReportedSize());
  }
}

/**
 * Creates the window.
 *
 * `focusable: false` and no shadow are what stop it reading as an application
 * window; `backgroundThrottling: false` is what stops Chromium slowing its
 * animation to a crawl when it is not the foreground window — which is, for
 * this window, always.
 */
export function createPetWindow(options) {
  readState = options.readState;
  writeState = options.writeState;
  onOpenPetDetails = options.onOpenPetDetails ?? (() => {});
  onOpenSession = options.onOpenSession ?? (() => {});
  onDockPet = options.onDockPet ?? (() => {});
  onToggleVoice = options.onToggleVoice ?? (() => {});

  // On by default while the drift is unexplained. It is a bounded, buffered
  // append to userData; the cost is far smaller than another round of guessing
  // at a gesture that cannot be reproduced on the machine doing the guessing.

  const stored = readState().petWindow;
  hidden = Boolean(stored?.hidden);

  const start = restorePosition(DEFAULT_SIZE.width, DEFAULT_SIZE.height);

  petWindow = new BrowserWindow({
    ...DEFAULT_SIZE,
    // The numbers above and everything the page reports describe the drawing
    // area, not the invisible frame Windows wraps around it.
    useContentSize: true,
    x: start.x,
    y: start.y,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    // The OS moves this window now, via the drag handle on the sprite. A window
    // marked immovable simply ignores the gesture.
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(options.appRoot, 'electron', 'pet-preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      /**
       * Its own session, purely to escape the app's zoom.
       *
       * Chromium stores zoom **per origin**, and in a packaged build this page
       * is served from the same origin as the app itself. So every Ctrl+= the
       * user pressed in the window silently scaled this page too: its CSS
       * pixels grew, the size it reported stopped matching the window it needs,
       * and a 143x152 pet became 163, then 401, then 671 pixels of transparent
       * window with a sprite stranded at the bottom of it. Everything that
       * followed — the huge grab offsets, the release clamp shoving the pet
       * down, being unable to pick it up — came from that.
       *
       * A separate partition gives this window its own zoom, which is always 1.
       */
      partition: 'persist:tails-pet',
      zoomFactor: 1,
    },
  });

  /**
   * And held at 1, per load.
   *
   * The partition is what stops the app's zoom reaching this page; this is the
   * belt to that pair of braces, because a zoom applied here by any other route
   * breaks the same geometry in the same way. The pet is a fixed-size sprite —
   * there is no reading to make larger.
   */
  petWindow.webContents.on('did-finish-load', () => {
    petWindow?.webContents.setZoomLevel(0);
    petWindow?.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
  });

  /**
   * And refused if anything zooms it later.
   *
   * The partition stops the *app's* zoom reaching this page. It does not stop
   * this page being zoomed directly: the window is interactive whenever the
   * pointer is on the pet, and a Ctrl+wheel there is Chromium's own zoom
   * gesture. That is what grew the window to 223x229 — 1.5x is a zoom step, and
   * it scales every CSS pixel the page measures itself in, so the size it
   * reports stops describing the window it needs.
   *
   * There is nothing here to make bigger; it is one sprite at a fixed size.
   */
  petWindow.webContents.on('zoom-changed', () => {
    if (!isAlive()) return;
    petWindow.webContents.setZoomLevel(0);
  });

  // Above full-screen applications, not merely above ordinary windows.
  petWindow.setAlwaysOnTop(true, 'screen-saver');
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  petWindow.setIgnoreMouseEvents(true, { forward: true });

  trackedPosition = { x: start.x, y: start.y };

  /**
   * The window moved.
   *
   * This is now the drag. A move we did not make came either from the user
   * carrying the pet by its handle — the OS doing the work — or from the system
   * relocating the window. Both mean the same thing here: the record follows
   * reality, and the pet is told it is being carried.
   *
   * Moves we made ourselves come through `moveTo`, which records the position
   * first, so they land inside the tolerance and are ignored.
   */
  petWindow.on('move', () => {
    if (!isAlive()) return;
    const [x, y] = petWindow.getPosition();
    const at = positionNow();
    if (Math.abs(x - at.x) <= POSITION_TOLERANCE && Math.abs(y - at.y) <= POSITION_TOLERANCE) {
      return;
    }

    trackedPosition = { x, y };
    onCarried(x, y);
    // The arrow points at the app, so carrying the pet changes where that is.
    pushDockState();
  });

  petWindow.on('closed', () => {
    stopWatchdog();
    petWindow = null;
  });

  // The page is a document, and documents forget. Anything the shell is holding
  // for it — the alert queue, and nothing else so far — is re-sent whenever it
  // loads, so a pet who was announcing something goes on announcing it after a
  // reload rather than falling silent with the chat still waiting.
  petWindow.webContents.on('did-finish-load', () => pushAlerts());

  installIpc();
  void petWindow.loadURL(`${options.serverUrl}/api/pets/window`);

  return petWindow;
}

/** Called when the app takes the pet in-window, and when it gives it back. */
/**
 * Tells the page whether the arrow applies, and which way it points.
 *
 * The bearing is measured centre to centre, in degrees, with zero pointing right
 * — which is how the glyph is drawn, so the page can rotate it by exactly this
 * number. Sent on every change of either window's position, which is why it is
 * cheap: two rectangles and an `atan2`.
 */
function pushDockState() {
  if (!isAlive()) return;

  let bearing = 0;
  if (appBounds) {
    const from = petWindow.getBounds();
    const dx = (appBounds.x + appBounds.width / 2) - (from.x + from.width / 2);
    const dy = (appBounds.y + appBounds.height / 2) - (from.y + from.height / 2);
    bearing = Math.round((Math.atan2(dy, dx) * 180) / Math.PI);
  }

  petWindow.webContents.send('pet:dock-state', { dockable, bearing });
}

/**
 * The app says whether the pet could go back into the chat on screen.
 *
 * Two separate facts arriving together: the renderer knows whether this pet
 * belongs to the conversation being viewed, and the shell knows where the app's
 * window is. Neither is any use without the other — the button needs to know it
 * applies, and the arrow needs to know where to point.
 */
export function setPetDockable(next, bounds) {
  // `undefined` leaves the flag alone, so the app window moving can refresh the
  // bearing without claiming to know whether the button still applies.
  if (next !== undefined) dockable = Boolean(next);
  if (bounds) appBounds = bounds;
  pushDockState();
}

export function setPetSuppressed(next) {
  suppressed = Boolean(next);
  traceState(next ? 'suppress-on' : 'suppress-off');
  applyVisibility();
}

/**
 * Puts the pet back in its corner, and un-hides it.
 *
 * The way out of a pet you cannot reach. Every other control — the context
 * menu, dragging, the click-through toggle — needs the pointer to land on the
 * sprite first, so when the window ends up somewhere unusable there is no way
 * back from inside the app. This is reachable from the marketplace instead, and
 * takes no argument on purpose: it is for the case where nobody can say where
 * the pet currently is.
 */
export function resetPetPosition() {
  if (!isAlive()) return;

  const size = sizeNow();
  const home = defaultPosition(size.width, size.height);

  moveTo(home.x, home.y);

  hidden = false;
  applyVisibility();
  persistPosition();
}

/**
 * Puts the pet down at a point on the screen.
 *
 * For the handoff: carrying the in-chat pet out of the window should leave him
 * where the hand opened, not back wherever the window happened to be. The point
 * is the pointer, so the sprite is centred on it rather than hung from its
 * top-left corner, and it is clamped like any other move — a drop over a second
 * monitor's edge must not strand him off screen.
 */
/**
 * Puts the pet down at a point in the app's own page.
 *
 * The app is the only caller, and it can only speak in its own coordinates —
 * CSS pixels inside its window. Converting them here rather than there is what
 * keeps the zoom factor and the window's frame in one place: the renderer has
 * no reliable way to ask either question about itself, and every attempt to do
 * it from that side has been a position that drifts as the hand travels.
 */
export function placePetFromWindow(fromWindow, clientX, clientY, holding) {
  if (!fromWindow || fromWindow.isDestroyed()) return;
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;

  const bounds = fromWindow.getContentBounds();
  const point = clientPointToDip(
    { x: bounds.x, y: bounds.y },
    fromWindow.webContents.getZoomFactor(),
    clientX,
    clientY,
  );

  placePetAt(point.x, point.y, holding);
}

export function placePetAt(x, y, holding = false) {
  if (!isAlive()) return;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;

  const size = sizeNow();
  const clamped = clampToDisplay(x - size.width / 2, y - size.height / 2, size.width, size.height);
  moveTo(clamped.x, clamped.y);

  // Treated as a carry, because it is one — the app is dragging him across the
  // desktop. That gets him the running animation, the facing, the pause on the
  // watchdog and the resize handler, and the save when the moves stop, all from
  // the same place a handle drag gets them.
  onCarried(clamped.x, clamped.y, 'app', holding);
}

/**
 * The user's own hide/show, which survives a restart.
 *
 * ## Un-hiding means "put my pet back", not "clear one flag"
 *
 * Three things can keep the pet off screen and only one of them is this one.
 * Closing him with the pill's X sets `hidden`; a chat that had him in its
 * interface sets `suppressed`; and a window left on a monitor that has since
 * been unplugged is neither, but is just as gone. Clearing only `hidden` meant
 * the marketplace's own switch could be flipped back and forth with no visible
 * effect at all — which is what "he is permanently hidden" was. The way back
 * was the Recall button, and needing a *second, differently named* control to
 * undo the first is the tell that the first one was not finishing its job.
 *
 * So un-hiding clears every reason it is entitled to clear. Suppression is a
 * handoff to an in-chat pet, and there is no in-chat pet on the surface this
 * switch lives on; if it is still set, it is stale. The position is only
 * touched when it is genuinely unreachable — a pet somebody has parked in a
 * particular corner should stay in that corner.
 *
 * Hiding stays narrow, and deliberately: it is one decision with one effect.
 */
export function setPetHidden(next) {
  hidden = Boolean(next);
  traceState(next ? 'hide-on' : 'hide-off');

  if (!hidden) {
    suppressed = false;
    ensureReachable();
  }

  persistPosition();
  applyVisibility();
}

/**
 * Moves the window home if it is not on any display we can see.
 *
 * Only then. Restoring the corner every time would take a pet the user
 * deliberately parked somewhere and move him, which is its own bug — the one
 * `resetPetPosition` exists to be an explicit, opt-in version of.
 */
function ensureReachable() {
  if (!isAlive()) return;

  const size = sizeNow();
  const at = trackedPosition ?? { x: 0, y: 0 };
  const clamped = clampToDisplay(at.x, at.y, size.width, size.height);
  if (clamped.x === at.x && clamped.y === at.y) return;

  moveTo(clamped.x, clamped.y);
}

export function isPetHidden() {
  return hidden;
}

/** Asks the page to re-read the active pet now, rather than at its next poll. */
/**
 * Tells the pet whether the app is listening.
 *
 * Silent when there is no window: the pet being closed is the ordinary case,
 * not a failure, and the state is pushed again when he next appears.
 */
export function setPetVoiceState(listening) {
  if (isAlive()) petWindow.webContents.send('pet:voice-state', listening === true);
}

export function refreshPetWindow() {
  if (isAlive()) petWindow.webContents.send('pet:refresh');
}

export function destroyPetWindow() {
  if (saveTimer) persistPosition();
  if (settleTimer) clearTimeout(settleTimer);
  stopWatchdog();
  if (isAlive()) petWindow.destroy();
  petWindow = null;

}
