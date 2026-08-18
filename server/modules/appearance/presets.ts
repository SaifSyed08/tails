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
      // 42 rather than 38: the built-in accent is now an orange at hue 26, and
      // a preset whose whole identity is "amber" should not be twelve degrees
      // from the default it is replacing. 42 is also closer to real P3 amber,
      // so the preset gets more distinctive and more accurate at once.
      accentHue: 42, accentChroma: 'electric',
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
    summary: 'White paper and black ink, with colour only where you are — a caret that cycles and a pointer that leaves pixels behind.',
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
        // No glow. A halo under the cursor was softening a look whose whole
        // idea is flat white, black ink and hard-edged colour — the trail and
        // the click carry the character here, and a diffuse blob under the
        // pointer was working against both.
        kind: 'system',
        size: 64,
        opacity: 0.3,
        blend: 'multiply',
        replace: false,
        color: { role: 'accent' },
        // Hard squares on a grid rather than shrinking circles. `pixel` keeps
        // each segment the same size and lets opacity do the falling off, which
        // is what makes it read as a cursor leaving pixels behind instead of a
        // comet — and it squares off against the block caret rather than
        // rounding away from it.
        trail: { kind: 'pixel', length: 16, size: 5, opacity: 0.6 },
        // The bevel grid. Flat faces, mitred light and dark edges, gone in half
        // a second — the one moment this theme is allowed to look like a
        // dialog box from 1995, which is exactly the register its squared-off
        // corners and block caret are already in.
        // Pressed in along a fracture rather than a decal fading out. The
        // inverted bevel is what separates the two: shadow on the top-left of
        // each pixel reads as a dent, the other way round reads as a button.
        click: { kind: 'crack', size: 120, seconds: 0.52, color: { role: 'surface', tier: 3 } },
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

  creative: {
    specVersion: 2,
    name: 'Creative',
    summary: 'Black on white with a grey rail — a sober page whose only colour is the one following your cursor.',
    mode: 'light',
    palette: {
      surfaceHue: 220, surfaceChroma: 'neutral',
      accentHue: 214, accentChroma: 'vivid',
      scheme: 'triad', statusHueShift: 0,
    },
    surface: { lightAnchor: 'true-white', darkAnchor: 'near-black', step: 6, contrastTarget: 'aaa' },
    type: {
      // `grotesk` leads with Space Grotesk. It is not bundled and not installed
      // on a stock machine, so in practice this resolves to Inter or Arial —
      // the name is honoured where it exists rather than promised where it
      // does not.
      sansFamily: 'grotesk', displayFamily: 'grotesk', monoFamily: 'mono',
      scale: 'default', displayWeight: 'medium', letterSpacing: 'normal',
      lineHeight: 'default', measure: 'default',
    },
    density: 'default',
    motion: 'standard',
    interaction: {
      caretCycle: [
        { role: 'accent' },
        { role: 'destructive' },
        { role: 'warning' },
        { role: 'positive' },
      ],
      // About one change per blink. The blink itself belongs to the operating
      // system and no CSS property reaches it, so this is the closest honest
      // approximation: the standard caret period is roughly 1.06 seconds, and
      // stepping the colour on that interval lands a new colour on most blinks
      // without ever being locked to one.
      caretCycleSeconds: 1.06,
      caretShape: 'auto',
      selectionFill: { role: 'accent', alpha: 0.2 },
      pointer: {
        kind: 'system',
        size: 40, opacity: 0.3, blend: 'normal', replace: false,
        // The cursify rainbow ribbon, reimplemented app-side. See
        // docs/reference/cursify-rainbow-cursor.md.
        trail: {
          kind: 'rainbow', length: 14, size: 3, opacity: 0.85,
          palette: [
            { role: 'accent' },
            { role: 'destructive' },
            { role: 'warning' },
            { role: 'positive' },
            { role: 'support' },
          ],
        },
        click: { kind: 'none', size: 72, seconds: 0.45 },
      },
    },
    surfaces: {
      default: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'surface', tier: 0 } }] }],
        border: { width: 1, color: { role: 'ink', alpha: 0.14 } },
        corner: { radius: 4, shape: 'round' },
        // No shadow anywhere. The page is flat stock and the rail does the
        // separating, which is what leaves the trail as the only thing moving.
        shadows: [],
        texture: { kind: 'none' },
        overlay: { kind: 'none' },
      },
      sidebar: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'surface', tier: 2 } }] }],
        border: { width: 1, sides: ['right'], color: { role: 'ink', alpha: 0.12 } },
        shadows: [],
        corner: { radius: 0, shape: 'square' },
      },
      input: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'surface', tier: 1 } }] }],
        border: { width: 1, color: { role: 'ink', alpha: 0.18 } },
      },
      code: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'surface', tier: 1 } }] }],
        border: { width: 1, sides: ['left'], color: { role: 'accent' } },
      },
      bubbleUser: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'surface', tier: 2 } }] }],
        border: { width: 1, color: { role: 'ink', alpha: 0.14 } },
      },
      scrim: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'ink', alpha: 0.34 } }] }],
        border: { style: 'none' },
        corner: { radius: 0, shape: 'square' },
        shadows: [],
      },
    },
  },

  aurora: {
    specVersion: 2,
    name: 'Aurora',
    summary: 'Black glass — the window itself is see-through, blurred and tinted near-black, with panels floating on it as lit panes.',
    mode: 'dark',
    palette: {
      surfaceHue: 260, surfaceChroma: 'tinted',
      accentHue: 172, accentChroma: 'vivid',
      scheme: 'triad', statusHueShift: 0,
    },
    surface: { lightAnchor: 'paper', darkAnchor: 'true-black', step: 6, contrastTarget: 'aa' },
    type: {
      sansFamily: 'grotesk', displayFamily: 'grotesk', monoFamily: 'mono',
      scale: 'default', displayWeight: 'medium', letterSpacing: 'normal',
      lineHeight: 'default', measure: 'default',
    },
    density: 'airy',
    motion: 'calm',
    interaction: {
      caretShape: 'auto',
      caretCycleSeconds: 4,
      selectionFill: { role: 'accent', alpha: 0.24 },
      /*
        No trail.

        It was a canvas approximation of a WebGL fluid solver, and against a
        window you can see the desktop through it read as smearing rather than
        as depth — the glass is the effect now, and a wake dragged across it
        competes with the thing it is drawn on. Removed rather than tuned
        down: the two ideas do not sit together at any strength.
      */
      pointer: {
        kind: 'system',
        size: 40, opacity: 0.25, blend: 'screen', replace: false,
        click: { kind: 'none', size: 72, seconds: 0.45 },
      },
    },
    /*
      The window itself is the effect.

      Everything above draws glass; this is what puts something behind it worth
      looking through. Windows 11 blurs the desktop, and the tint keeps the
      result readable — without one, text contrast would depend on the user's
      wallpaper rather than on the theme.
    */
    window: { backdrop: 'acrylic', tint: { role: 'shadow', tier: 12, alpha: 0.74 } },
    surfaces: {
      /*
        A pane, not a tinted box.

        Three things separate real glass from a translucent rectangle, and the
        reference in docs/reference/liquid-glass-preview.html has all three:
        a fill light enough that what is behind genuinely shows through, a
        *bright* hairline along the lit edge that fades as the ring turns away,
        and a specular lip just inside the top edge. The lip is the one people
        do not think to add and the one that does most of the work — it is the
        highlight where a real edge catches the light, and without it the panel
        reads as paper with a hole punched in it.

        The fill runs a touch lighter than before and the blur harder, because
        these panels now float over the desktop rather than over an opaque app
        background. Anything more transparent and the wallpaper starts
        competing with the text.
      */
      default: {
        fill: [{ kind: 'linear', angle: 150, stops: [
          { color: { role: 'light', tier: 4, alpha: 0.14 }, position: 0 },
          { color: { role: 'light', tier: 1, alpha: 0.06 }, position: 55 },
          { color: { role: 'shadow', tier: 2, alpha: 0.10 }, position: 100 },
        ] }],
        border: {
          width: 1,
          variant: 'gradient-ring',
          ring: { angle: 145, stops: [
            { color: { role: 'light', tier: 12, alpha: 0.55 }, position: 0 },
            { color: { role: 'light', tier: 8, alpha: 0.14 }, position: 30 },
            { color: { role: 'light', tier: 4, alpha: 0.04 }, position: 62 },
            { color: { role: 'shadow', tier: 4, alpha: 0.34 }, position: 100 },
          ] },
        },
        corner: { radius: 22, shape: 'squircle' },
        shadows: [
          // The specular lip. Hairline, bright, top edge only.
          { inset: true, y: 1, blur: 0, color: { role: 'light', tier: 12 }, alpha: 0.34 },
          // And the thickness of the pane, read as a soft inner shade below it.
          { inset: true, y: -1, blur: 2, color: { role: 'shadow', tier: 8 }, alpha: 0.30 },
          { y: 22, blur: 56, spread: -16, color: { role: 'shadow', tier: 10 }, alpha: 0.55 },
        ],
        backdrop: { blur: 40, saturate: 1.8, brightness: 1.06, refraction: 0.5 },
        texture: { kind: 'none' },
        overlay: { kind: 'none' },
      },
      /*
        Translucent too, now that there is something behind it worth seeing —
        but *lighter* than the page, which on this preset is not a style choice.

        The ground is `true-black`, so the page composites to lightness zero and
        there is nothing darker to be. A shadow-role rail flattened to black on
        black and the region-separation guard caught it at exactly 1.000:1,
        which is the number you get when two colours are the same colour. The
        rail has to lift off the ground rather than sink into it.
      */
      sidebar: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'light', tier: 6, alpha: 0.30 } }] }],
        border: { width: 1, sides: ['right'], color: { role: 'light', tier: 8, alpha: 0.14 } },
        shadows: [],
        corner: { radius: 0, shape: 'square' },
        backdrop: { blur: 44, saturate: 1.5 },
      },
      code: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'shadow', tier: 2, alpha: 0.5 } }] }],
        border: { width: 1, color: { role: 'accent', alpha: 0.22 } },
        shadows: [],
      },
      scrim: {
        fill: [{ kind: 'solid', stops: [{ color: { role: 'shadow', tier: 12, alpha: 0.6 } }] }],
        border: { style: 'none' },
        corner: { radius: 0, shape: 'square' },
        shadows: [],
        backdrop: { blur: 10, saturate: 1.1 },
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
