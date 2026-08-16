/**
 * Putting the pet down outside the app.
 *
 * Carrying the in-chat pet past the edge of the chat hands him to the desktop
 * window, and he should appear where the hand opened — not back wherever that
 * window happened to be left, which reads as him teleporting rather than as him
 * being put down.
 *
 * Typed here, narrowly, rather than added to the marketplace's desktop bridge:
 * that file belongs to another surface, and this needs one call from one place.
 * A browser has no shell at all, so every path through this is optional.
 */

type PlacingBridge = {
  place?: (x: number, y: number) => void;
};

type TailsDesktop = {
  desktopPet?: PlacingBridge;
};

/**
 * Moves the desktop pet to a point in screen coordinates.
 *
 * Silent when there is no shell, and silent when the shell is older than this
 * call: a pet who reappears in his last corner is a worse handoff, not a broken
 * app, and there is nothing the user could do about it either way.
 */
export function placeDesktopPetAt(screenX: number, screenY: number): void {
  const bridge = (window as unknown as { tailsDesktop?: TailsDesktop }).tailsDesktop?.desktopPet;
  bridge?.place?.(screenX, screenY);
}
