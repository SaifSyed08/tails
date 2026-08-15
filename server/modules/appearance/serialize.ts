import type { DerivedTheme, Hsl, ThemeTokens } from '@/modules/appearance/derive.js';

/** Rounds to one decimal so generated CSS stays readable and diffable. */
const round = (value: number): number => Math.round(value * 10) / 10;

/** The bare `H S% L%` grammar, so Tailwind can compose `hsl(var(--x) / alpha)`. */
const formatHsl = ({ h, s, l }: Hsl): string =>
  `${round(h)} ${round(Math.min(100, Math.max(0, s)))}% ${round(Math.min(100, Math.max(0, l)))}%`;

function formatDeclarations(tokens: ThemeTokens): string {
  const lines: string[] = [];

  for (const [name, value] of Object.entries(tokens.colors)) {
    lines.push(`  --${name}: ${formatHsl(value)};`);
  }
  for (const group of [tokens.lengths, tokens.fonts, tokens.durations, tokens.easings]) {
    for (const [name, value] of Object.entries(group)) {
      lines.push(`  --${name}: ${value};`);
    }
  }

  return lines.join('\n');
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
  const light = `:root {\n${formatDeclarations(theme.light)}\n}`;

  // A dark ramp identical to the light one means the theme pinned dark mode;
  // it is emitted under both selectors by the caller rather than here.
  const dark = theme.dark ? `.dark {\n${formatDeclarations(theme.dark)}\n}` : null;

  return { light, dark };
}

/** The single stylesheet text the renderer adopts. */
export function serializeStylesheet(theme: DerivedTheme): string {
  const { light, dark } = serializeToCss(theme);
  return dark ? `${light}\n\n${dark}` : light;
}
