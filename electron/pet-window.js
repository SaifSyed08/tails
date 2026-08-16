import { BrowserWindow, Menu, app, globalShortcut, ipcMain, screen } from 'electron';
import path from 'node:path';

import { closeDragLog, logDrag, openDragLog } from './pet-log.js';

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

/** Gap between drag frames. One frame at 60Hz, measured from the end of the last. */
const DRAG_INTERVAL_MS = 16;

/**
 * How long the page may go quiet during a drag before the shell gives up on it.
 *
 * The page pulses every 200ms while the button is held, so silence means the
 * page is gone, hung, or never saw the mouseup — the state that would otherwise
 * leave a pet glued to the cursor.
 *
 * This replaces an earlier rule that abandoned the drag when the *pointer* left
 * the window. That was a bad proxy: a fast gesture outruns the window for a
 * moment, and the geometry made it worse in one direction — the sprite sits at
 * the bottom of its window, so a downward drag has only a few pixels of margin
 * below the grab point while an upward one has the whole box. It froze
 * downward drags first, and the pet was left behind.
 */
const SILENT_PAGE_MS = 1200;

/** How often to check that an interactive window still has the pointer over it. */
const WATCHDOG_INTERVAL_MS = 250;

let petWindow = null;
let readState = () => ({});
let writeState = () => {};
let onOpenSettings = () => {};
let serverUrl = '';

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

let interactive = false;
let watchdogTimer = null;
let dragTimer = null;
let dragOffset = null;
let lastFacing = null;
let lastHeartbeat = 0;
let lastDragX = null;
/** Frames since the current drag began, so the trace can sample rather than flood. */
let frameCount = 0;

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
const DRAG_MODES = ['tracked', 'os', 'closed'];
let dragMode = 'tracked';
/** Accumulated write error, mode 3 only. Reset at the start of every drag. */
let dragError = { x: 0, y: 0 };
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
}

/** Where the pet is. Falls back to the OS only before we have ever placed it. */
function positionNow() {
  if (trackedPosition) return trackedPosition;
  const [x, y] = isAlive() ? petWindow.getPosition() : [0, 0];
  trackedPosition = { x, y };
  return trackedPosition;
}

/** The window's size, which the OS *is* authoritative about — we never set it by hand. */
function sizeNow() {
  const bounds = isAlive() ? petWindow.getBounds() : { width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height };
  return { width: bounds.width, height: bounds.height };
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

function schedulePersist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(persistPosition, 400);
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
    const onScreen = screen.getAllDisplays().some((display) => {
      const area = display.workArea;
      return x >= area.x - width && x <= area.x + area.width
        && y >= area.y - height && y <= area.y + area.height;
    });
    if (onScreen) return clampToDisplay(x, y, width, height);
  }

  return defaultPosition(width, height);
}

function setInteractive(next) {
  if (!isAlive() || interactive === next) return;
  interactive = next;

  // `forward: true` keeps move events coming while the window is transparent to
  // clicks, which is the only way the page can notice the pointer arriving.
  petWindow.setIgnoreMouseEvents(!next, { forward: true });

  if (next) startWatchdog();
  else stopWatchdog();
}

/**
 * Forces click-through back on when the pointer is no longer over the window.
 *
 * The page's own `mouseleave` covers the ordinary case; this covers the ones it
 * cannot — the pointer crossing into another application in a single frame, the
 * page hanging, a display change moving the window out from under the cursor.
 */
function startWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    if (!isAlive() || !interactive || dragTimer) return;

    const cursor = screen.getCursorScreenPoint();
    const at = positionNow();
    const size = sizeNow();
    const inside = cursor.x >= at.x && cursor.x <= at.x + size.width
      && cursor.y >= at.y && cursor.y <= at.y + size.height;

    if (!inside) setInteractive(false);
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
function startDrag() {
  if (!isAlive() || dragTimer) return;

  // Seeded here so a drag is never abandoned before the first pulse arrives.
  lastHeartbeat = Date.now();

  const cursor = screen.getCursorScreenPoint();

  // Which position the grab offset is measured against is exactly the question
  // the three modes exist to answer, so it is the one thing they differ on here.
  const recorded = positionNow();
  const [osX, osY] = petWindow.getPosition();
  const origin = dragMode === 'tracked' ? recorded : { x: osX, y: osY };

  dragOffset = { x: cursor.x - origin.x, y: cursor.y - origin.y };
  dragError = { x: 0, y: 0 };

  lastDragX = cursor.x;
  setInteractive(true);

  // The offset recorded here is the number that matters: if it walks between
  // one drag and the next, the pet ends up somewhere other than under the hand
  // carrying it. `os` is logged beside `tracked` because a disagreement between
  // them is the specific failure three previous fixes were aimed at.
  // Bounds and display, because the offsets recorded so far are impossible for
  // the window this is supposed to be: a 766px grab offset cannot happen on a
  // 152px-tall sprite box, so either the window is not the size we think or the
  // cursor and the window are not being measured in the same space.
  const bounds = isAlive() ? petWindow.getBounds() : null;
  const display = screen.getDisplayNearestPoint(cursor);

  logDrag('start', {
    mode: dragMode,
    cursor,
    tracked: recorded,
    os: [osX, osY],
    offset: dragOffset,
    bounds,
    scale: display.scaleFactor,
    workArea: display.workArea,
  });
  frameCount = 0;

  /**
   * A self-scheduling frame, not `setInterval`.
   *
   * `setPosition` on a transparent always-on-top window is a synchronous
   * compositor call, and when one takes longer than the interval, `setInterval`
   * queues the next tick immediately — so the loop falls behind by a little
   * more every frame and the pet trails further from the cursor the longer the
   * drag goes on. Scheduling the next frame only after this one finishes makes
   * a slow frame cost one frame, not a growing backlog.
   */
  const step = () => {
    if (!isAlive() || !dragOffset) return stopDrag();

    const cursor = screen.getCursorScreenPoint();
    // Absolute, every frame: the window is placed where the cursor says it
    // should be, never moved by a delta and never derived from where it
    // currently is. Nothing accumulates, so nothing drifts.
    //
    // And deliberately **unclamped** while the button is down. Clamping here
    // pins the window at a screen edge while the pointer keeps going, and the
    // moment they separate the page stops receiving mouse events — so the
    // mouseup never arrives, the drag never ends, and the pet is stuck to the
    // cursor with no way to release it. Dragging straight up hit this every
    // time, because the sprite sits at the bottom of its window and the pointer
    // clears the top edge almost immediately. The pet is put back inside the
    // work area when it is dropped instead.
    const next = {
      x: Math.round(cursor.x - dragOffset.x + dragError.x),
      y: Math.round(cursor.y - dragOffset.y + dragError.y),
    };

    // `moveTo` skips a write when nothing moved, so a stationary hand costs no
    // compositor calls.
    moveTo(next.x, next.y);

    // Mode 3 closes the loop: ask where the window actually landed and carry
    // the difference into the next frame, so a write that loses a fraction is
    // corrected rather than compounded. The extra `getPosition` per frame is
    // the whole cost of the mode, and skipping the correction when it is
    // already zero keeps a well-behaved display from paying for it.
    if (dragMode === 'closed') {
      const [landedX, landedY] = petWindow.getPosition();
      dragError = { x: next.x - landedX, y: next.y - landedY };
    }

    // Every tenth frame, so a long drag stays readable. `live` is what the
    // offset has become *now* — it must equal the offset recorded at `start`
    // for the whole gesture, and any walk in it is the drift, measured on the
    // user's own hand rather than a synthetic one.
    frameCount += 1;
    if (frameCount % 10 === 0) {
      const at = positionNow();
      logDrag('frame', {
        n: frameCount,
        cursor,
        tracked: at,
        os: petWindow.getPosition(),
        live: { x: cursor.x - at.x, y: cursor.y - at.y },
      });
    }

    // Face the way it is being thrown. The threshold keeps a hand that is
    // holding still from flickering the sprite back and forth.
    if (Math.abs(cursor.x - lastDragX) > 2) {
      const direction = cursor.x < lastDragX ? 'left' : 'right';
      if (direction !== lastFacing) {
        petWindow.webContents.send('pet:facing', direction);
        lastFacing = direction;
      }
      lastDragX = cursor.x;
    }

    // The page says when the gesture is over — by sending `pet:drag-end`, or by
    // falling silent. Where the pointer happens to be is not evidence either
    // way, and treating it as evidence is what froze fast drags.
    if (Date.now() - lastHeartbeat > SILENT_PAGE_MS) {
      logDrag('abandon', { reason: 'page-silent', silentMs: Date.now() - lastHeartbeat });
      return stopDrag();
    }

    dragTimer = setTimeout(step, DRAG_INTERVAL_MS);
    return undefined;
  };

  step();
}

function stopDrag() {
  if (dragTimer) clearTimeout(dragTimer);
  dragTimer = null;
  dragOffset = null;
  lastFacing = null;
  lastDragX = null;

  // Put it back on a screen. The drag itself is unclamped so the window can
  // always stay under the pointer; this is where a pet that was carried off the
  // edge comes back — clamped to the display it was dropped nearest, not to the
  // primary one.
  if (isAlive()) {
    const at = positionNow();
    const size = sizeNow();
    const settled = clampToDisplay(at.x, at.y, size.width, size.height);
    moveTo(settled.x, settled.y);

    // A clamp that actually moved the pet is worth seeing: the release is the
    // one moment the position is rewritten by something other than the cursor,
    // so it is where a per-drag bias would enter.
    logDrag('end', {
      tracked: at,
      settled,
      clamped: settled.x !== at.x || settled.y !== at.y,
      os: petWindow.getPosition(),
    });
  }

  schedulePersist();
}

/**
 * Switches drag mechanism and says so on screen.
 *
 * Bound to Ctrl+Alt+1/2/3 rather than to plain 1/2/3: a bare number registered
 * as a global shortcut is swallowed everywhere on the machine, so typing "1" in
 * any application would stop working. The pet window is deliberately
 * unfocusable, so it cannot take the keystroke itself.
 */
function setDragMode(next) {
  if (!DRAG_MODES.includes(next) || next === dragMode) return;

  dragMode = next;
  logDrag('mode', { mode: dragMode });

  // Announced in the window itself, because the point of switching is to feel
  // the difference immediately and guessing which one is live defeats that.
  if (isAlive()) petWindow.webContents.send('pet:drag-mode', dragMode);
}

function applyVisibility() {
  if (!isAlive()) return;

  if (shouldShow()) {
    // `showInactive` rather than `show`: a companion that steals focus while
    // the user is typing is a companion they will uninstall.
    if (!petWindow.isVisible()) petWindow.showInactive();
    return;
  }

  if (petWindow.isVisible()) {
    stopDrag();
    setInteractive(false);
    petWindow.hide();
  }
}

/** The right-click menu — the way out that does not require finding the app. */
function openContextMenu(petId) {
  if (!isAlive()) return;

  /*
   * Two different hides, so both labels say which one.
   *
   * The first closes this window and leaves the pet active everywhere else —
   * the marketplace still shows it on stage, and it comes back on the next
   * launch unless it is turned off again. The second unsets the active pet
   * entirely, so there is no pet anywhere until one is chosen. "Stand down" was
   * jargon for the second and read like the first.
   */
  const menu = Menu.buildFromTemplate([
    {
      label: 'Hide pet from desktop',
      click: () => {
        hidden = true;
        persistPosition();
        applyVisibility();
      },
    },
    {
      label: 'Hide pet everywhere (clears the active pet)',
      enabled: Boolean(petId),
      click: () => {
        // Straight to the server: the pet window has no app state of its own,
        // and going through the renderer would mean it could not do this while
        // the main window is closed.
        void fetch(`${serverUrl}/api/pets/${encodeURIComponent(petId)}/activate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ active: false }),
        }).catch(() => {});
      },
    },
    { type: 'separator' },
    // A second way in, because a global shortcut can be taken by another
    // application and there would then be no way to switch at all.
    {
      label: 'Drag mechanism (testing)',
      submenu: DRAG_MODES.map((mode, index) => ({
        label: `${index + 1}  ${mode}   —   Ctrl+Alt+${index + 1}`,
        type: 'radio',
        checked: dragMode === mode,
        click: () => setDragMode(mode),
      })),
    },
    { type: 'separator' },
    { label: 'Settings…', click: () => onOpenSettings() },
  ]);

  menu.popup({ window: petWindow });
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

    // Nothing to do, and doing it anyway would matter: this reads the position
    // back and writes it again, so an unchanged size still nudged the window
    // every time the page polled — and mid-drag it fought the drag loop.
    const size = sizeNow();
    if (dragTimer || (size.width === width && size.height === height)) return;

    const at = positionNow();
    petWindow.setSize(width, height);
    // Re-clamped, because a window that just grew may now hang off the screen.
    const clamped = clampToDisplay(at.x, at.y, width, height);
    moveTo(clamped.x, clamped.y);
  });

  ipcMain.on('pet:interactive', (_event, payload) => setInteractive(Boolean(payload?.over)));

  ipcMain.on('pet:drag-start', () => startDrag());

  ipcMain.on('pet:drag-end', () => stopDrag());

  ipcMain.on('pet:drag-heartbeat', () => {
    lastHeartbeat = Date.now();
  });

  ipcMain.on('pet:menu', (_event, payload) => openContextMenu(
    typeof payload?.petId === 'string' ? payload.petId : null,
  ));
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
  onOpenSettings = options.onOpenSettings ?? (() => {});
  serverUrl = options.serverUrl;

  // On by default while the drift is unexplained. It is a bounded, buffered
  // append to userData; the cost is far smaller than another round of guessing
  // at a gesture that cannot be reproduced on the machine doing the guessing.
  openDragLog(app.getPath('userData'));

  // Global, because the pet is unfocusable and the gesture being diagnosed
  // happens with the pointer on the pet rather than in any window. Failures are
  // ignored: another application may already hold the combination, and a
  // diagnostic that refuses to start the app would be a poor trade.
  DRAG_MODES.forEach((mode, index) => {
    try {
      globalShortcut.register(`CommandOrControl+Alt+${index + 1}`, () => setDragMode(mode));
    } catch {
      // Nothing to recover: the context menu still switches modes.
    }
  });

  const stored = readState().petWindow;
  hidden = Boolean(stored?.hidden);

  const start = restorePosition(DEFAULT_SIZE.width, DEFAULT_SIZE.height);

  petWindow = new BrowserWindow({
    ...DEFAULT_SIZE,
    x: start.x,
    y: start.y,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
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
    },
  });

  // Above full-screen applications, not merely above ordinary windows.
  petWindow.setAlwaysOnTop(true, 'screen-saver');
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  petWindow.setIgnoreMouseEvents(true, { forward: true });

  trackedPosition = { x: start.x, y: start.y };

  /**
   * Something outside this module moved the window.
   *
   * Our own moves go through `moveTo`, which records them, so a `move` event
   * that disagrees with the record by more than a rounding step came from the
   * OS — a display being unplugged, a workspace change. Trusting it keeps the
   * record honest without letting the OS's rounded read-backs creep into the
   * drag maths, which is the whole reason the record exists.
   */
  petWindow.on('move', () => {
    if (!isAlive() || dragTimer) return;
    const [x, y] = petWindow.getPosition();
    const at = positionNow();
    if (Math.abs(x - at.x) > 2 || Math.abs(y - at.y) > 2) {
      // Adopting the OS value is the one path that can move the baseline
      // without the cursor asking, so it is logged whenever it happens.
      logDrag('reconcile', { from: at, to: { x, y } });
      trackedPosition = { x, y };
    }
  });

  petWindow.on('closed', () => {
    stopDrag();
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
  stopDrag();
  stopWatchdog();
  if (isAlive()) petWindow.destroy();
  petWindow = null;

  // Global shortcuts outlive the window that registered them, so they have to
  // be handed back explicitly or they keep swallowing the combination.
  DRAG_MODES.forEach((_mode, index) => {
    try {
      globalShortcut.unregister(`CommandOrControl+Alt+${index + 1}`);
    } catch {
      // Already gone, or never registered.
    }
  });

  closeDragLog();
}
