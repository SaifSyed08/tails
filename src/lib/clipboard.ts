/**
 * Putting text on the clipboard, and knowing whether it worked.
 *
 * ## Why this is not one line
 *
 * `navigator.clipboard.writeText` is the right API and it fails quietly in more
 * ways than it looks. The copy button on a message did nothing for exactly this
 * reason: Electron's permission handler denied everything but the microphone, so
 * the write was refused before it reached the OS — and the call site swallowed
 * the rejection, so there was nothing on screen and nothing in the console.
 *
 * The permission is granted now, but the API can still refuse for reasons that
 * have nothing to do with this app: the document not being focused, a
 * non-secure context, a browser that has never implemented it. So there is a
 * fallback, and — more importantly — the result is *returned* rather than
 * discarded, because a copy button that lies is worse than one that is missing.
 *
 * ## The fallback
 *
 * `document.execCommand('copy')` is deprecated and works everywhere, which is
 * the trade being made deliberately. It needs a real selection, so a textarea is
 * placed off-screen, filled, selected and removed. `position: fixed` with a tiny
 * size rather than `display: none`: a hidden element cannot hold a selection, and
 * moving the page is what an off-screen absolute position would do.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through. The reason does not change what to try next.
  }

  try {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    // Off-screen but rendered, and never focusable by tab.
    field.style.cssText = 'position:fixed;top:0;left:-9999px;width:1px;height:1px;opacity:0;';
    field.tabIndex = -1;

    document.body.append(field);
    field.select();
    field.setSelectionRange(0, text.length);

    const ok = document.execCommand('copy');
    field.remove();
    return ok;
  } catch {
    return false;
  }
}
