import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, shell } from 'electron';

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
  serverProcess = spawn(process.execPath, [entry], {
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
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(APP_ROOT, 'electron', 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
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

async function bootstrap() {
  await app.whenReady();

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
