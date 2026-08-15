import type { DerivedTheme, Hsl, ThemeTokens } from '@/modules/appearance/derive.js';
import { SURFACE_PARTS } from '@/modules/appearance/surface-recipe.js';
import { AMBIENT_KEYFRAMES } from '@/modules/appearance/textures.js';

/**
 * Renders derived tokens as a stylesheet.
 *
 * Two grammars live here on purpose. The role colours keep the bare
 * `H S% L%` form because Tailwind composes them as `hsl(var(--token) / alpha)`
 * and a wrapped `hsl()` breaks every opacity utility in the app. The surface
 * tokens are complete CSS values, because they are consumed directly and
 * splitting a `box-shadow` list into components would be absurd.
 */

/** Rounds to one decimal so generated CSS stays readable and diffable. */
const round = (value: number): number => Math.round(value * 10) / 10;

/** The bare `H S% L%` grammar, so Tailwind can compose `hsl(var(--x) / alpha)`. */
const formatHsl = ({ h, s, l }: Hsl): string =>
  `${round(h)} ${round(Math.min(100, Math.max(0, s)))}% ${round(Math.min(100, Math.max(0, l)))}%`;

const declarations = (entries: [string, string][]): string =>
  entries.map(([name, value]) => `  --${name}: ${value};`).join('\n');

const block = (selector: string, body: string): string =>
  (body ? `${selector} {\n${body}\n}` : '');

/**
 * The `:root` / `.dark` declarations: role colours plus everything global.
 *
 * Tolerant of tokens missing the v2 groups, because a theme saved under v1 is
 * replayed from its cached token blob and must keep rendering exactly as it did
 * the day it was saved.
 */
function formatGlobalDeclarations(tokens: ThemeTokens): string {
  const entries: [string, string][] = [];

  for (const [name, value] of Object.entries(tokens.colors)) {
    entries.push([name, formatHsl(value)]);
  }
  for (const group of [
    tokens.lengths, tokens.fonts, tokens.durations, tokens.easings, tokens.interaction,
  ]) {
    for (const [name, value] of Object.entries(group ?? {})) entries.push([name, value]);
  }
  for (const [name, value] of Object.entries(tokens.surfaces?.default ?? {})) {
    entries.push([name, value]);
  }

  return declarations(entries);
}

/**
 * The scoped rules: one per named part, one per tone.
 *
 * Scoped by attribute rather than by class so the renderer marks *what a thing
 * is* (`data-tails-part="sidebar"`) and the theme decides what that looks like.
 * A class-based contract would need the theme to know the app's class names,
 * which is how theming systems end up coupled to markup they cannot see.
 */
function formatScopedRules(tokens: ThemeTokens, prefix: string): string[] {
  const rules: string[] = [];

  for (const part of SURFACE_PARTS) {
    if (part === 'default') continue;
    const surface = tokens.surfaces?.[part];
    if (!surface) continue;
    rules.push(block(
      `${prefix}[data-tails-part="${part}"]`,
      declarations(Object.entries(surface)),
    ));
  }

  for (const [tone, values] of Object.entries(tokens.tones ?? {})) {
    rules.push(block(
      `${prefix}[data-tails-surface="${tone}"]`,
      declarations(Object.entries(values)),
    ));
  }

  return rules.filter(Boolean);
}

/**
 * Renders a derived theme as a stylesheet.
 *
 * Real `:root` and `.dark` selectors, never inline styles on the root element.
 * Inline styles outrank every selector, so a theme applied that way silently
 * defeats the `.dark` overrides and breaks dark mode — a bug worth naming
 * because it is the natural first implementation.
 */
export function serializeToCss(theme: DerivedTheme): { light: string; dark: string | null } {
  const light = [
    block(':root', formatGlobalDeclarations(theme.light)),
    ...formatScopedRules(theme.light, ''),
  ].join('\n\n');

  // A dark ramp identical to the light one means the theme pinned dark mode;
  // it is emitted under both selectors by the caller rather than here.
  const dark = theme.dark
    ? [
      block('.dark', formatGlobalDeclarations(theme.dark)),
      ...formatScopedRules(theme.dark, '.dark '),
    ].join('\n\n')
    : null;

  return { light, dark };
}

/**
 * Renders a theme scoped to one container, for the live miniature.
 *
 * The user asked to see a proposed look before the app commits to it, framed by
 * the real layout — sidebar left, chat right. The obvious reading of that is
 * "generate an image", and an image is the wrong mechanism: it cannot be
 * fetched (the `url()` ban), generating one locally is a large detour, and
 * decisively it would be an *approximation* of a look this module can already
 * render exactly. What it produces instead is the real stylesheet with `:root`
 * swapped for a class, so a scaled-down mock of the app chrome renders in the
 * candidate theme without a single token escaping into the running app.
 *
 * The `.dark` rules are emitted as `.dark .scope` rather than `.scope.dark`,
 * because the miniature follows the window it is shown in: the user is choosing
 * between two looks, not between two colour modes, and flipping one of them to
 * the other mode would make the comparison about the wrong thing.
 */
export function serializeScoped(theme: DerivedTheme, className: string): string {
  const scope = `.${className}`;

  const blocks = [
    block(scope, formatGlobalDeclarations(theme.light)),
    ...formatScopedRules(theme.light, `${scope} `),
  ];

  if (theme.dark) {
    blocks.push(
      block(`.dark ${scope}`, formatGlobalDeclarations(theme.dark)),
      ...formatScopedRules(theme.dark, `.dark ${scope} `),
    );
  }

  const body = blocks.filter(Boolean).join('\n\n');
  return usesAmbient(theme) ? `${AMBIENT_KEYFRAMES}\n\n${body}` : body;
}

/**
 * True when any surface in either ramp actually animates its ambient layer.
 *
 * Checked rather than assumed so a theme with no ambience carries no keyframes:
 * they are app-owned constants, and shipping four unused `@keyframes` blocks in
 * every stylesheet would be several hundred bytes of noise in the one artefact
 * a human reads when a theme looks wrong.
 */
const usesAmbient = (theme: DerivedTheme): boolean =>
  [theme.light, theme.dark].some((ramp) =>
    Object.values(ramp?.surfaces ?? {}).some((tokens) =>
      tokens['t-ambient-animation'] && tokens['t-ambient-animation'] !== 'none'));

/**
 * The single stylesheet text the renderer adopts.
 *
 * The ambient keyframes go at the top rather than the bottom because
 * `animation-name` resolves by name at used-value time and does not care about
 * order — putting them first simply means the reader meets the definition
 * before the reference.
 */
export function serializeStylesheet(theme: DerivedTheme): string {
  const { light, dark } = serializeToCss(theme);
  const body = dark ? `${light}\n\n${dark}` : light;
  return usesAmbient(theme) ? `${AMBIENT_KEYFRAMES}\n\n${body}` : body;
}
