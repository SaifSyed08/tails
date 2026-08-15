import { themeSpecV2Schema, type ThemeSpecV2 } from '@/modules/appearance/theme-spec.js';

/**
 * The shipped reference looks.
 *
 * Source constants rather than seeded database rows: presets then improve with
 * a release instead of a migration, a user cannot delete or corrupt them, and
 * CI can assert that all of them validate and pass contrast in both ramps —
 * which makes them regression tests for the derivation, not just examples.
 *
 * They are also the primary teaching surface. A model shown three tasteful
 * variations on one card learns that a theme is a hue rotation; every preset
 * here differs **structurally** from the others — in shadow topology, corner
 * geometry, fill composition and border strategy — so the range it learns is
 * the range the engine actually has. If a new preset can be described as
 * "like an existing one but bluer", it is not earning its place.
 */

const PRESET_SPECS: Record<string, unknown> = {
  // There is deliberately no glass preset here. See the note at the bottom of
  // this file: glass is what the primitives *do*, and shipping it as a named
  // look was how the engine came to be tested with the answer written into the
  // question.
  neumorphic: {
    specVersion: 2,
    name: 'Neumorphic',
    summary: 'Surfaces extruded from the page itself, lit from the top-left by a mirrored shadow pair.',
    mode: 'adaptive',
    palette: {
      surfaceHue: 225, surfaceChroma: 'tinted',
      accentHue: 258, accentChroma: 'muted',
      scheme: 'analogous', statusHueShift: 0,
    },
    // A neumorphic surface *is* the background, so the ramp needs headroom on
    // both sides: neither pole works as an anchor.
    surface: { lightAnchor: 'paper', darkAnchor: 'dim', step: 3, contrastTarget: 'aa' },
    type: {
      sansFamily: 'geometric', displayFamily: 'geometric', monoFamily: 'mono',
      scale: 'default', displayWeight: 'medium', letterSpacing: 'normal',
      lineHeight: 'default', measure: 'default',
    },
    density: 'airy',
    motion: 'calm',
    surfaces: {
      default: {
        // Same colour as the page: the form comes entirely from the light.
        fill: [{ kind: 'solid', stops: [{ color: { role: 'surface', tier: 0 } }] }],
        border: { style: 'none', width: 0 },
        corner: { radius: 22, shape: 'squircle' },
        shadows: [
          { x: -6, y: -6, blur: 14, color: { role: 'light', tier: 6 }, alpha: 0.75 },
          { x: 6, y: 6, blur: 14, color: { role: 'shadow', tier: 5 }, alpha: 0.5 },
        ],
        texture: { kind: 'none' },
        overlay: { kind: 'none' },
      },
      sidebar: {
        // The rail has to read as a different plane from the transcript beside
        // it. `surface` is the role that can say that in both ramps at once —
        // it walks toward the ink pole, so tier N is "N steps more contrasty
        // than the page" whether the page is paper or OLED black. `light` and
        // `shadow` each run out of headroom at one end and would flatten the
        // sidebar back into the chat in half the themes.
        fill: [{ kind: 'solid', stops: [{ color: { role: 'surface', tier: 2 } }] }],
        // Extruded panels on an extruded rail is one extrusion too many, so
        // the rail is simply a lower plane with no shadow pair of its own.
        shadows: [],
        corner: { radius: 0, shape: 'square' },
      },
      input: {
        // The same pair, inverted: pressed in rather than pushed out.
        shadows: [
          { inset: true, x: -4, y: -4, blur: 10, color: { role: 'light', tier: 6 }, alpha: 0.7 },
          { inset: true, x: 4, y: 4, blur: 10, color: { role: 'shadow', tier: 5 }, alpha: 0.55 },
        ],
      },
      code: {
        shadows: [
          { inset: true, x: -3, y: -3, blur: 8, color: { role: 'light', tier: 5 }, alpha: 0.6 },
          { inset: true, x: 3, y: 3, blur: 8, color: { role: 'shadow', tier: 5 }, alpha: 0.5 },
        ],
        corner: { radius: 14 },
      },
      bubbleUser: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'accent' } }] }],
        shadows: [
          { x: -4, y: -4, blur: 10, color: { role: 'light', tier: 5 }, alpha: 0.5 },
          { x: 5, y: 5, blur: 12, color: { role: 'shadow', tier: 5 }, alpha: 0.45 },
        ],
      },
      scrim: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'shadow', tier: 9, alpha: 0.4 } }] }],
        shadows: [],
        corner: { radius: 0, shape: 'square' },
      },
    },
  },

  terminal: {
    specVersion: 2,
    name: 'Terminal',
    summary: 'Amber phosphor on true black, with scanlines and a CRT bloom on every glyph.',
    mode: 'dark',
    // Amber rather than green. Both were real phosphors — P3 amber was the
    // standard on the terminals people actually spent their days at, because
    // it is the easier of the two to read for hours — and the warm cast makes
    // the scanlines and the glyph bloom read as a screen rather than as a
    // filter over a web page.
    palette: {
      surfaceHue: 34, surfaceChroma: 'tinted',
      accentHue: 38, accentChroma: 'electric',
      scheme: 'mono', statusHueShift: 0,
    },
    surface: { lightAnchor: 'mid', darkAnchor: 'true-black', step: 4, contrastTarget: 'max' },
    type: {
      sansFamily: 'mono', displayFamily: 'mono', monoFamily: 'mono',
      scale: 'compact', displayWeight: 'bold', letterSpacing: 'wide',
      lineHeight: 'tight', measure: 'full',
    },
    density: 'tight',
    motion: 'instant',
    surfaces: {
      default: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'surface', tier: 0 } }] }],
        border: { style: 'none', width: 0 },
        corner: { radius: 0, shape: 'square' },
        shadows: [],
        texture: { kind: 'scanline', opacity: 0.1, scale: 1, blend: 'overlay' },
        overlay: { kind: 'vignette', strength: 0.3 },
        ink: { glow: 0.55 },
      },
      sidebar: {
        // The rail has to read as a different plane from the transcript beside
        // it. `surface` is the role that can say that in both ramps at once —
        // it walks toward the ink pole, so tier N is "N steps more contrasty
        // than the page" whether the page is paper or OLED black. `light` and
        // `shadow` each run out of headroom at one end and would flatten the
        // sidebar back into the chat in half the themes.
        fill: [{ kind: 'solid', stops: [{ color: { role: 'surface', tier: 2 } }] }],
        border: { width: 1, sides: ['right'], style: 'solid', color: { role: 'accent', alpha: 0.45 } },
        texture: { kind: 'scanline', opacity: 0.14, scale: 1 },
      },
      code: {
        border: { width: 1, style: 'solid', color: { role: 'accent', alpha: 0.4 } },
        fill: [{ kind: 'solid', stops: [{ color: { role: 'accent', tier: 1, alpha: 0.12 } }] }],
        texture: { kind: 'scanline', opacity: 0.16, scale: 1 },
        ink: { glow: 0.7 },
      },
      input: {
        border: { width: 1, sides: ['bottom'], color: { role: 'accent', alpha: 0.6 } },
        ink: { glow: 0.6 },
      },
      popover: {
        border: { width: 1, style: 'solid', color: { role: 'accent', alpha: 0.5 } },
        fill: [{ kind: 'solid', stops: [{ color: { role: 'surface', tier: 0 } }] }],
        shadows: [{ x: 0, y: 0, blur: 24, color: { role: 'accent' }, alpha: 0.25 }],
      },
      scrim: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'shadow', tier: 12, alpha: 0.75 } }] }],
        texture: { kind: 'scanline', opacity: 0.2, scale: 1 },
        overlay: { kind: 'none' },
      },
    },
  },

  prism: {
    specVersion: 2,
    name: 'Prism',
    // The idea the name carries: the page is white light, and colour only
    // appears where the user touches it — the caret, the pointer, the click.
    // That is also why it is not called after the search engine whose palette
    // it borrows; naming it that would make it a costume rather than a look.
    summary: 'White paper and black ink, with colour only where you are — a caret that cycles and a pointer that leaves light behind.',
    mode: 'light',
    palette: {
      surfaceHue: 220, surfaceChroma: 'neutral',
      accentHue: 217, accentChroma: 'vivid',
      scheme: 'triad', statusHueShift: 0,
    },
    // True white and a hard black ink target: he asked for white background and
    // black text, and `max` is what stops the solver settling for charcoal on
    // off-white the way `aa` happily would.
    // AAA rather than `max`. `max` pushes every pair to the poles, which is
    // right for a CRT and wrong here: it demands 21:1 on the accent-filled user
    // bubble and on the modal scrim, and no colour reads at 21:1 on a mid-blue.
    // Asking for a target a surface cannot meet does not make the surface
    // better, it just makes the solver report a failure.
    surface: { lightAnchor: 'true-white', darkAnchor: 'near-black', step: 6, contrastTarget: 'aaa' },
    type: {
      sansFamily: 'grotesk', displayFamily: 'grotesk', monoFamily: 'mono',
      scale: 'default', displayWeight: 'medium', letterSpacing: 'normal',
      lineHeight: 'default', measure: 'default',
    },
    density: 'default',
    motion: 'playful',
    interaction: {
      // The four logo hues in the order the logo actually runs them: blue, red,
      // yellow, green. Four stops rather than six because the caret is two
      // pixels wide and nobody can tell six colours apart at that size.
      caretCycle: [
        { role: 'accent' },
        { role: 'destructive' },
        { role: 'warning' },
        { role: 'positive' },
      ],
      caretCycleSeconds: 3.2,
      // The closest CSS gets to "slightly thicker". There is no caret-width
      // property in any engine, so the choice is bar, block or underscore —
      // block is the only one that reads as heavier, and it is a fair reading
      // of the request even though it overshoots it.
      caretShape: 'block',
      selectionFill: { role: 'accent', alpha: 0.22 },
      pointer: {
        // A companion halo, not a replacement: the native arrow stays, so
        // there is no frame of lag to notice.
        kind: 'halo',
        size: 64,
        opacity: 0.3,
        blend: 'multiply',
        replace: false,
        color: { role: 'accent' },
        trail: { kind: 'comet', length: 10, size: 16, opacity: 0.32 },
        click: { kind: 'ripple', size: 88, seconds: 0.5 },
      },
    },
    surfaces: {
      default: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'surface', tier: 0 } }] }],
        border: { width: 1, color: { role: 'ink', alpha: 0.12 } },
        corner: { radius: 14, shape: 'round' },
        // One soft ambient drop and nothing else: the page is paper, and the
        // colour budget is spent entirely on the pointer and the caret.
        shadows: [{ y: 1, blur: 3, color: { role: 'shadow', tier: 6 }, alpha: 0.1 }],
        texture: { kind: 'none' },
        overlay: { kind: 'none' },
      },
      sidebar: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'surface', tier: 2 } }] }],
        border: { width: 1, sides: ['right'], color: { role: 'ink', alpha: 0.12 } },
        shadows: [],
        corner: { radius: 0, shape: 'square' },
      },
      bubbleUser: {
        // A tint rather than a solid accent fill. The look is black ink on
        // white with colour only at the points of interaction, and a saturated
        // blue bubble full of white text is neither — it is also the one
        // surface that cannot reach this theme's AAA target, because no colour
        // reads at 7:1 on a mid-blue.
        fill: [{ kind: 'solid', stops: [{ color: { role: 'accent', alpha: 0.14 } }] }],
        border: { width: 1, color: { role: 'accent', alpha: 0.35 } },
        corner: { radius: 18, shape: 'squircle' },
      },
      input: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'surface', tier: 1 } }] }],
        border: { width: 1, color: { role: 'ink', alpha: 0.18 } },
        shadows: [],
      },
      code: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'surface', tier: 1 } }] }],
        border: { width: 1, sides: ['left'], color: { role: 'accent' } },
        shadows: [],
      },
      scrim: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'ink', alpha: 0.32 } }] }],
        border: { style: 'none' },
        corner: { radius: 0, shape: 'square' },
        shadows: [],
      },
    },
  },

  paper: {
    specVersion: 2,
    name: 'Paper',
    summary: 'Warm, quiet and editorial — a serif display over off-white stock with a fibre tooth.',
    mode: 'adaptive',
    palette: {
      surfaceHue: 44, surfaceChroma: 'tinted',
      accentHue: 24, accentChroma: 'muted',
      scheme: 'analogous', statusHueShift: 0,
    },
    // AAA, to show what the target actually costs: nothing here is
    // accent-filled, so the extra contrast is free.
    surface: { lightAnchor: 'paper', darkAnchor: 'deep', step: 5, contrastTarget: 'aaa' },
    type: {
      sansFamily: 'humanist', displayFamily: 'serif', monoFamily: 'mono',
      scale: 'default', displayWeight: 'bold', letterSpacing: 'normal',
      lineHeight: 'default', measure: 'default',
    },
    density: 'default',
    motion: 'calm',
    surfaces: {
      default: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'light', tier: 1 } }] }],
        border: { width: 1, color: { role: 'border' } },
        corner: { radius: 8, shape: 'round' },
        shadows: [{ y: 1, blur: 2, color: { role: 'shadow', tier: 6 }, alpha: 0.1 }],
        texture: { kind: 'paper', opacity: 0.055, scale: 1, blend: 'multiply' },
        overlay: { kind: 'topLight', strength: 0.08 },
      },
      sidebar: {
        // The rail has to read as a different plane from the transcript beside
        // it. `surface` is the role that can say that in both ramps at once —
        // it walks toward the ink pole, so tier N is "N steps more contrasty
        // than the page" whether the page is paper or OLED black. `light` and
        // `shadow` each run out of headroom at one end and would flatten the
        // sidebar back into the chat in half the themes.
        fill: [{ kind: 'solid', stops: [{ color: { role: 'surface', tier: 2 } }] }],
        border: { width: 1, sides: ['right'], color: { role: 'ink', alpha: 0.16 } },
        shadows: [],
        corner: { radius: 0, shape: 'square' },
      },
      code: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'shadow', tier: 1, alpha: 0.35 } }] }],
        texture: { kind: 'none' },
        shadows: [],
      },
      scrim: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'shadow', tier: 8, alpha: 0.4 } }] }],
        corner: { radius: 0, shape: 'square' },
        border: { style: 'none' },
        shadows: [],
      },
    },
  },

  bloom: {
    specVersion: 2,
    name: 'Bloom',
    summary: 'Soft pink clay: deep round corners, a diffuse drop and a bright inner top light.',
    mode: 'adaptive',
    palette: {
      surfaceHue: 330, surfaceChroma: 'rich',
      accentHue: 336, accentChroma: 'vivid',
      scheme: 'analogous', statusHueShift: 4,
    },
    surface: { lightAnchor: 'paper', darkAnchor: 'dim', step: 5, contrastTarget: 'aa' },
    type: {
      sansFamily: 'humanist', displayFamily: 'geometric', monoFamily: 'mono',
      scale: 'default', displayWeight: 'bold', letterSpacing: 'normal',
      lineHeight: 'default', measure: 'default',
    },
    density: 'airy',
    motion: 'playful',
    surfaces: {
      default: {
        fill: [{ kind: 'linear', angle: 175, stops: [
          { color: { role: 'light', tier: 3 } },
          { color: { role: 'light', tier: 1 } },
        ] }],
        border: { style: 'none', width: 0 },
        corner: { radius: 26, shape: 'squircle' },
        // Clay: one tight contact shadow, one wide ambient, one inner top light.
        shadows: [
          { inset: true, y: 2, blur: 4, color: { role: 'light', tier: 10 }, alpha: 0.65 },
          { y: 2, blur: 4, color: { role: 'shadow', tier: 4 }, alpha: 0.14 },
          { y: 12, blur: 28, spread: -6, color: { role: 'shadow', tier: 6 }, alpha: 0.24 },
        ],
        texture: { kind: 'none' },
        overlay: { kind: 'topLight', strength: 0.16 },
      },
      sidebar: {
        // The rail has to read as a different plane from the transcript beside
        // it. `surface` is the role that can say that in both ramps at once —
        // it walks toward the ink pole, so tier N is "N steps more contrasty
        // than the page" whether the page is paper or OLED black. `light` and
        // `shadow` each run out of headroom at one end and would flatten the
        // sidebar back into the chat in half the themes.
        fill: [{ kind: 'solid', stops: [{ color: { role: 'surface', tier: 2 } }] }],
        shadows: [],
        corner: { radius: 0, shape: 'square' },
        overlay: { kind: 'none' },
      },
      bubbleUser: {
        fill: [{ kind: 'linear', angle: 175, stops: [
          { color: { role: 'accent', tier: 7 } },
          { color: { role: 'accent' } },
        ] }],
        corner: { radius: 22, shape: 'round' },
      },
      input: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'shadow', tier: 1, alpha: 0.18 } }] }],
        shadows: [{ inset: true, y: 2, blur: 6, color: { role: 'shadow', tier: 5 }, alpha: 0.2 }],
        overlay: { kind: 'none' },
      },
      scrim: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'shadow', tier: 8, alpha: 0.42 } }] }],
        corner: { radius: 0, shape: 'square' },
        shadows: [],
        overlay: { kind: 'none' },
      },
    },
  },
};

/**
 * Presets, parsed through the schema at module load.
 *
 * Parsing rather than casting means a preset with a typo is a startup crash in
 * development instead of a theme that silently loses a field — and it fills in
 * the schema defaults, so what ships is exactly what a model would get back
 * from `theme_preview`.
 */
export const THEME_PRESETS: Record<string, ThemeSpecV2> = Object.fromEntries(
  Object.entries(PRESET_SPECS).map(([id, spec]) => [id, themeSpecV2Schema.parse(spec)]),
);

export type PresetId = keyof typeof THEME_PRESETS;

/**
 * Why `liquidGlass` is not in this file.
 *
 * It used to be, and then "make it liquid glass" was used to check whether the
 * engine could produce glass. It could, and the check meant nothing: the answer
 * had been written into the question.
 *
 * The failure is subtler than one bad preset. Any system that hands a model a
 * list of finished looks and a way to apply one has made preset-picking the
 * cheapest correct-looking action available, and the model is not cheating when
 * it picks — it is doing the obvious thing with the affordances it was given.
 * For composition to be what happens, composition has to be the only path.
 *
 * Glass is not a style this app knows. It is a translucent fill, a wide
 * backdrop blur with saturation, a bright specular ring on the light-facing
 * edge, and a soft ambient shadow — four primitives that already exist here,
 * every one of them used by some other preset for some other purpose. That it
 * composes is asserted in `tests/glass-composition.test.ts`, which builds the
 * spec from those primitives and checks the emitted CSS carries all four. If it
 * ever stops composing, that is a missing primitive and a real bug; a preset
 * would only have hidden it.
 *
 * The remaining presets stay for the opposite reason: they are worked examples
 * a model reads to learn *how* a look is constructed, and each differs
 * structurally from the others rather than in hue. `theme_list` says so in its
 * own description, because the description is the only channel through which
 * that distinction can be taught.
 */
