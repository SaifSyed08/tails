import { BrowserWindow, Menu, ipcMain, screen } from 'electron';
import path from 'node:path';

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

let interactive = false;
let watchdogTimer = null;
let dragTimer = null;
let dragOffset = null;
let dragSize = null;
let lastPosition = null;
let lastFacing = null;
let lastDragX = null;
let saveTimer = null;

function isAlive() {
  return petWindow && !petWindow.isDestroyed();
}

/** Whether the pet should be on screen right now. */
function shouldShow() {
  return hasPet && !hidden && !suppressed;
}

function persistPosition() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (!isAlive()) return;

  const [x, y] = petWindow.getPosition();
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
    const bounds = petWindow.getBounds();
    const inside = cursor.x >= bounds.x && cursor.x <= bounds.x + bounds.width
      && cursor.y >= bounds.y && cursor.y <= bounds.y + bounds.height;

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

  const cursor = screen.getCursorScreenPoint();
  const [originX, originY] = petWindow.getPosition();

  // Both readings come from Electron, in one coordinate system, once. The
  // renderer used to supply this from `event.screenX - window.screenX`, whose
  // error grows with the window's position — which is what made the pet slide
  // further from the cursor the further it was dragged.
  dragOffset = { x: cursor.x - originX, y: cursor.y - originY };

  // Cached, not re-read per frame: `getBounds` round-trips through device
  // pixels, so on a fractionally scaled display it can answer a pixel either
  // side of what was set, and feeding that back into the clamp is how a drag
  // develops a wobble.
  const { width, height } = petWindow.getBounds();
  dragSize = { width, height };
  lastDragX = cursor.x;
  setInteractive(true);

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
    const next = clampToDisplay(
      cursor.x - dragOffset.x,
      cursor.y - dragOffset.y,
      dragSize.width,
      dragSize.height,
    );

    // Skipped when nothing moved: a stationary hand should not cost sixty
    // compositor calls a second, and this is also what keeps the one-pixel
    // rounding step from being re-applied over and over.
    if (next.x !== lastPosition.x || next.y !== lastPosition.y) {
      petWindow.setPosition(next.x, next.y);
      lastPosition = next;
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

    dragTimer = setTimeout(step, DRAG_INTERVAL_MS);
    return undefined;
  };

  lastPosition = { x: originX, y: originY };
  step();
}

function stopDrag() {
  if (dragTimer) clearTimeout(dragTimer);
  dragTimer = null;
  dragOffset = null;
  dragSize = null;
  lastPosition = null;
  lastFacing = null;
  lastDragX = null;
  schedulePersist();
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

  const menu = Menu.buildFromTemplate([
    {
      label: 'Hide the desktop pet',
      click: () => {
        hidden = true;
        persistPosition();
        applyVisibility();
      },
    },
    {
      label: 'Stand down (no active pet)',
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
    const bounds = petWindow.getBounds();
    if (dragTimer || (bounds.width === width && bounds.height === height)) return;

    petWindow.setSize(width, height);
    // Re-clamped, because a window that just grew may now hang off the screen.
    const clamped = clampToDisplay(bounds.x, bounds.y, width, height);
    petWindow.setPosition(clamped.x, clamped.y);
  });

  ipcMain.on('pet:interactive', (_event, payload) => setInteractive(Boolean(payload?.over)));

  ipcMain.on('pet:drag-start', () => startDrag());

  ipcMain.on('pet:drag-end', () => stopDrag());

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
}
