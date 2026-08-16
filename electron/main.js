import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, ipcMain, nativeImage, shell } from 'electron';

import {
  createPetWindow,
  destroyPetWindow,
  clearPetAlert,
  isPetHidden,
  notifyPetOfCompletion,
  placePetFromWindow,
  refreshPetWindow,
  resetPetPosition,
  setPetHidden,
  setPetSuppressed,
} from './pet-window.js';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SERVER_PORT = Number(process.env.TAILS_SERVER_PORT || 4317);
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;

/** In dev the renderer is served by Vite; in production by our own server. */
const DEV_URL = process.env.TAILS_DEV_URL || null;
const APP_URL = DEV_URL || SERVER_URL;

let mainWindow = null;
let splashWindow = null;
let serverProcess = null;

/**
 * App zoom.
 *
 * Done with `webContents.setZoomLevel` rather than a CSS/root-font-size scale
 * in the renderer, because the renderer only owns type: an em-based scale would
 * leave every `px` border, every icon and the whole layout grid at their
 * original size, which is not what "make everything bigger" means. Chromium's
 * zoom multiplies the CSS pixel itself, so the entire UI — including the
 * scrollbars and the themed surfaces — scales as one.
 *
 * The step is Chromium's own logarithmic level (factor = 1.2 ^ level), so the
 * increments feel the same going up as coming down.
 */
const ZOOM_STEP = 0.5;
const ZOOM_LIMIT = 4;

/**
 * The header's CSS height, mirrored from `Header.tsx` (`h-14`) and from the
 * sidebar's top row, which sits beside it. All three are the same number and
 * have to move together, or the OS caption buttons stop lining up with the
 * app's own header.
 */
const HEADER_HEIGHT = 56;

let zoomLevel = 0;
let zoomSaveTimer = null;

function readUiStatePath() {
  return path.join(app.getPath('userData'), 'ui-state.json');
}

/**
 * The persisted UI state, as a whole.
 *
 * One file with several owners — the zoom level, the desktop pet's position —
 * so every write has to merge rather than replace. Writing just the field you
 * changed is how the pet's position used to disappear whenever someone zoomed.
 */
function readUiState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(readUiStatePath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function patchUiState(patch) {
  try {
    fs.writeFileSync(readUiStatePath(), JSON.stringify({ ...readUiState(), ...patch }));
  } catch {
    // State that does not survive a restart is a far smaller problem than a
    // crash on quit.
  }
}

function clampZoomLevel(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(ZOOM_LIMIT, Math.max(-ZOOM_LIMIT, value));
}

/** Reads the persisted zoom, tolerating a missing or corrupt file. */
function readStoredZoomLevel() {
  return clampZoomLevel(Number(readUiState().zoomLevel));
}

/** Writes the level out now, tolerating a read-only or full disk. */
function writeZoomLevel() {
  if (zoomSaveTimer) clearTimeout(zoomSaveTimer);
  zoomSaveTimer = null;
  patchUiState({ zoomLevel });
}

/**
 * Schedules the write, coalescing a burst into one.
 *
 * Ctrl+wheel changes the level once per notch, and a synchronous write per
 * notch would put the disk in the middle of a gesture.
 */
function saveZoomLevel() {
  if (zoomSaveTimer) clearTimeout(zoomSaveTimer);
  zoomSaveTimer = setTimeout(writeZoomLevel, 400);
}

function applyZoomLevel(next) {
  zoomLevel = clampZoomLevel(next);

  const contents = mainWindow?.webContents;
  if (!contents || contents.isDestroyed()) return;

  contents.setZoomLevel(zoomLevel);

  // The caption-button overlay is measured in unscaled device pixels, so it
  // does not follow the zoom on its own — left alone, the window controls stop
  // lining up with the app's own header the moment the user zooms.
  if (process.platform !== 'darwin') {
    try {
      mainWindow.setTitleBarOverlay({
        height: Math.round(HEADER_HEIGHT * contents.getZoomFactor()),
      });
    } catch {
      // Only meaningful while the overlay exists; never worth failing a zoom.
    }
  }

  saveZoomLevel();
}

/**
 * Maps a keystroke to a zoom intent, or null.
 *
 * Covers the four spellings of the same two keys people actually press: `=`
 * and `-` on the main row, `+` and `_` when Shift is held, and the numpad
 * pair — the last identified by `code`, since the numpad reports the same
 * `key` as the main row. Alt is excluded so this never eats the Ctrl+Alt+Shift
 * appearance reset.
 */
function readZoomIntent(input) {
  if (input.type !== 'keyDown' || !input.control || input.alt) return null;

  if (input.key === '=' || input.key === '+' || input.code === 'NumpadAdd') return 'in';
  if (input.key === '-' || input.key === '_' || input.code === 'NumpadSubtract') return 'out';
  if (input.key === '0' || input.code === 'Numpad0') return 'reset';
  return null;
}

/** Resolves once the local server answers, or rejects after the timeout. */
function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(`${SERVER_URL}/health`, (response) => {
        response.resume();
        if (response.statusCode === 200) {
          resolve();
          return;
        }
        retry();
      });

      request.on('error', retry);
      request.setTimeout(1500, () => request.destroy());
    };

    const retry = () => {
      if (Date.now() > deadline) {
        reject(new Error(`The local server did not start within ${timeoutMs}ms.`));
        return;
      }
      setTimeout(attempt, 300);
    };

    attempt();
  });
}

/**
 * Starts the bundled server unless one is already listening.
 *
 * Reusing a running server is what makes `npm run dev` (server + Vite) and
 * `npm run desktop` compose instead of fighting over the port.
 */
async function ensureServer() {
  try {
    await waitForServer(1200);
    return;
  } catch {
    // Nothing listening yet — start our own.
  }

  const entry = path.join(APP_ROOT, 'dist-server', 'server', 'index.js');

  // Deliberately NOT `process.execPath`: inside Electron that is the Electron
  // binary, so spawning it re-enters Electron and loads better-sqlite3 and
  // node-pty against Electron's ABI (NODE_MODULE_VERSION), which fails with a
  // module-version mismatch. The server is a plain Node service and wants a
  // plain Node runtime. Packaging will need `@electron/rebuild` (or a bundled
  // Node) instead of relying on one being installed.
  const nodeBinary = process.env.TAILS_NODE_PATH || 'node';

  // Windows needs a shell to resolve a bare `node` off PATH, but a shell also
  // word-splits arguments — and this project's path contains a space. Quote
  // the entry explicitly rather than letting the shell tear it in half.
  const useShell = process.platform === 'win32';
  const entryArgument = useShell ? `"${entry}"` : entry;

  serverProcess = spawn(nodeBinary, [entryArgument], {
    shell: useShell,
    cwd: APP_ROOT,
    // Spread rather than replace: a bare env would strip PATH and the Claude
    // Code subprocess the server spawns would fail to launch.
    env: { ...process.env, TAILS_SERVER_PORT: String(SERVER_PORT) },
    stdio: 'inherit',
  });

  serverProcess.on('exit', (code) => {
    if (code !== 0 && !app.isPackaged) console.error(`Server exited with code ${code}`);
  });

  await waitForServer();
}

/**
 * The cold-start brand moment.
 *
 * Frameless and transparent so it reads as a floating mark rather than a
 * second window. It covers Electron boot, server spawn, and bundle load — time
 * the user would otherwise spend looking at nothing.
 */
function createSplash() {
  splashWindow = new BrowserWindow({
    width: 460,
    height: 300,
    frame: false,
    transparent: true,
    resizable: false,
    center: true,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });

  splashWindow.once('ready-to-show', () => splashWindow?.show());
  void splashWindow.loadFile(path.join(APP_ROOT, 'electron', 'splash', 'index.html'));
}

/**
 * Wipes any generated theme, from the main process.
 *
 * The recovery path has to live outside the themed document. A stylesheet can
 * hide a button, invert two buttons, or lay a transparent overlay over one —
 * but it cannot intercept a keystroke, and it cannot reach into another
 * process. So the panic key is handled here and the reset works by *deleting*
 * the sheet rather than trying to out-specify it, because specificity and
 * `!important` are games the theme can play too.
 */
/**
 * The last way out of a look that has made the app unusable.
 *
 * Enumerated by id rather than by prefix on purpose — a stylesheet the panic
 * key does not know about is one it cannot remove, and the failure is silent.
 * `tails-css` was missing here for exactly that reason: it is the fallback for
 * browsers without constructable stylesheets, unreachable on the Electron this
 * ships with, so nothing ever exercised it. Latent, not harmless — the whole
 * point of this script is that it works on the day everything else did not.
 *
 * The ids here are the fallback elements from `applyTheme.ts` (`tails-<layer>`,
 * for the layers in `LAYER_ORDER`) plus the pre-paint element from
 * `index.html`. The live-controls layer needs no entry: it is adopted-only and
 * goes with the line above. Adding a layer there means adding it here.
 */
const PANIC_RESET_SCRIPT = `(() => {
  document.adoptedStyleSheets = [];
  for (const id of ['tails-theme-preboot', 'tails-theme', 'tails-css']) {
    document.getElementById(id)?.remove();
  }
  try { localStorage.removeItem('tails.themeCss'); } catch {}
  fetch('/api/appearance/unbind', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'global' }),
  }).catch(() => {});
  return true;
})()`;

/**
 * Whether the user is dictating right now.
 *
 * The main process cannot see a button being pressed, so the renderer raises
 * this immediately before `getUserMedia` and lowers it the moment capture ends.
 * Without it the only options are a standing microphone grant or no microphone,
 * and a standing grant in an app that lets an agent rewrite the page is not a
 * trade worth making.
 *
 * Lowered defensively on blur and hide as well: a window that loses focus
 * mid-dictation should not leave the grant open behind it, and the cost of
 * being wrong in that direction is a refused permission rather than a hot mic.
 */
let voiceIntent = false;

/**
 * Refuses every device permission the app has not asked for.
 *
 * Electron's default is to **grant**, which is the wrong default for any app
 * and a poor one for this app in particular: the renderer runs a page whose
 * appearance an agent can rewrite, and Chromium lumps camera, microphone and
 * screen capture together under a single `media` permission. Left alone, code
 * in the renderer could open the microphone with no prompt and no indicator.
 *
 * Nothing here is enabled yet — dictation is not built. This is the default
 * being corrected rather than a feature being prepared, which is why it denies
 * everything: when the microphone is wanted, the grant should be added
 * deliberately and narrowly, and be visible while it is held.
 *
 * `setPermissionCheckHandler` matters as much as the request handler. Some APIs
 * consult it synchronously and never raise a request at all, so handling only
 * requests leaves a second door open.
 */
function installPermissionHandlers(session) {
  const allow = (permission) => permission === 'media' && voiceIntent;

  session.setPermissionRequestHandler((_contents, permission, callback) => callback(allow(permission)));
  session.setPermissionCheckHandler((_contents, permission) => allow(permission));

  // A device the page cannot enumerate is one it cannot quietly start using.
  // Microphones are allowed through the same gate, and nothing else ever is.
  session.setDevicePermissionHandler((details) => (
    details.deviceType === 'audioInput' && voiceIntent
  ));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    show: false,
    // Matches the app's dark `--background`, so there is no white flash between
    // the window appearing and the first paint.
    backgroundColor: '#0f0f11',
    icon: readAppIcon(),
    // No OS title bar. The app draws its own header instead, so nothing looks
    // like stock Windows chrome bolted onto the UI. On Windows/Linux the
    // caption buttons are kept as a themable overlay rather than reimplemented,
    // because hand-rolled window controls never quite behave correctly (snap
    // layouts, double-click-to-maximise, accessibility).
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: 14 } }
      : {
        titleBarOverlay: {
          color: '#00000000',
          symbolColor: '#a1a1aa',
          // The constant, not a copy of what it used to be. This was left at 44
          // when the header grew to 56, so the caption strip was 12px short
          // until the first zoom change re-applied it correctly — the initial
          // paint being the one place that did not go through `applyZoomLevel`.
          height: HEADER_HEIGHT,
        },
      }),
    webPreferences: {
      preload: path.join(APP_ROOT, 'electron', 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  installPermissionHandlers(mainWindow.webContents.session);

  // Belt and braces around the grant: whatever the renderer believes, a window
  // that is not in front of the user is not one they are dictating into.
  for (const event of ['blur', 'hide', 'minimize']) {
    mainWindow.on(event, () => { voiceIntent = false; });
  }

  // Fires in the main process before the page sees the event, so neither a
  // theme nor a focused text field can swallow it.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const isPanic = input.type === 'keyDown'
      && input.control && input.alt && input.shift
      && input.key.toLowerCase() === 't';
    if (isPanic) {
      event.preventDefault();
      void mainWindow?.webContents.executeJavaScript(PANIC_RESET_SCRIPT).catch(() => {});
      return;
    }

    const intent = readZoomIntent(input);
    if (!intent) return;

    event.preventDefault();
    if (intent === 'reset') applyZoomLevel(0);
    else applyZoomLevel(zoomLevel + (intent === 'in' ? ZOOM_STEP : -ZOOM_STEP));
  });

  // Ctrl+wheel. Electron reports the gesture here rather than acting on it, so
  // the same clamp and the same persistence apply as for the keyboard.
  mainWindow.webContents.on('zoom-changed', (_event, direction) => {
    applyZoomLevel(zoomLevel + (direction === 'in' ? ZOOM_STEP : -ZOOM_STEP));
  });

  // Re-applied per load: a navigation resets the renderer's zoom, so a reload
  // would otherwise silently drop the user back to 100%.
  mainWindow.webContents.on('did-finish-load', () => applyZoomLevel(zoomLevel));

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    // Closed only after the app has painted, so the two windows never both
    // show an empty frame.
    splashWindow?.close();
    splashWindow = null;
  });

  // External links belong in the user's browser, not in an app window with no
  // address bar.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // The pet is a companion to the app, not a second app: leaving its window
    // open would also keep the process alive past the last real window, since
    // `window-all-closed` counts every BrowserWindow.
    destroyPetWindow();
  });

  void mainWindow.loadURL(APP_URL);
}

/**
 * The always-on-top pet.
 *
 * Created once the app window exists so it starts above it, and given the
 * shell services it cannot reach on its own: the shared UI-state file, and a
 * way to bring the app forward from its context menu.
 */
function startPetWindow() {
  createPetWindow({
    appRoot: APP_ROOT,
    serverUrl: SERVER_URL,
    readState: readUiState,
    writeState: patchUiState,
    /**
     * The pill's settings button, which is now the pet's only way in.
     *
     * The panel is a piece of the app, so the shell brings the app forward and
     * says which pet it is about. Without the raise this looks broken: the pet
     * floats above everything, so clicking him while the app is behind another
     * window would open a panel nobody can see.
     */
    /**
     * The pet's bubble was clicked: show that conversation.
     *
     * Raising the window is the shell's half — the app may be minimised behind
     * everything, which is the only situation in which this bubble exists — and
     * choosing the chat is the renderer's, because the session list and the
     * view state are its.
     */
    onOpenSession: (sessionId) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('tails:open-session', sessionId);
    },

    onOpenPetDetails: (petId) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('tails:open-pet-details', petId);
    },
  });
}

/**
 * The app's control over the desktop pet.
 *
 * `suppress` is the handoff for an in-window pet taking over — temporary, and
 * deliberately not the same switch as the user's own Hide, so a handoff can
 * never overwrite a preference. `refresh` exists so activating a pet shows it
 * immediately instead of at the window's next poll.
 */
/**
 * Whether the user is actually looking at the app.
 *
 * The one fact in this feature that only the shell can answer, so it is
 * answered here and nowhere else. "Not on top" is deliberately as broad as the
 * user described it: minimised, behind another window, or on another desktop
 * all mean the same thing — he is not going to see a turn finish.
 */
function appIsInFront() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  return mainWindow.isFocused() && mainWindow.isVisible() && !mainWindow.isMinimized();
}

function installPetBridge() {
  // The one thing that opens the microphone gate. Registered here with the
  // other renderer channels rather than beside the permission handlers,
  // because it is a message from the page, not a policy.
  ipcMain.on('tails:voice-intent', (_event, wanted) => { voiceIntent = wanted === true; });

  ipcMain.on('tails:desktop-pet', (event, payload) => {
    const action = payload?.action;
    if (action === 'suppress') setPetSuppressed(payload?.value !== false);
    else if (action === 'hide') setPetHidden(payload?.value !== false);
    else if (action === 'refresh') refreshPetWindow();
    else if (action === 'reset') resetPetPosition();
    // The handoff: the app is carrying an in-window pet past its own edge. The
    // point is in the app page's coordinates, and only the shell can turn those
    // into a place on the screen — see `placePetFromWindow`.
    else if (action === 'place') {
      placePetFromWindow(
        BrowserWindow.fromWebContents(event.sender),
        Number(payload?.x),
        Number(payload?.y),
        // Still in the hand. A held pet keeps running until the app says
        // otherwise, rather than settling every time the hand pauses.
        payload?.holding === true,
      );
    }
  });

  ipcMain.handle('tails:desktop-pet-state', () => ({ hidden: isPetHidden() }));

  /*
   * Turn completion, from the renderer, filtered by what only the shell knows.
   *
   * The renderer sees the turn finish over its websocket — it keeps running
   * while minimised — and it is the only side that knows whose pet that chat
   * has. The shell knows whether the window is in front of the user. Neither
   * half can decide this alone, so each supplies what it has: the renderer
   * reports, and this decides.
   */
  ipcMain.on('tails:pet-alert', (_event, payload) => {
    const action = payload?.action;
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';

    if (action === 'completed') {
      // He is looking right at the app. Whatever finished, he watched it
      // finish, and a pet jumping about to tell him so is noise.
      if (appIsInFront()) return;
      notifyPetOfCompletion({ sessionId, title: String(payload?.title || ''), at: Date.now() });
      return;
    }

    // "Viewing" is only true if the window is actually in front: a chat open
    // behind three other windows has not been read, and the requirement is that
    // he keeps asking until it has been.
    if (action === 'viewing' && appIsInFront()) clearPetAlert(sessionId);
  });
}

/**
 * Loads the app icon, tolerating its absence.
 *
 * Without this Electron ships its own default icon, which is the "outdated
 * React logo" in the taskbar and Alt-Tab.
 */
function readAppIcon() {
  const iconPath = path.join(APP_ROOT, 'electron', 'assets', 'icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  return icon.isEmpty() ? undefined : icon;
}

/**
 * Replaces the default application menu.
 *
 * The stock menu is where File/Edit/View comes from, and it looks like a
 * Windows 10 app bolted to the top of the UI. On macOS a menu is mandatory, so
 * a minimal one is kept there; elsewhere it is removed entirely. Either way the
 * appearance reset gets an accelerator, since the OS menu is chrome a theme can
 * never restyle.
 */
function installApplicationMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reset appearance',
          accelerator: 'CmdOrCtrl+Alt+Shift+T',
          click: () => void mainWindow?.webContents.executeJavaScript(PANIC_RESET_SCRIPT).catch(() => {}),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        // Not the `zoomIn`/`zoomOut`/`resetZoom` roles: those move the zoom
        // behind our back, so the persisted level and the caption-overlay
        // height would both go stale the first time the menu was used.
        {
          label: 'Actual size',
          accelerator: 'CmdOrCtrl+0',
          click: () => applyZoomLevel(0),
        },
        {
          label: 'Zoom in',
          accelerator: 'CmdOrCtrl+Plus',
          click: () => applyZoomLevel(zoomLevel + ZOOM_STEP),
        },
        {
          label: 'Zoom out',
          accelerator: 'CmdOrCtrl+-',
          click: () => applyZoomLevel(zoomLevel - ZOOM_STEP),
        },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]));
}

async function bootstrap() {
  await app.whenReady();

  // Before the window exists, so the first `did-finish-load` already carries
  // the level the user left the app at.
  zoomLevel = readStoredZoomLevel();

  installApplicationMenu();
  createSplash();

  try {
    if (!DEV_URL) await ensureServer();
    else await waitForServer();
  } catch (error) {
    console.error('T.A.I.L.S. failed to start:', error);
    splashWindow?.close();
    app.quit();
    return;
  }

  installPetBridge();
  createMainWindow();
  startPetWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // Quitting inside the save debounce would otherwise lose the last change,
  // which is exactly the one the user just made.
  if (zoomSaveTimer) writeZoomLevel();
  destroyPetWindow();
  serverProcess?.kill();
});

void bootstrap();
