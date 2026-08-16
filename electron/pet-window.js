import { BrowserWindow, ipcMain, screen } from 'electron';
import path from 'node:path';

import { clientPointToDip, sizeForScaleFactor } from './pet-geometry.js';


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
    if (!isAlive() || carrying) return;

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

      // Into the page's own coordinates. Zoom is pinned at 1 for this window —
      // see the guards around `setZoomLevel` — but it is read rather than
      // assumed, because a page that has been zoomed is exactly the state where
      // a coordinate silently stops meaning what it says.
      const content = petWindow.getContentBounds();
      const zoom = petWindow.webContents.getZoomFactor() || 1;
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
function onCarried(x, y, source = 'os') {
  carrySource = source;
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

  // The OS reports no drop, so the end of the gesture is inferred from the
  // moves stopping. Only the animation and the save depend on it, so guessing
  // slightly early or late costs nothing.
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = null;
    carrying = false;
    carrySource = null;
    carryFacing = null;
    if (!isAlive()) return;

    petWindow.webContents.send('pet:carry', false);

    // Put down, possibly on a different screen. Rescaled here rather than
    // during the drag: mid-flight `setContentSize` is the path that cut the
    // sprite in half and, before that, fed the drift — and a pet who resizes
    // the moment he lands reads as him settling rather than as a glitch.
    applyReportedSize();
    persistPosition();
  }, SETTLE_MS);
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
function resyncAfterShow() {
  if (!isAlive()) return;

  if (settleTimer) {
    clearTimeout(settleTimer);
    settleTimer = null;
  }
  carrying = false;
  carrySource = null;
  carryFacing = null;

  interactive = false;
  petWindow.setIgnoreMouseEvents(true, { forward: true });
  petWindow.setMovable(true);
  petWindow.webContents.send('pet:resync');
}

/**
 * Sizes the window for the pet, on the display he is actually on.
 *
 * Split out of the resize message because it has three callers now: the page
 * asking, the pet being put down somewhere else, and the desktop itself being
 * rearranged. All three are the same question — how many DIPs is this sprite
 * here — and the answer moved the day multi-monitor came up.
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
  // not a resize, it is a symptom — the zoom bug produced exactly that for four
  // sessions — so it is refused rather than applied.
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
  // is fine — we place him again on the next frame anyway.
  if (settled || (carrying && carrySource !== 'app')) return;

  petWindow.setContentSize(width, height);

  // Verified, like the position is. A content size that does not come back as
  // the one we asked for means something is scaling this window underneath us —
  // the fault that was mistaken for drift twice. One retry, because the usual
  // cause is a zoom that has just been reset.
  const applied = sizeNow();
  if (Math.abs(applied.width - width) > POSITION_TOLERANCE
    || Math.abs(applied.height - height) > POSITION_TOLERANCE) {
    petWindow.webContents.setZoomLevel(0);
    petWindow.setContentSize(width, height);
  }

  // Kept on the same spot rather than the same corner, so growing or shrinking
  // him does not also move him, and re-clamped because a window that just grew
  // may now hang off the screen.
  const centreX = at.x + was.width / 2;
  const centreY = at.y + was.height / 2;
  const clamped = clampToDisplay(centreX - width / 2, centreY - height / 2, width, height);
  moveTo(clamped.x, clamped.y);
}

function applyVisibility() {
  if (!isAlive()) return;

  if (shouldShow()) {
    // `showInactive` rather than `show`: a companion that steals focus while
    // the user is typing is a companion they will uninstall.
    if (!petWindow.isVisible()) {
      petWindow.showInactive();
      resyncAfterShow();
    }
    // Asks where the pointer is for as long as he is on screen, not only once
    // he has been noticed — being noticed is the thing it exists to arrange.
    startWatchdog();
    return;
  }

  if (petWindow.isVisible()) {
    setInteractive(false);
    petWindow.hide();
  }
  stopWatchdog();
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
    hasPet = Boolean(payload?.hasPet);
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
  });

  petWindow.on('closed', () => {
    stopWatchdog();
    petWindow = null;
  });

  installIpc();
  void petWindow.loadURL(`${options.serverUrl}/api/pets/window`);

  return petWindow;
}

/** Called when the app takes the pet in-window, and when it gives it back. */
export function setPetSuppressed(next) {
  suppressed = Boolean(next);
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
export function placePetFromWindow(fromWindow, clientX, clientY) {
  if (!fromWindow || fromWindow.isDestroyed()) return;
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;

  const bounds = fromWindow.getContentBounds();
  const point = clientPointToDip(
    { x: bounds.x, y: bounds.y },
    fromWindow.webContents.getZoomFactor(),
    clientX,
    clientY,
  );

  placePetAt(point.x, point.y);
}

export function placePetAt(x, y) {
  if (!isAlive()) return;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;

  const size = sizeNow();
  const clamped = clampToDisplay(x - size.width / 2, y - size.height / 2, size.width, size.height);
  moveTo(clamped.x, clamped.y);

  // Treated as a carry, because it is one — the app is dragging him across the
  // desktop. That gets him the running animation, the facing, the pause on the
  // watchdog and the resize handler, and the save when the moves stop, all from
  // the same place a handle drag gets them.
  onCarried(clamped.x, clamped.y, 'app');
}

/** The user's own hide/show, which survives a restart. */
export function setPetHidden(next) {
  hidden = Boolean(next);
  persistPosition();
  applyVisibility();
}

export function isPetHidden() {
  return hidden;
}

/** Asks the page to re-read the active pet now, rather than at its next poll. */
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
