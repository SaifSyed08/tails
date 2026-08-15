import { setPinnedMode } from '@/components/appearance/colorMode';
import { writeLiveTokens } from '@/components/appearance/liveTokens';
import { refreshPointerTracking } from '@/components/appearance/pointerTokens';
import { applyFreeformCss } from '@/theme/applyTheme';

import type { AppearanceState } from '../../../server/modules/appearance/layer-state';

/**
 * Writes a complete appearance state to the document.
 *
 * The counterpart to `reduceAppearance`, and the half that makes the invariant
 * real rather than merely modelled. It takes a whole state and writes **every**
 * layer it owns, unconditionally, every time — there is no "if this changed"
 * anywhere below, and that is deliberate. A commit that only wrote what it
 * thought had changed would be the accumulation bug again, one level up: three
 * separate user-visible defects (a cursor glow outliving its theme, a texture
 * surviving a change of preset, a pinned dark mode surviving the adaptive theme
 * after it) all came from exactly that reasoning applied by exactly that
 * argument.
 *
 * Writing all four costs a stylesheet `replaceSync` and a class toggle. That is
 * far cheaper than the class of bug it removes, and it means adding a fifth
 * layer requires adding one line here — a step nobody can forget, because
 * forgetting it means the layer never renders at all rather than never
 * clearing.
 *
 * **What it does not own.** The derived theme stylesheet belongs to
 * `AppearanceContext` / `applyTheme.ts`, which wraps it in a view transition and
 * preloads its fonts. That layer is already residue-free — `replaceSync`
 * replaces the whole sheet — so it needs no teardown here; what it does need is
 * for everything *else* to be reset alongside it, which is what this does.
 */
export function commitAppearance(state: AppearanceState): void {
  // The author-written layer above the theme. Empty string drops it.
  applyFreeformCss(state.freeformCss);

  // The knobs the user has dragged, as `:root:root` custom properties. Passing
  // the whole map rather than the changed key is what clears a knob belonging
  // to a look that is no longer on screen.
  writeLiveTokens(state.controlValues);

  // Hands the colour mode back to the user when the incoming theme pins
  // nothing. Passing `null` is the release; not calling this was the bug.
  setPinnedMode(state.pinnedMode);

  // The pointer writer runs only while something reads its output, and what
  // reads it just changed.
  refreshPointerTracking();
}
