const { contextBridge, ipcRenderer } = require('electron');

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

  /**
   * The always-on-top pet.
   *
   * One of the few things that genuinely requires the shell: an HTTP call
   * cannot move a window. `suppress` is for the handoff when an in-window pet
   * takes over — it is separate from `hide`, which is the user's own choice and
   * survives a restart, so a handoff can never quietly discard a preference.
   */
  desktopPet: {
    suppress: (value) => ipcRenderer.send('tails:desktop-pet', { action: 'suppress', value }),
    hide: (value) => ipcRenderer.send('tails:desktop-pet', { action: 'hide', value }),
    refresh: () => ipcRenderer.send('tails:desktop-pet', { action: 'refresh' }),

    /**
     * Brings the pet back to its corner and shows it.
     *
     * The recovery path for a pet that has ended up somewhere it cannot be
     * clicked — every other control needs the pointer to hit the sprite first.
     */
    resetPosition: () => ipcRenderer.send('tails:desktop-pet', { action: 'reset' }),

    /**
     * Puts the desktop pet at a point on the screen, in screen coordinates.
     *
     * For handing an in-window pet back: he should appear where he was let go
     * of, not wherever the window was left last time.
     */
    place: (x, y, holding) => ipcRenderer.send('tails:desktop-pet', { action: 'place', x, y, holding }),
    readState: () => ipcRenderer.invoke('tails:desktop-pet-state'),
  },

  /** Fires when the pet's context menu asks for Settings. */
  onOpenSettings: (handler) => {
    ipcRenderer.on('tails:open-settings', () => handler());
  },

  /**
   * Fires when the desktop pet's own settings button is pressed.
   *
   * Carries the pet it was pressed on, because the app may be showing a
   * different conversation with a different pet in it, and the panel is about
   * the one you clicked.
   */
  onOpenPetDetails: (handler) => {
    ipcRenderer.on('tails:open-pet-details', (_event, petId) => handler(String(petId || '')));
  },
});
