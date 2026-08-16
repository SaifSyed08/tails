/**
 * The app's handle on the always-on-top desktop pet.
 *
 * A thin, typed wrapper over the Electron bridge that no-ops in a browser, so
 * calling it never needs a `window.tailsDesktop &&` guard at the call site and
 * the same code runs in both builds.
 *
 * Two switches, deliberately not one:
 *
 * - `hide` is the user's own decision. It persists across restarts and is what
 *   the pet's right-click menu sets.
 * - `suppress` is a handoff. When a pet is dropped into a conversation and an
 *   in-window pet takes over, the desktop one steps aside — and when the
 *   conversation is closed it comes back, because nothing about the user's
 *   preference changed.
 *
 * Collapsing them into one flag would mean a handoff silently overwriting a
 * setting the user chose, and then not restoring it.
 */

type DesktopPetBridge = {
  suppress: (value: boolean) => void;
  hide: (value: boolean) => void;
  refresh: () => void;
  resetPosition: () => void;
  readState: () => Promise<{ hidden: boolean }>;
};

type TailsDesktop = {
  isDesktop?: boolean;
  desktopPet?: DesktopPetBridge;
};

function bridge(): DesktopPetBridge | null {
  const desktop = (window as unknown as { tailsDesktop?: TailsDesktop }).tailsDesktop;
  return desktop?.desktopPet ?? null;
}

/** False in a browser, where there is no window to float. */
export const hasDesktopPet = (): boolean => bridge() !== null;

/** Steps the desktop pet aside for an in-window one. Reversible, and not persisted. */
export const suppressDesktopPet = (value: boolean): void => bridge()?.suppress(value);

/** The user's own hide, as set by the pet's context menu. Persisted by the shell. */
export const hideDesktopPet = (value: boolean): void => bridge()?.hide(value);

/**
 * Tells the pet window to re-read the active pet immediately.
 *
 * It polls on its own, so this only buys a couple of seconds — but those are
 * the two seconds right after someone clicks "Set active", which is exactly
 * when a companion appearing late feels broken.
 */
export const refreshDesktopPet = (): void => bridge()?.refresh();

/**
 * Brings the pet back to its corner and shows it.
 *
 * The only control that does not require hitting the sprite first, which is
 * what makes it the way out of a pet that has ended up somewhere unclickable.
 */
export const resetDesktopPetPosition = (): void => bridge()?.resetPosition();

export const readDesktopPetState = async (): Promise<{ hidden: boolean } | null> =>
  (await bridge()?.readState()) ?? null;
