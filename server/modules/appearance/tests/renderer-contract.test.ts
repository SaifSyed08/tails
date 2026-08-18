import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { deriveTokens } from '@/modules/appearance/derive.js';
import { THEME_PRESETS } from '@/modules/appearance/presets.js';
import { serializeStylesheet } from '@/modules/appearance/serialize.js';
import { SURFACE_PARTS } from '@/modules/appearance/surface-recipe.js';

/**
 * The contract between the two halves of the appearance engine.
 *
 * The server derives tokens; `src/index.css` turns them into pixels. Neither
 * half can see the other, and a token that is emitted but never consumed fails
 * completely silently — the theme validates, the CSS is served, and the app
 * looks identical to before.
 *
 * That is not a hypothetical. It is exactly what v1 did: roughly half the spec
 * was validated and then dropped on the floor, `surfaceTexture: 'glass'`
 * produced no token at all, and the only behaviour left to the model was
 * picking the nearest preset. Every bug of that shape is invisible to type
 * checking, to the schema tests, and to a human reading either file alone.
 * This test is the thing that sees it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const indexCss = readFileSync(join(here, '..', '..', '..', '..', 'src', 'index.css'), 'utf8');

/** Every `--t-*` custom property the renderer reads through `var()`. */
const consumed = new Set(
  [...indexCss.matchAll(/var\(\s*(--t-[a-z0-9-]+)/g)].map((match) => match[1]),
);

/** Every `--t-*` custom property the renderer defines a floor value for. */
const floored = new Set(
  [...indexCss.matchAll(/^\s*(--t-[a-z0-9-]+)\s*:/gm)].map((match) => match[1]),
);

/** Every `--t-*` custom property a given stylesheet declares. */
const emittedBy = (css: string): Set<string> =>
  new Set([...css.matchAll(/^\s*(--t-[a-z0-9-]+)\s*:/gm)].map((match) => match[1]));

/**
 * Tokens that are emitted and deliberately not consumed, each with its reason.
 *
 * An allowlist rather than a looser assertion, because "this one is fine" is a
 * claim that should have to be written down and reviewed. A token drifting into
 * disuse looks identical to a token that was never wired up; the difference is
 * only ever the intent, so the intent is what gets recorded.
 */
const DELIBERATELY_UNCONSUMED: Record<string, string> = {
  '--t-texture-opacity':
    'A 0-or-1 presence flag, not a strength. The authored strength is baked into --t-texture-image itself, because a pseudo-element has one opacity and the texture and overlay layers sharing it need two. The renderer relies on the image being `none` when absent, so it has nothing to read here — the flag exists for v1 token blobs, which are replayed from cache and must keep resolving every name they were saved with.',
  '--t-overlay-opacity':
    'A 0-or-1 presence flag, for the same reason as --t-texture-opacity. The strength is baked into --t-overlay-image.',
  '--t-trail-mode':
    'Selects which renderer draws the trail: element-placed segments, or one of the app-owned canvas effects. There is no CSS property that means "run this frame loop", so this one genuinely cannot have a consumer in index.css — it is read by trailCanvas.ts. Distinct from the tokens that shape the trail, all of which are consumed: this decides which code runs, not what it looks like.',
  '--t-window-backdrop':
    'Names an operating-system window effect — "acrylic", "mica" or "opaque" — and is read by applyTheme.ts, which hands it to Electron over IPC. There is no CSS property that means "ask the compositor to blur what is behind this window", so this one genuinely cannot have a consumer here. Its companion --t-window-tint *is* consumed: the shell stamps `data-window-backdrop` on the root, and that attribute is what index.css branches on, because CSS can match an attribute value and cannot match a custom property value.',
  '--t-trail-palette':
    'A comma-separated colour list for the canvas trails, where "rainbow" strokes one band per entry. CSS has no way to consume a variable-length colour list — a gradient would fix the count and the geometry, which is exactly what the renderer needs to decide per effect. Read by trailCanvas.ts alongside --t-trail-mode.',
};

test('the renderer consumes every surface token the presets emit', () => {
  const unconsumed = new Map<string, string[]>();

  for (const [id, spec] of Object.entries(THEME_PRESETS)) {
    for (const token of emittedBy(serializeStylesheet(deriveTokens(spec)))) {
      if (consumed.has(token) || token in DELIBERATELY_UNCONSUMED) continue;
      unconsumed.set(token, [...(unconsumed.get(token) ?? []), id]);
    }
  }

  assert.deepEqual(
    [...unconsumed].map(([token, presets]) => `${token} (emitted by ${presets.join(', ')})`),
    [],
    'These tokens are derived and serialized but src/index.css never reads them, so they have no effect on the rendered app. Either consume them in the renderer or stop emitting them.',
  );
});

test('the unconsumed-token allowlist has no stale entries', () => {
  // An allowlist nobody prunes stops describing the system and starts hiding
  // it. If a token named here is no longer emitted at all, the exemption is
  // dead and should go with it.
  const everEmitted = new Set(
    Object.values(THEME_PRESETS).flatMap((spec) => [
      ...emittedBy(serializeStylesheet(deriveTokens(spec))),
    ]),
  );

  const stale = Object.keys(DELIBERATELY_UNCONSUMED)
    .filter((token) => !everEmitted.has(token) && !consumed.has(token));

  assert.deepEqual(stale, [], 'These tokens are exempted from the consumption check but no preset emits them any more. Delete the exemption.');
});

test('every consumed surface token has a floor value in :root', () => {
  // Without a floor, an unbound app paints the part with the property's
  // initial value — `background-color: transparent`, `border-width: medium` —
  // rather than with the built-in look. The floor has to be a complete theme,
  // not the absence of one.
  const missing = [...consumed].filter((token) => !floored.has(token));

  assert.deepEqual(
    missing,
    [],
    'src/index.css reads these tokens but never defines them on :root, so an app with no theme bound renders them as their CSS initial value.',
  );
});

test('every part the renderer marks up is a part the theme can target', () => {
  // A `data-tails-part` value outside SURFACE_PARTS receives no tokens at all.
  // It is not a type error and it is not a runtime error; the element simply
  // never gets themed, which is the hardest kind of styling bug to notice.
  // Asserted here rather than in the client because this is where the closed
  // list lives.
  const partsInCss = new Set(
    [...indexCss.matchAll(/data-tails-part=['"]([a-zA-Z]+)['"]/g)].map((match) => match[1]),
  );

  const unknown = [...partsInCss].filter((part) => !(SURFACE_PARTS as readonly string[]).includes(part));

  assert.deepEqual(unknown, [], 'src/index.css styles parts that the theme engine cannot target.');
});
