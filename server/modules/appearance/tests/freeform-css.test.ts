import assert from 'node:assert/strict';
import test from 'node:test';

import { FREEFORM_BUDGETS, validateFreeformCss } from '@/modules/appearance/freeform-css.js';

/** Asserts a stylesheet is rejected, and returns the messages for inspection. */
const reject = (css: string, label: string): string[] => {
  const result = validateFreeformCss(css);
  assert.equal(result.ok, false, `${label}: expected a rejection, got ok`);
  assert.ok(!result.ok && result.issues.length > 0, `${label}: rejected with no issues`);
  return result.ok ? [] : result.issues.map((issue) => `${issue.path}: ${issue.message}`);
};

/** Asserts a stylesheet is accepted, and returns the re-serialised output. */
const accept = (css: string, label: string): string => {
  const result = validateFreeformCss(css);
  assert.ok(result.ok, `${label}: expected acceptance, got ${JSON.stringify(result.ok ? [] : result.issues, null, 1)}`);
  return result.ok ? result.css : '';
};

test('url() is rejected everywhere, in every spelling', () => {
  // The single rule that removes the whole exfiltration class. Every one of
  // these is a way a stylesheet could make the app perform a network request
  // whose timing or existence carries information.
  reject('[data-tails-part="card"] { background-image: url("https://example.test/p.png") }', 'quoted url');
  reject('[data-tails-part="card"] { background-image: url(https://example.test/p.png) }', 'bare url');
  reject('.t-a { --texture: url("data:image/svg+xml,x") }', 'url inside a custom property');
  reject('.t-a { cursor: url("https://example.test/c.cur"), auto }', 'url in cursor');
  reject('.t-a { background-image: image-set("https://example.test/a.png" 1x) }', 'image-set');
  reject('.t-a { background-image: -webkit-image-set(url(x) 1x) }', 'prefixed image-set');
  reject('.t-a { background-image: src("https://example.test/a.png") }', 'src()');

  // An escaped spelling that a regex over the source text would sail past, and
  // the reason this validator parses instead of matching.
  reject(String.raw`.t-a { background: u\72 l("https://example.test/x") }`, 'escaped url');
});

test('layout, sizing and visibility properties are rejected', () => {
  for (const declaration of [
    'display: none',
    'visibility: hidden',
    'width: 0',
    'height: 0',
    'min-height: 100vh',
    'max-width: 0',
    'overflow: hidden',
    'pointer-events: none',
    'user-select: none',
    'order: 9',
    'direction: rtl',
    'float: left',
    'contain: strict',
    'all: unset',
    'zoom: 0',
    'clip-path: inset(50%)',
    'mask-image: linear-gradient(#000, transparent)',
    'aspect-ratio: 1',
  ]) {
    reject(`[data-tails-part="card"] { ${declaration} }`, declaration);
  }
});

test('position, inset and z-index are rejected outside a pseudo-element', () => {
  const issues = reject('[data-tails-part="card"] { position: fixed; inset: 0; z-index: 4 }', 'positioned surface');
  assert.ok(issues.some((issue) => issue.includes('::before')), issues.join('\n'));

  // The same declarations on a generated element are fine: nothing queries it,
  // nobody clicks it, and it cannot escape the surface that owns it.
  accept('[data-tails-part="card"]::before { content: ""; position: absolute; inset: 0; z-index: 4 }', 'positioned pseudo');
});

test('a decoration cannot be lifted above the app', () => {
  reject('[data-tails-part="card"]::after { content: ""; position: absolute; z-index: 9 }', 'high z-index');
  accept('[data-tails-part="card"]::after { content: ""; position: absolute; z-index: 5 }', 'capped z-index');
});

test('at-rules outside the allowlist are rejected', () => {
  reject('@import "https://example.test/x.css";', '@import');
  reject('@import url("x.css");', '@import url');
  reject('@font-face { font-family: Evil; src: local(Arial) }', '@font-face');
  reject('@layer base { .t-a { color: red } }', '@layer');
  reject('@supports (display: grid) { .t-a { color: red } }', '@supports');
  reject('@charset "utf-8";', '@charset');
});

test('@media may only ask about the three user preferences', () => {
  accept('@media (prefers-color-scheme: dark) { .t-a { color: red } }', 'colour scheme');
  accept('@media (prefers-reduced-motion: reduce) { .t-a { animation: none } }', 'reduced motion');
  accept('@media (forced-colors: active) { .t-a { color: red } }', 'forced colours');

  // Viewport and device queries would let a stylesheet fingerprint the machine.
  reject('@media (min-width: 400px) { .t-a { color: red } }', 'min-width');
  reject('@media (resolution: 2dppx) { .t-a { color: red } }', 'resolution');
  reject('@media screen { .t-a { color: red } }', 'media type');
});

test('selectors must be rooted in the theme namespace', () => {
  reject('* { color: red }', 'universal');
  reject('body { color: red }', 'body');
  reject('html { color: red }', 'html');
  reject('div > p { color: red }', 'type selectors');
  reject('#app { color: red }', 'id selector');
  reject('.chat-message { color: red }', 'an app class');
  reject('[data-testid="x"] { color: red }', 'an unlisted attribute');

  accept('[data-tails-part="card"] { color: red }', 'part');
  accept('[data-tails-surface="raised"] { color: red }', 'surface tone');
  accept('.t-panel { color: red }', 't- class');
  accept('.prose-tails { color: red }', 'prose');
  accept(':root { color: red }', 'root');
  accept('[data-tails-part="card"]:hover .t-icon { color: red }', 'descendant of a part');
});

test('nothing can reach the critical parts of the interface', () => {
  reject('[data-tails-critical] { color: red }', 'direct');
  reject('[data-tails-part="card"] [data-tails-critical] { color: red }', 'descendant');
  reject('.t-a:not([data-tails-critical]) { color: red }', 'inside :not()');
  reject('.t-a:is([data-tails-critical], .t-b) { color: red }', 'inside :is()');
});

test(':has() is rejected because it reaches upward', () => {
  reject('.t-a:has(.t-b) { color: red }', ':has');
  reject('[data-tails-part="card"]:has([data-tails-critical]) { color: red }', ':has reaching critical');
});

test('an element cannot be faded out of existence', () => {
  reject('.t-a { opacity: 0 }', 'zero opacity');
  reject('.t-a { opacity: 0.05 }', 'below the floor');
  reject('.t-a { opacity: 5% }', 'below the floor as a percentage');
  accept('.t-a { opacity: 0.4 }', 'a real fade');

  // The floor protects one element. On :root it protects nothing, because the
  // rule nothing can override is the one that fades the whole app.
  reject(':root { opacity: 0.5 }', 'root opacity');
  reject('.t-a { transform: scale(0) }', 'scaled to nothing');
  reject('.t-a { scale: 0.01 }', 'scale property to nothing');
});

test('filters cannot be used to erase what is behind them', () => {
  reject('.t-a { filter: brightness(0) }', 'brightness 0');
  reject('.t-a { backdrop-filter: contrast(8) }', 'contrast 8');
  accept('.t-a { backdrop-filter: blur(24px) saturate(1.8) brightness(1.05) }', 'a real glass filter');
});

test('transitions cannot run long enough to look like a hang', () => {
  // The ceiling is split by whether anyone is waiting. A transition answers an
  // action, so a slow one reads as a stall; an animation is ambience, and the
  // slow ambient loop — a sheen drifting across glass, a gradient breathing
  // under a card — is precisely the kind of look the declarative spec cannot
  // express and this layer exists to allow.
  reject('.t-a { transition: color 5s }', '5s transition');
  accept('.t-a { transition: color 240ms var(--ease-standard) }', 'a real transition');

  accept('.t-a { animation: t-x 10s linear infinite }', '10s ambient animation');
  reject('.t-a { animation: t-x 90s linear infinite }', '90s animation');
});

test('content is limited to nothing at all', () => {
  accept('.t-a::before { content: "" }', 'empty string');
  accept('.t-a::before { content: none }', 'none');
  reject('.t-a::before { content: "Sponsored" }', 'injected text');
  reject('.t-a::before { content: attr(data-secret) }', 'attr()');
  reject('.t-a::before { content: counter(x) }', 'counter()');
});

test('!important and negative margins are rejected', () => {
  reject('.t-a { color: red !important }', 'important');
  reject('.t-a { margin-top: -40px }', 'negative margin');
  accept('.t-a { margin-top: 8px; padding: 12px }', 'ordinary spacing');
});

test('budgets are enforced by rejection, never by truncation', () => {
  const oversized = `.t-a { color: red; }\n`.repeat(2000);
  const issues = reject(oversized, 'oversized');
  assert.ok(issues.some((issue) => issue.includes('bytes')), issues.join('\n'));
  assert.ok(Buffer.byteLength(oversized) > FREEFORM_BUDGETS.bytes);

  const tooManyRules = Array.from(
    { length: FREEFORM_BUDGETS.rules + 5 },
    (_, index) => `.t-r${index} { color: red }`,
  ).join('\n');
  assert.ok(Buffer.byteLength(tooManyRules) < FREEFORM_BUDGETS.bytes, 'the rule test must not trip the byte budget');
  assert.ok(reject(tooManyRules, 'too many rules').some((issue) => issue.includes('rules exceeds')));

  reject(
    '@media (forced-colors: active) { @media (prefers-reduced-motion: reduce) { @media (prefers-color-scheme: dark) { .t-a { color: red } } } }',
    'too deeply nested',
  );
});

test('every problem is reported at once, with a path', () => {
  const result = validateFreeformCss('body { display: none; background: url(https://example.test/x) }');
  assert.equal(result.ok, false);
  if (result.ok) return;

  assert.ok(result.issues.length >= 3, 'a model fixing one problem per round trip never converges');
  for (const issue of result.issues) {
    assert.match(issue.path, /^(css|rule\[\d+\])/);
    assert.ok(issue.message.length > 20, `unhelpful message: ${issue.message}`);
  }
});

test('a realistic glass stylesheet is accepted and rebuilt from the parse tree', () => {
  const authored = `
    /* A specular sweep for the composer, which the spec cannot express. */
    @property --t-sheen {
      syntax: "<percentage>";
      inherits: false;
      initial-value: 0%;
    }

    @keyframes t-sheen-sweep {
      from { opacity: 0.2 }
      to   { opacity: 0.75 }
    }

    [data-tails-part="popover"] {
      background-color: hsl(220 20% 98% / 0.55);
      background-image: linear-gradient(145deg, hsl(0 0% 100% / 0.35), transparent 55%);
      backdrop-filter: blur(24px) saturate(1.8) brightness(1.02);
      -webkit-backdrop-filter: blur(24px) saturate(1.8);
      border-radius: 18px;
      corner-shape: superellipse(4);
      box-shadow:
        inset 0 1px 0 hsl(0 0% 100% / 0.6),
        0 24px 60px -18px hsl(220 40% 10% / 0.45);
      transition: box-shadow var(--duration-settle) var(--ease-standard);
    }

    [data-tails-part="popover"]::before {
      content: "";
      position: absolute;
      inset: 0;
      z-index: 1;
      border-radius: inherit;
      background-image: linear-gradient(145deg, hsl(0 0% 100% / 0.25), transparent 40%);
      mix-blend-mode: soft-light;
      opacity: 0.9;
      animation: t-sheen-sweep 900ms var(--ease-enter) both;
    }

    [data-tails-surface="raised"] .t-panel {
      color: var(--t-ink);
      text-shadow: 0 1px 0 hsl(0 0% 100% / 0.4);
    }

    .prose-tails {
      line-height: 1.7;
      letter-spacing: 0.005em;
      text-wrap: pretty;
    }

    @media (prefers-reduced-motion: reduce) {
      [data-tails-part="popover"]::before { animation: none }
    }
  `;

  const output = accept(authored, 'glass');

  // Re-serialised, not forwarded: the comment and the author's whitespace are
  // gone because the string was built from the tree, not copied from the input.
  assert.doesNotMatch(output, /specular sweep/);
  assert.ok(output.includes('[data-tails-part="popover"]{'));
  assert.ok(output.includes('backdrop-filter:blur(24px) saturate(1.8) brightness(1.02)'));
  assert.ok(output.includes('@media (prefers-reduced-motion:reduce)'));
  assert.ok(output.includes('corner-shape:superellipse(4)'));

  // And the output is itself valid input, which is the cheap way of asserting
  // the generator cannot produce something the validator would refuse.
  assert.equal(accept(output, 'round trip'), output);
});

test('an empty stylesheet clears the layer rather than erroring', () => {
  const result = validateFreeformCss('   ');
  assert.ok(result.ok);
  assert.equal(result.ok && result.css, '');
});

test('unparseable input is rejected rather than passed through', () => {
  reject('.t-a { color: }', 'empty value');
  reject('} .t-a { color: red }', 'stray brace');
  reject('.t-a { color: red; @nope { } }', 'unknown nested at-rule');

  // An unclosed block is recovered by the parser rather than rejected, and that
  // is the right outcome: the recovery is deterministic, the recovered tree is
  // validated like any other, and the output is regenerated from it. What the
  // author wrote never ships either way.
  assert.equal(accept('.t-a { color: red', 'unclosed block'), '.t-a{color:red}');
});
