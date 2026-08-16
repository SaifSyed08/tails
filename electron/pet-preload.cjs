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

  /** The pill's settings button: open this pet's panel in the app. */
  openDetails: (petId) => ipcRenderer.send('pet:details', { petId }),

  /** The pill's X: put the pet away. Persisted, like the app's own hide. */
  hidePet: () => ipcRenderer.send('pet:hide'),

  /**
   * The shell tells the page it is being carried.
   *
   * There is no mousedown to listen for: the OS performs the window move from a
   * `-webkit-app-region` handle, so the only evidence a drag is happening is
   * the window changing position, which only the shell can see.
   */
  onCarry: (handler) => ipcRenderer.on('pet:carry', (_event, carrying) => handler(carrying)),

  /** Which way the carry is going, and when to re-read the pet. */
  onFacing: (handler) => ipcRenderer.on('pet:facing', (_event, facing) => handler(facing)),
  onRefresh: (handler) => ipcRenderer.on('pet:refresh', () => handler()),

  /**
   * The window has just been shown again after being hidden.
   *
   * While hidden the page receives no mouse moves, so anything it believes
   * about the pointer is out of date — and a stale belief here is a pet that
   * cannot be picked up. The shell says when to forget it.
   */
  onResync: (handler) => ipcRenderer.on('pet:resync', () => handler()),

  /**
   * Which drag mechanism is live, while three are being compared.
   *
   * Temporary, and worth removing once one is chosen — the page has no business
   * knowing how the shell moves the window, and only shows it so the person
   * switching can tell which one they are feeling.
   */
});
