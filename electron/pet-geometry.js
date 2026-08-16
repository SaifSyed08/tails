/**
 * Turning a point in the app's page into a point on the screen.
 *
 * The desktop pet is a window, and windows live in DIPs: `setPosition`,
 * `getBounds` and `screen.getCursorScreenPoint` all speak them. The app's chat
 * is a web page, and pages live in CSS pixels. Those two units are *not* the
 * same, and the difference is not a constant — it is the page's zoom factor,
 * which the user can change with Ctrl+= at any time.
 *
 * Handing a renderer coordinate straight to `setPosition` therefore produces an
 * error proportional to how far the point is from the origin: correct in the
 * top-left corner of the page and further off the further the hand travels.
 * That is exactly what "his apparent position always goes to the left as I drag
 * him out" was, and it is why this conversion is a named function with a test
 * rather than an addition somewhere in an IPC handler.
 */

/**
 * @param {{ x: number, y: number }} contentOrigin
 *   The app window's **content** bounds origin, in DIPs. Content, not window:
 *   a frameless or shadowed window carries an invisible frame — 20px across and
 *   32px down on this machine — and the page's (0, 0) is the top-left of the
 *   drawing area, not of that frame.
 * @param {number} zoomFactor The sending page's zoom. 1 when nobody has zoomed.
 * @param {number} clientX Page coordinates, in CSS pixels.
 * @param {number} clientY
 * @returns {{ x: number, y: number }} The same point, in screen DIPs.
 */
export function clientPointToDip(contentOrigin, zoomFactor, clientX, clientY) {
  // A zoom of zero, NaN or undefined is a broken reading, and multiplying by it
  // would put the pet in the corner of the screen. 1 is the honest fallback:
  // wrong only for a user who has zoomed, and wrong by the amount they zoomed.
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;

  return {
    x: contentOrigin.x + clientX * zoom,
    y: contentOrigin.y + clientY * zoom,
  };
}

/**
 * The window size that keeps the pet looking the same on a different screen.
 *
 * A DIP is not a fixed number of pixels: it is one physical pixel on a screen
 * running at 100% and 1.03 of one on this machine's fractionally scaled
 * display. So a window of a fixed DIP size carried between two monitors changes
 * apparent size, which is what "he should have a scale update when he's dragged
 * into a monitor of a different size" is about.
 *
 * The page reports the size it wants in CSS pixels, which it works out on no
 * particular display. Those are treated as belonging to the *primary* screen —
 * the one the user set his size up on — and converted for whichever screen he
 * is standing on now. That makes this the identity on a single-monitor machine,
 * which matters: nobody's pet should change size because this function exists.
 *
 * @param {{ width: number, height: number }} reported CSS pixels, from the page.
 * @param {number} referenceFactor The primary display's scale factor.
 * @param {number} displayFactor The scale factor of the display he is on.
 */
export function sizeForScaleFactor(reported, referenceFactor, displayFactor) {
  const reference = Number.isFinite(referenceFactor) && referenceFactor > 0 ? referenceFactor : 1;
  const factor = Number.isFinite(displayFactor) && displayFactor > 0 ? displayFactor : 1;
  const ratio = reference / factor;

  return {
    width: Math.round(reported.width * ratio),
    height: Math.round(reported.height * ratio),
  };
}
