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

  /** Put the pet away. Now reached through his details rather than the pill. */
  hidePet: () => ipcRenderer.send('pet:hide'),

  /**
   * The pill's microphone: turn voice mode on or off in the app.
   *
   * Sent as a toggle rather than a state, because this window does not know
   * whether the app is listening — only that the button was pressed. The app
   * decides and reports back through `onVoiceState`.
   */
  toggleVoice: () => ipcRenderer.send('pet:voice-toggle'),

  /** The app says whether it is listening. See the note on the button. */
  onVoiceState: (handler) => {
    ipcRenderer.on('pet:voice-state', (_event, listening) => handler(listening === true));
  },

  /**
   * The pill's arrow: go back into the chat.
   *
   * Only reachable while the app is showing a conversation this pet belongs to —
   * see `onDock` — so there is always somewhere for it to land.
   */
  dockPet: (petId) => ipcRenderer.send('pet:dock', { petId }),

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
   * Sent whenever the shell shows him, and whenever it takes click-through
   * back on its own. Anything the page believes about the pointer is out of
   * date by then, and a stale belief here is a pet that cannot be picked up.
   *
   * Carries `{ carrying }`, because whether a carry is still live is the
   * shell's to know: the page agrees with it rather than the shell skipping the
   * message to protect a carry that may have ended long ago.
   */
  onResync: (handler) => ipcRenderer.on('pet:resync', (_event, state) => handler(state)),

  /**
   * The shell asking where the pointer is, because the page cannot always know.
   *
   * A drag region does not deliver mouse events, so a pointer that lands
   * straight on the pet's drag band arrives without the page ever seeing it —
   * and the window stays click-through, which means the band is never reached
   * either. The shell can see the cursor; this is it asking the page to run the
   * same alpha test it would have run on a move.
   */
  onProbe: (handler) => ipcRenderer.on('pet:probe', (_event, point) => handler(point)),

  /**
   * What he has to tell the user, or null for nothing.
   *
   * Pushed by the shell rather than polled: the page's own poll is 2.5 seconds
   * wide, which is the wrong latency in both directions for "your work is
   * finished" — late to appear, and still up after you have dealt with it.
   */
  onAlert: (handler) => ipcRenderer.on('pet:alert', (_event, alert) => handler(alert)),

  /**
   * Whether the arrow applies, and which way it points.
   *
   * Both are facts only the shell has: whether the app is showing this pet's
   * conversation is something the app reports to it, and the bearing between two
   * windows is not visible from inside either of them.
   */
  onDock: (handler) => ipcRenderer.on('pet:dock-state', (_event, state) => handler(state)),

  /** The bubble was clicked: go to that conversation. */
  openAlert: (sessionId) => ipcRenderer.send('pet:alert-open', { sessionId }),

  /** The bubble's X: he stops asking about that one. */
  dismissAlert: (sessionId) => ipcRenderer.send('pet:alert-dismiss', { sessionId }),

  /**
   * Which drag mechanism is live, while three are being compared.
   *
   * Temporary, and worth removing once one is chosen — the page has no business
   * knowing how the shell moves the window, and only shows it so the person
   * switching can tell which one they are feeling.
   */
});
