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
  liquidGlass: {
    specVersion: 2,
    name: 'Liquid Glass',
    summary: 'Translucent panels over a saturated backdrop, with a specular rim and a faint grain.',
    mode: 'adaptive',
    palette: {
      surfaceHue: 218, surfaceChroma: 'tinted',
      accentHue: 196, accentChroma: 'vivid',
      scheme: 'analogous', statusHueShift: 0,
    },
    surface: { lightAnchor: 'paper', darkAnchor: 'deep', step: 5, contrastTarget: 'aa' },
    type: {
      sansFamily: 'grotesk', displayFamily: 'grotesk', monoFamily: 'mono',
      scale: 'default', displayWeight: 'medium', letterSpacing: 'normal',
      lineHeight: 'default', measure: 'default',
    },
    density: 'default',
    motion: 'calm',
    surfaces: {
      default: {
        fill: [
          { kind: 'linear', angle: 160, blend: 'normal', stops: [
            { color: { role: 'light', tier: 6, alpha: 0.24 }, position: 0 },
            { color: { role: 'light', tier: 1, alpha: 0.1 }, position: 55 },
            { color: { role: 'shadow', tier: 2, alpha: 0.12 }, position: 100 },
          ] },
          { kind: 'solid', stops: [{ color: { role: 'light', tier: 1, alpha: 0.55 } }] },
        ],
        border: {
          width: 1,
          variant: 'gradient-ring',
          ring: { angle: 145, stops: [
            { color: { role: 'light', tier: 12, alpha: 0.75 }, position: 0 },
            { color: { role: 'light', tier: 6, alpha: 0.12 }, position: 40 },
            { color: { role: 'shadow', tier: 4, alpha: 0.35 }, position: 100 },
          ] },
        },
        corner: { radius: 18, shape: 'squircle' },
        shadows: [
          { inset: true, y: 1, blur: 1, color: { role: 'light', tier: 12 }, alpha: 0.4 },
          { y: 2, blur: 8, color: { role: 'shadow', tier: 6 }, alpha: 0.14 },
          { y: 18, blur: 42, spread: -12, color: { role: 'shadow', tier: 8 }, alpha: 0.28 },
        ],
        backdrop: { blur: 20, saturate: 1.8, brightness: 1.02, refraction: 0.55 },
        texture: { kind: 'grain', opacity: 0.05, scale: 1, blend: 'overlay' },
        overlay: { kind: 'sheen', angle: 145, strength: 0.14 },
      },
      popover: {
        backdrop: { blur: 30, saturate: 2, refraction: 0.7 },
        shadows: [
          { inset: true, y: 1, blur: 1, color: { role: 'light', tier: 12 }, alpha: 0.5 },
          { y: 24, blur: 60, spread: -16, color: { role: 'shadow', tier: 9 }, alpha: 0.36 },
        ],
      },
      input: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'shadow', tier: 1, alpha: 0.22 } }] }],
        shadows: [{ inset: true, y: 1, blur: 2, color: { role: 'shadow', tier: 6 }, alpha: 0.25 }],
        overlay: { kind: 'none' },
      },
      scrim: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'shadow', tier: 10, alpha: 0.45 } }] }],
        border: { style: 'none' },
        corner: { radius: 0, shape: 'square' },
        backdrop: { blur: 6, saturate: 1.1 },
        shadows: [],
        overlay: { kind: 'none' },
        texture: { kind: 'none' },
      },
    },
  },

  brutalist: {
    specVersion: 2,
    name: 'Brutalist',
    summary: 'Thick black rules, hard offset shadows and no rounding anywhere.',
    mode: 'adaptive',
    palette: {
      surfaceHue: 50, surfaceChroma: 'neutral',
      accentHue: 20, accentChroma: 'electric',
      scheme: 'triad', statusHueShift: 0,
    },
    // AA rather than AAA even though the anchors are the two poles: the accent
    // fill on the button is a bright orange, and no text colour exists that
    // reads at 7:1 on it. Asking for a target a surface cannot meet does not
    // make the surface better, it just makes the solver report a failure.
    surface: { lightAnchor: 'true-white', darkAnchor: 'true-black', step: 8, contrastTarget: 'aa' },
    type: {
      sansFamily: 'grotesk', displayFamily: 'slab', monoFamily: 'mono',
      scale: 'default', displayWeight: 'black', letterSpacing: 'tight',
      lineHeight: 'tight', measure: 'wide',
    },
    density: 'tight',
    motion: 'instant',
    surfaces: {
      default: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'surface', tier: 0 } }] }],
        border: { width: 3, style: 'solid', color: { role: 'ink' } },
        corner: { radius: 0, shape: 'square' },
        // Zero blur, zero spread, large offset: the shadow is a second copy of
        // the shape, which is the entire brutalist device.
        shadows: [{ x: 6, y: 6, blur: 0, color: { role: 'ink' }, alpha: 1 }],
        texture: { kind: 'none' },
        overlay: { kind: 'none' },
      },
      button: {
        shadows: [{ x: 4, y: 4, blur: 0, color: { role: 'ink' }, alpha: 1 }],
        fill: [{ kind: 'solid', stops: [{ color: { role: 'accent' } }] }],
      },
      input: {
        shadows: [{ inset: true, x: 3, y: 3, blur: 0, color: { role: 'ink' }, alpha: 0.9 }],
      },
      code: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'surface', tier: 1 } }] }],
        shadows: [],
        border: { width: 3, color: { role: 'ink' } },
      },
      sidebar: {
        border: { width: 3, sides: ['right'], color: { role: 'ink' } },
        shadows: [],
      },
      scrim: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'ink', alpha: 0.7 } }] }],
        border: { style: 'none' },
        shadows: [],
      },
    },
  },

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
    summary: 'Phosphor green on true black, with scanlines and a CRT bloom on every glyph.',
    mode: 'dark',
    palette: {
      surfaceHue: 140, surfaceChroma: 'tinted',
      accentHue: 128, accentChroma: 'electric',
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

  editorial: {
    specVersion: 2,
    name: 'Editorial',
    summary: 'A serif measure on mid-grey stock, separated by hairline rules and nothing else.',
    mode: 'light',
    palette: {
      surfaceHue: 36, surfaceChroma: 'tinted',
      accentHue: 8, accentChroma: 'muted',
      scheme: 'complement', statusHueShift: 0,
    },
    // The look the old fixed table could not express: a light ramp that is not
    // white.
    surface: { lightAnchor: 'mid', darkAnchor: 'deep', step: 4, contrastTarget: 'aa' },
    type: {
      sansFamily: 'humanist', displayFamily: 'serif', monoFamily: 'mono',
      scale: 'spacious', displayWeight: 'regular', letterSpacing: 'normal',
      lineHeight: 'loose', measure: 'narrow',
    },
    density: 'airy',
    motion: 'calm',
    surfaces: {
      default: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'surface', tier: 0 } }] }],
        // Separation by rule, never by shadow: the page is flat stock.
        border: { width: 1, style: 'solid', sides: ['bottom'], color: { role: 'ink', alpha: 0.22 } },
        corner: { radius: 0, shape: 'square' },
        shadows: [],
        texture: { kind: 'none' },
        overlay: { kind: 'none' },
      },
      sidebar: {
        border: { width: 1, sides: ['right'], color: { role: 'ink', alpha: 0.18 } },
      },
      code: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'shadow', tier: 1, alpha: 0.5 } }] }],
        border: { width: 1, sides: ['left'], color: { role: 'accent', alpha: 0.7 } },
      },
      input: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'light', tier: 2, alpha: 0.5 } }] }],
        border: { width: 1, sides: ['bottom'], color: { role: 'ink', alpha: 0.35 } },
      },
      popover: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'light', tier: 3 } }] }],
        border: { width: 1, sides: ['top', 'right', 'bottom', 'left'], color: { role: 'ink', alpha: 0.25 } },
      },
      bubbleUser: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'light', tier: 3 } }] }],
        border: { width: 1, sides: ['left'], color: { role: 'accent' } },
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

  neon: {
    specVersion: 2,
    name: 'Neon',
    summary: 'OLED black with one electric cyan edge, glowing outward instead of casting shadow.',
    mode: 'dark',
    palette: {
      surfaceHue: 230, surfaceChroma: 'neutral',
      accentHue: 175, accentChroma: 'electric',
      scheme: 'complement', statusHueShift: 0,
    },
    surface: { lightAnchor: 'paper', darkAnchor: 'true-black', step: 7, contrastTarget: 'aa' },
    type: {
      sansFamily: 'geometric', displayFamily: 'display', monoFamily: 'mono',
      scale: 'compact', displayWeight: 'black', letterSpacing: 'wide',
      lineHeight: 'tight', measure: 'wide',
    },
    density: 'tight',
    motion: 'instant',
    surfaces: {
      default: {
        fill: [
          { kind: 'linear', angle: 180, stops: [
            { color: { role: 'accent', alpha: 0.07 }, position: 0 },
            { color: { role: 'surface', tier: 0, alpha: 0 }, position: 70 },
          ] },
          { kind: 'solid', stops: [{ color: { role: 'surface', tier: 1 } }] },
        ],
        border: { width: 1, color: { role: 'accent', alpha: 0.35 } },
        corner: { radius: 2, shape: 'bevel' },
        // Glow rather than shadow: zero offset, wide blur, accent-coloured.
        shadows: [
          { x: 0, y: 0, blur: 0, spread: 1, color: { role: 'accent' }, alpha: 0.18 },
          { x: 0, y: 0, blur: 22, color: { role: 'accent' }, alpha: 0.22 },
        ],
        texture: { kind: 'grid', opacity: 0.045, scale: 1, blend: 'screen' },
        overlay: { kind: 'none' },
      },
      button: {
        fill: [{ kind: 'linear', angle: 180, stops: [
          { color: { role: 'accent', alpha: 0.3 } },
          { color: { role: 'accent', alpha: 0.12 } },
        ] }],
        shadows: [{ x: 0, y: 0, blur: 18, color: { role: 'accent' }, alpha: 0.4 }],
      },
      sidebar: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'surface', tier: 0 } }] }],
        border: { width: 1, sides: ['right'], color: { role: 'accent', alpha: 0.3 } },
        shadows: [],
        texture: { kind: 'grid', opacity: 0.06, scale: 1.5, blend: 'screen' },
      },
      code: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'support', tier: 1, alpha: 0.12 } }] }],
        border: { width: 1, color: { role: 'support', alpha: 0.35 } },
        shadows: [],
      },
      scrim: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'shadow', tier: 12, alpha: 0.7 } }] }],
        border: { style: 'none' },
        shadows: [],
        texture: { kind: 'none' },
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
