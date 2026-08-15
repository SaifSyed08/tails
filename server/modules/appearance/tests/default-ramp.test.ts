import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CONTRAST_PAIRS, pairMinimum } from '@/modules/appearance/derive.js';
import { compositeOver, contrastRatio, type Hsl } from '@/modules/appearance/palette.js';
import { SURFACE_PARTS } from '@/modules/appearance/surface-recipe.js';

/**
 * The built-in ramp, held to the bar the engine enforces on the model.
 *
 * `derive.ts` has said "the contrast pairs, exported so tests can assert the
 * shipped default ramp too" since v2 landed, and nothing ever did. So the one
 * theme every user sees before they ask for anything — the floor, the thing
 * that has to be correct when every layer above it fails to resolve — was the
 * only theme in the system with no contrast gate at all. A generated theme
 * could not ship `primary-foreground` at 3:1 on `primary`; the default could,
 * and nobody would have found out until someone squinted at a button.
 *
 * That mattered immediately: moving the accent from blue to amber is exactly
 * the change this catches. Amber is a light hue, and the white text that sat
 * happily on a mid-blue reads at 3.6:1 on any amber bright enough to look like
 * amber. Without this the obvious edit — swap the hue, keep everything else —
 * ships a primary button nobody with low vision can read.
 *
 * Parsed out of the stylesheet rather than duplicated here, because a copy of
 * the ramp in a test is a copy that drifts, and a drifted copy asserts that the
 * *old* colours are fine.
 */

const here = dirname(fileURLToPath(import.meta.url));
const indexCss = readFileSync(join(here, '..', '..', '..', '..', 'src', 'index.css'), 'utf8');

/** Bare `H S% L%`, the grammar the whole system uses so Tailwind can add alpha. */
const COLOR = /--([a-z-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*;/g;

/**
 * The colour tokens declared in one selector's block.
 *
 * Brace-counted rather than regex-delimited: `:root` appears more than once in
 * the floor — once for the role colours and again for the `--t-*` surface
 * defaults — and a lazy match to the first `}` would silently read the wrong
 * one the moment those two blocks swap order.
 */
function rampFor(selector: string): Record<string, Hsl> {
  const start = indexCss.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `src/index.css has no "${selector}" block`);

  let depth = 0;
  let end = start;
  for (let index = indexCss.indexOf('{', start); index < indexCss.length; index += 1) {
    if (indexCss[index] === '{') depth += 1;
    if (indexCss[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }

  const block = indexCss.slice(start, end);
  const colors: Record<string, Hsl> = {};
  for (const match of block.matchAll(COLOR)) {
    colors[match[1]] = { h: Number(match[2]), s: Number(match[3]), l: Number(match[4]) };
  }
  return colors;
}

const light = rampFor(':root');
// The dark ramp overrides only some tokens, so it inherits the rest.
const dark = { ...light, ...rampFor('.dark') };

test('the built-in ramp defines the tokens the contrast manifest checks', () => {
  // A pair whose tokens are missing is a pair silently not being checked, which
  // would make every assertion below vacuously true.
  const needed = new Set(CONTRAST_PAIRS.flatMap((pair) => [pair.foreground, pair.background]));
  const missing = [...needed].filter((token) => !light[token]);

  assert.deepEqual(missing, [], 'the light ramp in src/index.css is missing colour tokens the manifest names');
  assert.ok(Object.keys(light).length >= 20, 'suspiciously few colours parsed out of :root — the parser is probably wrong');
});

/**
 * Pairs the built-in ramp knowingly does not clear, each with its reason.
 *
 * An allowlist rather than a lowered bar, for the same reason
 * `renderer-contract.test.ts` keeps one: "this one is fine" is a claim that
 * should have to be written down and reviewed. A shortfall nobody recorded
 * looks exactly like a shortfall nobody noticed.
 *
 * There is one entry, and it predates the amber accent — this gate found it on
 * its first run against the *blue* ramp, which is the clearest possible
 * argument that the default should have had a gate from the start.
 */
const KNOWN_SHORTFALLS: Record<string, string> = {
  'border on background':
    'The hairline separating a card from the page sits at about 1.3:1, and the manifest asks 3:1 of it because the derivation solves generated themes to that bar. Closing it honestly needs a border near 58% lightness — a mid-grey rule around every card, input and code block. That is a deliberate decision about how heavy the default looks rather than a colour correction, and nobody has asked for it; quietly lowering the bar for the default while enforcing it on the model would be worse. Recorded so the next person to weigh it finds the number already measured. The visible consequence meanwhile: a generated theme has firmer borders than the built-in look, and that is not a bug in the generator.',
};

for (const [label, ramp] of [['light', light], ['dark', dark]] as const) {
  test(`the built-in ${label} ramp clears every pair in the contrast manifest`, () => {
    const failures: string[] = [];
    const unexpectedlyPassing: string[] = [];

    for (const pair of CONTRAST_PAIRS) {
      const foreground = ramp[pair.foreground];
      const background = ramp[pair.background];
      if (!foreground || !background) continue;

      // AA, the same floor the engine promises for anything the model makes.
      // The default does not get to be the exception.
      const minimum = pairMinimum(pair, 'aa');
      const ratio = contrastRatio(foreground, background);
      const name = `${pair.foreground} on ${pair.background}`;
      const excused = name in KNOWN_SHORTFALLS;

      if (ratio < minimum && !excused) {
        failures.push(`${name} is ${ratio.toFixed(2)}:1, needs ${minimum}:1`);
      }
      // An exemption that has quietly started passing has stopped describing
      // the system, and it will hide the next regression of the same pair.
      if (ratio >= minimum && excused) unexpectedlyPassing.push(name);
    }

    assert.deepEqual(failures, [], `src/index.css ${label} ramp:\n  ${failures.join('\n  ')}`);
    assert.deepEqual(
      unexpectedlyPassing,
      [],
      'These pairs now clear the manifest but are still listed in KNOWN_SHORTFALLS. Delete the exemption.',
    );
  });
}

test('the accent is legible as text, not only as a fill', () => {
  // The manifest checks `primary-foreground on primary` — ink on the button —
  // and `ring on background` at the 3:1 non-text bar. Neither covers the accent
  // being used *as text*, which `text-primary` does in a dozen components: link
  // colour, active nav items, the empty-state headline, tool names.
  //
  // With a cool accent that gap never mattered; blue at 45% lightness clears
  // 6.5:1 on the page for free. Amber does not. An accent bright enough to
  // carry dark ink on a button lands near 3.4:1 as text, and the obvious amber
  // choice ships a dozen components at that number with nothing objecting. The
  // light ramp takes a deeper orange specifically to avoid it, and this is what
  // stops someone brightening it back.
  //
  // `muted` and `secondary` matter as much as the page and are easy to forget:
  // both sit *darker* than the page in the light ramp, so a dark accent has
  // less contrast on them, not more. `muted` is the binding surface for the
  // light ramp's accent lightness.
  const surfaces = ['background', 'card', 'popover', 'muted', 'secondary'] as const;
  const failures: string[] = [];

  for (const [label, ramp] of [['light', light], ['dark', dark]] as const) {
    for (const surface of surfaces) {
      const ratio = contrastRatio(ramp.primary, ramp[surface]);
      if (ratio < 4.5) {
        failures.push(`${label}: --primary as text on --${surface} is ${ratio.toFixed(2)}:1, needs 4.5:1`);
      }
    }
  }

  assert.deepEqual(failures, [], failures.join('\n  '));
});

/**
 * A floor token value: a role reference, optionally with alpha.
 *
 * The floor writes everything as `hsl(var(--role))` or `hsl(var(--role) / a)`,
 * so resolving one is a lookup and a multiply rather than a CSS engine.
 */
function resolveToken(value: string, ramp: Record<string, Hsl>): { color: Hsl; alpha: number } | null {
  const match = /^hsl\(\s*var\(\s*--([a-z-]+)\s*\)\s*(?:\/\s*([\d.]+)\s*)?\)$/.exec(value.trim());
  if (!match) return null;

  const color = ramp[match[1]];
  if (!color) return null;
  return { color, alpha: match[2] === undefined ? 1 : Number(match[2]) };
}

/** Every `--t-*` declaration in the floor blocks that name this part. */
function partTokens(part: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  // Only the floor blocks: they quote the attribute value, while the
  // consumption rules in the components layer write `[data-tails-part]` bare.
  const needle = `[data-tails-part='${part}']`;

  for (let at = indexCss.indexOf(needle); at !== -1; at = indexCss.indexOf(needle, at + 1)) {
    const open = indexCss.indexOf('{', at);
    const close = indexCss.indexOf('}', open);
    if (open === -1 || close === -1) continue;
    // A selector list may name several parts; the declarations apply to each.
    const between = indexCss.slice(at, open);
    if (between.includes('}')) continue;

    for (const match of indexCss.slice(open, close).matchAll(/(--t-[a-z-]+):\s*([^;]+);/g)) {
      tokens[match[1]] = match[2].trim();
    }
  }
  return tokens;
}

/**
 * The three tokens that exist only to be *corrected* for their surface.
 *
 * `--t-ink`, `--t-ink-muted` and `--t-accent-on` all mean "…on this surface".
 * Their `:root` values answer for a neutral page, and every part that inherits
 * them unchanged is asserting that its own fill is close enough to the page for
 * that answer to hold.
 *
 * On `bubbleUser` it was not: filled with `--primary`, it inherited
 * `--t-accent-on: hsl(var(--primary))` and `--t-ink-muted:
 * hsl(var(--muted-foreground))`, which measured **1.00:1** and 1.16:1 — a token
 * whose entire purpose is to correct for the surface, silently returning the
 * uncorrected value on the one surface that needed correcting. It is the fifth
 * instance of this project's recurring bug: something that exists, validates,
 * and does nothing.
 *
 * The renderer contract test catches a token that is *emitted and unread*. This
 * catches a token that is read and inert, which looks identical from every
 * angle except a contrast measurement.
 */
/**
 * The `:root` surface floor — the values every part inherits until it says
 * otherwise. Parsed from the second `:root` block, the one that carries `--t-*`.
 */
const rootSurfaceTokens: Record<string, string> = (() => {
  const at = indexCss.indexOf('--t-fill-color:');
  const open = indexCss.lastIndexOf('{', at);
  const close = indexCss.indexOf('}', at);
  const tokens: Record<string, string> = {};
  for (const match of indexCss.slice(open, close).matchAll(/(--t-[a-z-]+):\s*([^;]+);/g)) {
    tokens[match[1]] = match[2].trim();
  }
  return tokens;
})();

test('no floor token is a passthrough of the value it exists to refine', () => {
  const REFINEMENTS = ['--t-ink', '--t-ink-muted', '--t-accent-on'] as const;
  const failures: string[] = [];

  for (const [label, ramp] of [['light', light], ['dark', dark]] as const) {
    for (const part of SURFACE_PARTS) {
      const tokens = { ...rootSurfaceTokens, ...partTokens(part) };


      const fillValue = tokens['--t-fill-color'] ?? '';
      // A transparent part shows the page through it, which is then the surface
      // its text actually sits on.
      const fill = fillValue === 'transparent'
        ? { color: ramp.background, alpha: 1 }
        : resolveToken(fillValue, ramp);
      if (!fill) continue;

      const surface = fill.alpha >= 1
        ? fill.color
        : compositeOver(fill.color, fill.alpha, ramp.background);

      for (const token of REFINEMENTS) {
        const raw = tokens[token];
        // `inherit` hands the question to the parent, which is a real answer.
        if (!raw || raw === 'inherit' || raw === 'currentColor') continue;

        const resolved = resolveToken(raw, ramp);
        if (!resolved) continue;

        const ink = resolved.alpha >= 1
          ? resolved.color
          : compositeOver(resolved.color, resolved.alpha, surface);

        const ratio = contrastRatio(ink, surface);
        if (ratio < 4.5) {
          failures.push(`${label} ${part}: ${token} is ${ratio.toFixed(2)}:1 on this part's own fill, needs 4.5:1`);
        }
      }
    }
  }

  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}`);
});

/**
 * How far apart two role hues have to sit to read as different colours.
 *
 * Not a perceptual constant — it is the smallest gap at which a filled button
 * and a filled banner side by side are obviously not the same thing. The warm
 * half of the wheel is crowded (danger, primary and warning all live there
 * now), so this is the constraint that decides where each one goes.
 */
const HUE_SEPARATION = 15;

test('the semantic roles do not collide with the accent', () => {
  // The specific risk this exists for: with an amber accent, `--warning` at the
  // conventional hue 38 puts "do this" and "careful" within a few degrees of
  // each other, and the interface stops distinguishing them. `--destructive`
  // is the other side of the same squeeze — an orange primary sitting between
  // red danger and amber warning has to be clearly neither.
  const gap = (a: number, b: number): number => {
    const raw = Math.abs(a - b) % 360;
    return Math.min(raw, 360 - raw);
  };

  for (const [label, ramp] of [['light', light], ['dark', dark]] as const) {
    for (const role of ['warning', 'destructive', 'positive'] as const) {
      const separation = gap(ramp.primary.h, ramp[role].h);
      assert.ok(
        separation >= HUE_SEPARATION,
        `${label}: --primary (hue ${ramp.primary.h}) and --${role} (hue ${ramp[role].h}) are ${separation} degrees apart, which reads as the same colour. Semantic roles have to stay distinguishable from the accent.`,
      );
    }
  }
});
