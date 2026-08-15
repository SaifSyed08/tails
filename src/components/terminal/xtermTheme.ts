import type { ITheme } from '@xterm/xterm';

/**
 * Bridges the app's design tokens into an xterm theme.
 *
 * xterm paints into a canvas/WebGL surface, so it cannot consume
 * `hsl(var(--token))` the way the rest of the UI does — it needs literal
 * colours. Every value here is therefore *derived* from the same custom
 * properties Tailwind reads, never written down. A generated theme that moves
 * `--primary` moves the cursor and the ANSI blue with it; hardcoding even one
 * hex here would leave a permanent off-theme artefact on screen.
 */

type Hsl = { h: number; s: number; l: number };

/** Tokens read from `:root`. Values use the bare `H S% L%` grammar. */
const TOKENS = [
  '--background',
  '--foreground',
  '--primary',
  '--muted-foreground',
  '--border',
  '--destructive',
  '--positive',
  '--warning',
] as const;

type TokenName = (typeof TOKENS)[number];

function parseHsl(raw: string): Hsl | null {
  // Accepts `221 83% 45%` and the comma-separated spelling, so a theme written
  // either way still resolves.
  const parts = raw.trim().replace(/,/g, ' ').split(/\s+/).filter(Boolean);
  if (parts.length < 3) return null;

  const h = Number.parseFloat(parts[0]);
  const s = Number.parseFloat(parts[1]);
  const l = Number.parseFloat(parts[2]);
  if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(l)) return null;

  return { h: ((h % 360) + 360) % 360, s: clamp(s, 0, 100), l: clamp(l, 0, 100) };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hslToRgb({ h, s, l }: Hsl): [number, number, number] {
  const saturation = s / 100;
  const lightness = l / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const secondary = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const match = lightness - chroma / 2;

  const [r, g, b] = h < 60 ? [chroma, secondary, 0]
    : h < 120 ? [secondary, chroma, 0]
      : h < 180 ? [0, chroma, secondary]
        : h < 240 ? [0, secondary, chroma]
          : h < 300 ? [secondary, 0, chroma]
            : [chroma, 0, secondary];

  return [
    Math.round((r + match) * 255),
    Math.round((g + match) * 255),
    Math.round((b + match) * 255),
  ];
}

function toHex(color: Hsl): string {
  const channels = hslToRgb(color);
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function toRgba(color: Hsl, alpha: number): string {
  const [r, g, b] = hslToRgb(color);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Shifts lightness while keeping the hue and saturation of the token. */
function shiftL(color: Hsl, delta: number): Hsl {
  return { ...color, l: clamp(color.l + delta, 0, 100) };
}

/**
 * Moves a colour away from the background's lightness.
 *
 * This is how the `bright*` ramp is produced. Always lightening (the literal
 * ANSI convention) washes bright colours out on a light theme; moving away from
 * whatever the surface is keeps the contrast in both modes.
 */
function contrastShift(color: Hsl, background: Hsl, amount: number): Hsl {
  return shiftL(color, background.l > 50 ? -amount : amount);
}

export type TerminalThemeSnapshot = {
  theme: ITheme;
  /** Resolved from `--font-mono`; xterm measures glyphs, so `var()` is no use. */
  fontFamily: string;
};

/** Fallbacks only for the impossible case of a token being absent entirely. */
const NEUTRAL: Hsl = { h: 0, s: 0, l: 50 };

/**
 * Reads the live token values and builds an xterm theme.
 *
 * Called at mount and again on every `tails:appearance-changed`, so a restyle
 * repaints the terminal along with everything else.
 */
export function readTerminalTheme(): TerminalThemeSnapshot {
  const styles = getComputedStyle(document.documentElement);

  const read = (token: TokenName): Hsl =>
    parseHsl(styles.getPropertyValue(token)) ?? NEUTRAL;

  const values = {} as Record<TokenName, Hsl>;
  for (const token of TOKENS) values[token] = read(token);

  const background = values['--background'];
  const foreground = values['--foreground'];
  const primary = values['--primary'];
  const muted = values['--muted-foreground'];
  const border = values['--border'];

  // ANSI black/white must stay dark/light regardless of which end of the ramp
  // the surface sits on, so they are picked by lightness rather than by role.
  const darkTone = background.l <= foreground.l ? background : foreground;
  const lightTone = background.l <= foreground.l ? foreground : background;

  const base = {
    black: shiftL(darkTone, 8),
    red: values['--destructive'],
    green: values['--positive'],
    yellow: values['--warning'],
    blue: primary,
    // No magenta/cyan token exists, so they borrow the accent's saturation and
    // lightness at the canonical hues — in the theme's voice, not invented.
    magenta: { ...primary, h: 300 },
    cyan: { ...primary, h: 190 },
    white: shiftL(lightTone, -6),
  };

  const bright = (color: Hsl) => toHex(contrastShift(color, background, 12));

  const theme: ITheme = {
    background: toHex(background),
    foreground: toHex(foreground),
    cursor: toHex(primary),
    cursorAccent: toHex(background),
    selectionBackground: toRgba(primary, 0.32),
    selectionForeground: toHex(foreground),
    selectionInactiveBackground: toRgba(border, 0.45),

    black: toHex(base.black),
    red: toHex(base.red),
    green: toHex(base.green),
    yellow: toHex(base.yellow),
    blue: toHex(base.blue),
    magenta: toHex(base.magenta),
    cyan: toHex(base.cyan),
    white: toHex(base.white),

    brightBlack: toHex(muted),
    brightRed: bright(base.red),
    brightGreen: bright(base.green),
    brightYellow: bright(base.yellow),
    brightBlue: bright(base.blue),
    brightMagenta: bright(base.magenta),
    brightCyan: bright(base.cyan),
    brightWhite: toHex(lightTone),
  };

  const fontFamily = styles.getPropertyValue('--font-mono').trim()
    || 'ui-monospace, monospace';

  return { theme, fontFamily };
}
