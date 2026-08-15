/**
 * The complete appearance state, and the only rule for how it changes.
 *
 * ## The bug this file exists to make impossible
 *
 * Appearance is not one stylesheet, it is six things: the derived theme sheet,
 * the freeform `css` sheet, the live-control overrides, the pointer tokens and
 * the DOM that reads them, the ambient paint layers, and the colour-mode class
 * on the root element. Every one of them was applied by whichever code path
 * happened to produce it, and none of them was *cleared* by anything except the
 * path that had set it. So state accumulated.
 *
 * That shape has now produced three separate user-visible bugs, and the third
 * is what forced this file. A cursor glow written into the freeform layer
 * outlived the theme that created it. A background texture survived switching
 * to a different preset. A pinned dark theme left `.dark` on the root after the
 * next adaptive theme replaced it. Each was diagnosed and fixed on its own,
 * which was the mistake — they are one bug, and patching the instances is how
 * you get a fourth.
 *
 * ## The invariant
 *
 * > Applying appearance state X must produce a rendering indistinguishable from
 * > a fresh app that has only ever had X applied. No residue from anything
 * > applied before it.
 *
 * That is enforced structurally rather than by remembering to clean up. A theme
 * event does not *modify* the state, it **replaces** it: everything not carried
 * by the event itself returns to its empty value in the same expression that
 * sets the new theme. There is no teardown to forget, because there is no
 * accumulation to tear down. `appliesCleanly` below is that claim as a test.
 *
 * The price is one behaviour worth stating plainly: a `theme_css` layer does
 * not survive the next theme application, including a re-preview of the same
 * spec. The alternative was a rule that tried to distinguish "the agent is
 * still composing this look" from "the user switched looks", which is exactly
 * the special case that produced the texture bug. Compose, apply, *then* layer
 * CSS — the guide says so.
 *
 * ## Why this file has no imports
 *
 * It is the one piece of the appearance engine both halves have to agree on
 * exactly, so it is shared rather than mirrored: the server reduces broadcasts
 * to know what it has published, the renderer reduces the same broadcasts to
 * know what to paint, and a divergence between the two is precisely the class
 * of bug above. Sharing means no `@/` alias (the two projects resolve it
 * differently) and no DOM, which is why the types below are spelled out rather
 * than imported from `controls.ts`.
 */

/** A published control, as the panel renders it. Mirrors `controls.ts`. */
export type AppearanceControlShape = {
  id: string;
  label: string;
  kind: 'slider' | 'toggle' | 'colour' | 'select';
  binds: string;
  help?: string;
  value: number | boolean | string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  on?: string;
  off?: string;
  options?: { label: string; value: string }[];
};

/** One proposed look, as the miniature renders it. */
export type ProposalVariantShape = {
  label: string;
  note: string;
  className: string;
  name: string;
  summary: string;
  css: string;
};

/** The `appearance_changed` payload, in the shape the reducer cares about. */
export type AppearanceEvent = {
  layer?: string;
  scope?: string;
  scopeKey?: string;
  themeId?: string;
  name?: string;
  css?: string;
  pinnedMode?: 'light' | 'dark' | null;
  controls?: AppearanceControlShape[];
  variants?: ProposalVariantShape[];
};

/**
 * Everything the appearance system is currently doing, in one value.
 *
 * If a layer is not represented here it cannot be reset by the reducer, so
 * adding a layer to the engine means adding a field here first. That ordering
 * is the whole discipline: the state is the enumeration, and
 * `RENDERER-CONTRACT.md` §1.2 is the same list in prose.
 */
export type AppearanceState = {
  /** The derived theme stylesheet. `''` is the built-in floor. */
  themeCss: string;
  themeId: string;
  themeName: string;
  /** Set when the theme owns the colour mode, disabling the user's control. */
  pinnedMode: 'light' | 'dark' | null;
  /** The author-written stylesheet layered above the theme. `''` is none. */
  freeformCss: string;
  /** The knobs the agent published for the current look. */
  controls: AppearanceControlShape[];
  controlsTitle: string;
  /** Custom properties written on `:root:root` by dragging those knobs. */
  controlValues: Record<string, string>;
  /** Candidate looks being compared. Changes nothing about the running app. */
  proposal: ProposalVariantShape[];
};

/** No theme, no stylesheet, no knobs: the built-in floor and nothing else. */
export const EMPTY_APPEARANCE_STATE: AppearanceState = {
  themeCss: '',
  themeId: 'builtin',
  themeName: 'Default',
  pinnedMode: null,
  freeformCss: '',
  controls: [],
  controlsTitle: '',
  controlValues: {},
  proposal: [],
};

/**
 * Folds one broadcast into the state.
 *
 * Note what the `theme` branch does *not* do: it does not spread the previous
 * state. That single omission is the invariant. A theme arriving resets the
 * freeform layer, the published controls, every knob the user has dragged and
 * any comparison on screen, because none of those belong to the look now being
 * applied — and doing it by construction means no future edit can add a layer
 * that quietly survives, the way every layer before it did.
 */
export function reduceAppearance(state: AppearanceState, event: AppearanceEvent): AppearanceState {
  switch (event.layer) {
    case 'theme':
      return {
        ...EMPTY_APPEARANCE_STATE,
        themeCss: event.css ?? '',
        themeId: event.themeId ?? 'builtin',
        themeName: event.name ?? 'Default',
        pinnedMode: event.pinnedMode ?? null,
      };

    case 'css':
      return { ...state, freeformCss: event.css ?? '' };

    case 'controls':
      // Republishing replaces the set *and* the dragged values: the new
      // controls carry their own `value`, and keeping a stale override would
      // make the panel open showing a number the look does not have.
      return {
        ...state,
        controls: event.controls ?? [],
        controlsTitle: (event.controls ?? []).length > 0 ? event.name ?? 'Adjust' : '',
        controlValues: {},
      };

    case 'proposal':
      return { ...state, proposal: event.variants ?? [] };

    default:
      return state;
  }
}

/** Records a knob being dragged. Separate from the reducer: no broadcast is involved. */
export function withControlValue(
  state: AppearanceState,
  binds: string,
  value: string,
): AppearanceState {
  return { ...state, controlValues: { ...state.controlValues, [binds]: value } };
}

/**
 * The state as a stable string, for comparing two histories.
 *
 * Key order is fixed rather than left to `JSON.stringify`'s insertion order, so
 * two states that render identically compare equal even if they were built by
 * different routes — which is the entire point of the comparison.
 */
export function serialiseAppearanceState(state: AppearanceState): string {
  const controlValues = Object.keys(state.controlValues).sort()
    .map((key) => `${key}=${state.controlValues[key]}`);

  return JSON.stringify({
    themeCss: state.themeCss,
    themeId: state.themeId,
    themeName: state.themeName,
    pinnedMode: state.pinnedMode,
    freeformCss: state.freeformCss,
    controls: state.controls.map((control) => `${control.id}:${control.binds}`),
    controlsTitle: state.controlsTitle,
    controlValues,
    proposal: state.proposal.map((variant) => variant.className),
  });
}

/**
 * Does this history end in the same place a fresh app would?
 *
 * The invariant, as a function, so it can be asserted over generated histories
 * rather than over the three sequences someone thought of. A `false` here is a
 * layer that survived a change it had no business surviving.
 */
export function appliesCleanly(history: AppearanceEvent[], final: AppearanceEvent): boolean {
  const viaHistory = [...history, final].reduce(reduceAppearance, EMPTY_APPEARANCE_STATE);
  const fresh = reduceAppearance(EMPTY_APPEARANCE_STATE, final);
  return serialiseAppearanceState(viaHistory) === serialiseAppearanceState(fresh);
}
