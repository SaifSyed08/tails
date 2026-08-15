import type { DerivedTheme, Hsl, ThemeTokens } from '@/modules/appearance/derive.js';
import { SURFACE_PARTS } from '@/modules/appearance/surface-recipe.js';

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
  for (const group of [tokens.lengths, tokens.fonts, tokens.durations, tokens.easings]) {
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

/** The single stylesheet text the renderer adopts. */
export function serializeStylesheet(theme: DerivedTheme): string {
  const { light, dark } = serializeToCss(theme);
  return dark ? `${light}\n\n${dark}` : light;
}
