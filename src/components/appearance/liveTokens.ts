/**
 * The live-control layer: single custom properties, written straight onto
 * `:root`, above everything else the appearance system adopts.
 *
 * This is the mechanism that makes a published control *instant*. The renderer
 * already reads every themed value through `var()`, so setting one property is
 * a paint — no derivation, no validation, no round trip to the model, no
 * confirm step. A control that had to re-derive the theme would not be a
 * control, it would be a very slow prompt.
 *
 * Three decisions here are load-bearing and none of them is the obvious first
 * implementation.
 *
 * **A constructed stylesheet, not inline styles on `documentElement`.** Inline
 * styles outrank every selector, so a control written that way would also
 * outrank the theme's own `.dark` block — and the first time the user toggled
 * dark mode, every knob they had touched would stay stuck on its light value.
 * The same trap `applyTheme.ts` documents for the theme layer, one level up.
 *
 * **Re-appended to `adoptedStyleSheets` on every write.** `applyTheme.ts`
 * rebuilds that array when it first creates a layer, filtering out only *its*
 * sheets and re-appending them — which would leave this one ordered before the
 * theme it is meant to override. Cheap to make unconditional; impossible to
 * debug when it happens once at startup.
 *
 * **Cleared by the panic key for free.** `Ctrl+Alt+Shift+T` empties
 * `document.adoptedStyleSheets` from the Electron main process. Living in that
 * array rather than in an inline style or a `<style>` element with an id nobody
 * told the main process about is what keeps the recovery path complete without
 * a second copy of the reset logic in a second repository of knowledge.
 */

/** The values currently overriding the theme, keyed by custom-property name. */
const overrides = new Map<string, string>();

let sheet: CSSStyleSheet | null = null;

const supportsConstructable = (): boolean =>
  typeof CSSStyleSheet !== 'undefined'
  && 'replaceSync' in CSSStyleSheet.prototype
  && 'adoptedStyleSheets' in Document.prototype;

function write(): void {
  if (typeof document === 'undefined' || !supportsConstructable()) return;

  if (!sheet) sheet = new CSSStyleSheet();

  const body = [...overrides]
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');

  // `:root:root` rather than `:root`. The theme layer scopes surface tokens to
  // `[data-tails-part="popover"]`, which is (0,1,0) — the same specificity as a
  // bare `:root`, so a later sheet would only win for tokens the theme also set
  // on the root. Doubling makes a control beat a per-part value too, which is
  // what a user dragging "Blur" expects: every glass surface, not just the ones
  // that happened to inherit.
  sheet.replaceSync(body ? `:root:root {\n${body}\n}` : '');

  const others = document.adoptedStyleSheets.filter((adopted) => adopted !== sheet);
  document.adoptedStyleSheets = [...others, sheet];
}

/** Sets one custom property, repainting immediately. */
export function setLiveToken(name: string, value: string): void {
  overrides.set(name, value);
  write();
}

/** The current override set, for snapshotting into the undo stack. */
export function readLiveTokens(): Record<string, string> {
  return Object.fromEntries(overrides);
}

/** Replaces the whole override set — how undo restores a previous knob position. */
export function writeLiveTokens(next: Record<string, string>): void {
  overrides.clear();
  for (const [name, value] of Object.entries(next)) overrides.set(name, value);
  write();
}

/** Drops every override, revealing the theme underneath. */
export function clearLiveTokens(): void {
  overrides.clear();
  write();
}
