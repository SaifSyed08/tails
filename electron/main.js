import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, nativeImage, shell } from 'electron';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SERVER_PORT = Number(process.env.TAILS_SERVER_PORT || 4317);
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;

/** In dev the renderer is served by Vite; in production by our own server. */
const DEV_URL = process.env.TAILS_DEV_URL || null;
const APP_URL = DEV_URL || SERVER_URL;

let mainWindow = null;
let splashWindow = null;
let serverProcess = null;

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

  // Fires in the main process before the page sees the event, so a theme
  // cannot swallow it.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const isPanic = input.type === 'keyDown'
      && input.control && input.alt && input.shift
      && input.key.toLowerCase() === 't';
    if (!isPanic) return;

    event.preventDefault();
    void mainWindow?.webContents.executeJavaScript(PANIC_RESET_SCRIPT).catch(() => {});
  });

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
  });

  void mainWindow.loadURL(APP_URL);
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
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]));
}

async function bootstrap() {
  await app.whenReady();

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

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  serverProcess?.kill();
});

void bootstrap();
