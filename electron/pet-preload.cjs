const { contextBridge, ipcRenderer } = require('electron');

/**
 * The desktop pet's bridge.
 *
 * Separate from the app's preload and deliberately narrower: this page is a
 * sprite on a transparent window, and the only things it needs to say are where
 * the pointer is, how big it wants to be, and that someone right-clicked it.
 *
 * Every channel is one-way and takes plain data. The window is `sandbox: true`
 * with no node integration, so a page served over HTTP — which this one is —
 * can never reach anything but these five verbs.
 */
contextBridge.exposeInMainWorld('petBridge', {
  /** Whether a pet is active at all; the shell shows or hides the window. */
  reportVisibility: (hasPet) => ipcRenderer.send('pet:visibility', { hasPet }),

  /** The sprite's box, so the transparent window is no bigger than it needs to be. */
  reportSize: (width, height) => ipcRenderer.send('pet:resize', { width, height }),

  /**
   * Whether the pointer is over the pet's opaque pixels.
   *
   * Drives click-through. Reporting `false` late is what leaves a rectangle of
   * dead desktop, so the page sends it on `mouseleave` too, and the shell has a
   * watchdog behind that.
   */
  reportPointerOverPet: (over) => ipcRenderer.send('pet:interactive', { over }),

  startDrag: (offsetX, offsetY) => ipcRenderer.send('pet:drag-start', { offsetX, offsetY }),
  endDrag: () => ipcRenderer.send('pet:drag-end'),

  openMenu: (petId) => ipcRenderer.send('pet:menu', { petId }),

  /** The shell tells the page which way the drag is going, and when to re-read the pet. */
  onFacing: (handler) => ipcRenderer.on('pet:facing', (_event, facing) => handler(facing)),
  onRefresh: (handler) => ipcRenderer.on('pet:refresh', () => handler()),
});
