import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, ipcMain, nativeImage, shell } from 'electron';

import {
  createPetWindow,
  destroyPetWindow,
  isPetHidden,
  refreshPetWindow,
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
const PANIC_RESET_SCRIPT = `(() => {
  document.adoptedStyleSheets = [];
  document.getElementById('tails-theme-preboot')?.remove();
  document.getElementById('tails-theme')?.remove();
  try { localStorage.removeItem('tails.themeCss'); } catch {}
  fetch('/api/appearance/unbind', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'global' }),
  }).catch(() => {});
  return true;
})()`;

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
          height: 44,
        },
      }),
    webPreferences: {
      preload: path.join(APP_ROOT, 'electron', 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

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
    onOpenSettings: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      // The settings panel belongs to the renderer; the shell can only ask.
      mainWindow.webContents.send('tails:open-settings');
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
function installPetBridge() {
  ipcMain.on('tails:desktop-pet', (_event, payload) => {
    const action = payload?.action;
    if (action === 'suppress') setPetSuppressed(payload?.value !== false);
    else if (action === 'hide') setPetHidden(payload?.value !== false);
    else if (action === 'refresh') refreshPetWindow();
  });

  ipcMain.handle('tails:desktop-pet-state', () => ({ hidden: isPetHidden() }));
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
