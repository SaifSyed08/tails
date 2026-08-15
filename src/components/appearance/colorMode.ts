/**
 * The single owner of the `dark` class on the root element.
 *
 * There were two owners before this, which is one more than a boolean can
 * safely have. `index.html` sets the class pre-paint from `localStorage`, and
 * `applyTheme.ts` adds it when a theme pins dark and removes it when a theme
 * pins light — and does *nothing* when a theme pins neither. So a pinned dark
 * theme followed by an adaptive one left `.dark` stuck on: the new theme's
 * light ramp was loaded, every `dark:` utility in the app was still on the dark
 * branch, and the result was a look nobody designed. Same class of bug as the
 * cursor glow and the surviving texture — state applied by one path and cleared
 * by none.
 *
 * So there is one function that decides, and it decides from all three inputs
 * at once:
 *
 *   pinned mode (a theme owns the choice)  >  user preference  >  the OS
 *
 * and it is re-run on every appearance change and on every OS change. Nothing
 * else may touch the class. `applyTheme.ts` still does, and that is harmless
 * rather than fixed: its two lines only ever agree with what this computes a
 * moment later, and leaving them alone keeps this change inside its own module.
 */

export type ColorModePreference = 'light' | 'dark' | 'system';

/** Shared with the pre-paint script in `index.html`, which reads the same key. */
const STORAGE_KEY = 'tails.colorMode';

export type ColorModeSnapshot = {
  /** What the user asked for. */
  preference: ColorModePreference;
  /** What is actually on screen, after the theme and the OS have had their say. */
  effective: 'light' | 'dark';
  /**
   * Set when the current theme owns the choice.
   *
   * A CRT terminal makes no sense on white, so a theme is allowed to pin the
   * mode — but then the user's control has to visibly stop working rather than
   * silently doing nothing, which is why this is part of the snapshot and not a
   * private detail.
   */
  pinnedMode: 'light' | 'dark' | null;
};

const readStored = (): ColorModePreference => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // A blocked localStorage costs the preference, not the app.
  }
  // Dark, matching the pre-paint script's default: this app has always opened
  // dark, and inheriting the OS by default would change that for everyone.
  return 'dark';
};

const prefersDark = (): boolean =>
  typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-color-scheme: dark)').matches;

let preference: ColorModePreference = typeof window === 'undefined' ? 'dark' : readStored();
let pinnedMode: 'light' | 'dark' | null = null;

const listeners = new Set<() => void>();

/**
 * Cached because `useSyncExternalStore` compares snapshots by identity.
 *
 * Returning a fresh object each read would make React consider the store
 * changed on every render and loop.
 */
let snapshot: ColorModeSnapshot = { preference, effective: 'dark', pinnedMode: null };

const resolve = (): 'light' | 'dark' => {
  if (pinnedMode) return pinnedMode;
  if (preference === 'system') return prefersDark() ? 'dark' : 'light';
  return preference;
};

function paint(): void {
  const effective = resolve();

  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('dark', effective === 'dark');
  }

  if (snapshot.preference === preference
    && snapshot.effective === effective
    && snapshot.pinnedMode === pinnedMode) {
    return;
  }

  snapshot = { preference, effective, pinnedMode };
  for (const listener of listeners) listener();
}

/** What the user asked for. Persisted, and re-applied immediately. */
export function setColorModePreference(next: ColorModePreference): void {
  preference = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // The choice still holds for this session.
  }
  paint();
}

/**
 * Records that the current theme owns the mode, or hands it back.
 *
 * Called from `commitAppearance` on *every* appearance change, including the
 * ones that pin nothing — passing `null` is what releases the override, and not
 * calling it at all is the bug this module was written for.
 */
export function setPinnedMode(next: 'light' | 'dark' | null): void {
  pinnedMode = next;
  paint();
}

export function readColorMode(): ColorModeSnapshot {
  return snapshot;
}

export function subscribeColorMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Starts following the OS setting. Returns the stop function.
 *
 * The live listener is the point. Reading `prefers-color-scheme` once at boot
 * makes "system" mean "whatever the system was when you launched the app",
 * which is wrong every evening for anyone on a scheduled OS theme.
 */
export function startColorMode(): () => void {
  paint();

  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }

  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    // Repainting unconditionally rather than only when the preference is
    // "system": `paint` is idempotent and already compares before notifying, so
    // the check would only be a second place for the condition to be wrong.
    paint();
  };

  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}
