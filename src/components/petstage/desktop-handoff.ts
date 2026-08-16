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
  onOpenPetDetails?: (handler: (petId: string) => void) => void;
};

const desktop = () => (window as unknown as { tailsDesktop?: TailsDesktop }).tailsDesktop;

/**
 * Moves the desktop pet to a point in *this page's* coordinates.
 *
 * Client pixels, which the shell converts — see `clientPointToDip`. A page
 * cannot answer where it is on the screen: `window.screenX` and a pointer's
 * `screenX` are both in CSS pixels, so under any zoom but 1.0 they describe a
 * position that drifts further from the truth the further the pointer travels.
 *
 * Silent when there is no shell, and silent when the shell is older than this
 * call: a pet who reappears in his last corner is a worse handoff, not a broken
 * app, and there is nothing the user could do about it either way.
 */
export function placeDesktopPetAt(clientX: number, clientY: number): void {
  desktop()?.desktopPet?.place?.(clientX, clientY);
}

/**
 * The desktop pet's own settings button was pressed.
 *
 * The panel it opens is a piece of the app, not of that little window: the pet
 * floats over everything with no room for a page, and the shell has already
 * brought the app forward by the time this fires.
 */
export function onDesktopPetDetails(handler: (petId: string) => void): void {
  desktop()?.onOpenPetDetails?.(handler);
}
