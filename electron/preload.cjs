const { contextBridge } = require('electron');

/**
 * The renderer's view of the desktop shell.
 *
 * Deliberately tiny. Everything the app needs today goes over HTTP and the
 * websocket to the local server, which keeps the browser build and the desktop
 * build on exactly the same code path — the bridge exists only for things that
 * genuinely require the shell.
 */
contextBridge.exposeInMainWorld('tailsDesktop', {
  isDesktop: true,
  platform: process.platform,
});
