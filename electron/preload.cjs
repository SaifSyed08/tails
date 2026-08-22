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
   * The application window's own backdrop.
   *
   * The one part of the appearance system that reaches outside the page: a
   * blurred, see-through window is an operating-system effect, and no amount
   * of CSS can ask for one. The renderer decides *whether* from the active
   * theme; the shell decides whether the platform can honour it.
   */
  window: {
    setBackdrop: (kind) => ipcRenderer.send('tails:window-backdrop', String(kind || 'opaque')),
  },

  voice: {
    /**
     * Says the user has just asked to dictate.
     *
     * Device permissions are denied by default, and this is the only thing that
     * opens one — `media` becomes grantable while this is raised and refused
     * again the moment it drops. It is a bit rather than a request because the
     * main process cannot otherwise know a button was pressed: without it the
     * choice is a standing grant or no microphone at all.
     *
     * Raised immediately before `getUserMedia` and lowered as soon as capture
     * ends, so the window it opens is as short as the gesture. Note Chromium's
     * `media` covers camera and screen capture too — the narrowness here comes
     * from how briefly the flag is up, not from the permission being specific.
     */
    setIntent: (wanted) => ipcRenderer.send('tails:voice-intent', wanted === true),
  },

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

    /**
     * Whether the pet on the desktop could go back into the chat on screen.
     *
     * The app's answer to a question the shell cannot ask: it means comparing the
     * pet the desktop window is showing against the conversation's assignment.
     * Drives whether the pill offers an arrow at all.
     */
    dockable: (value) => ipcRenderer.send('tails:desktop-pet', { action: 'dockable', value }),
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

    /**
     * A conversation finished while the user may not have been watching.
     *
     * Reported rather than decided: the renderer knows the turn ended and whose
     * pet that chat has, and the shell knows whether the window is in front of
     * anybody. The shell drops this on the floor when it is.
     */
    completed: (sessionId, title) => ipcRenderer.send('tails:pet-alert', {
      action: 'completed', sessionId, title,
    }),

    /** The conversation on screen, so the pet can stop asking about it. */
    viewing: (sessionId) => ipcRenderer.send('tails:pet-alert', {
      action: 'viewing', sessionId,
    }),
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

  /**
   * The pill's arrow was pressed: put this pet back in the chat.
   *
   * The shell only carries the press; where a pet lives is the app's own state,
   * so the handler is registered on this side.
   */
  onPetDock: (handler) => {
    ipcRenderer.on('tails:pet-dock', (_event, petId) => handler(String(petId || '')));
  },

  /** Fires when the pet's notification bubble is clicked. Carries the chat to open. */
  onOpenSession: (handler) => {
    ipcRenderer.on('tails:open-session', (_event, sessionId) => handler(String(sessionId || '')));
  },
});
