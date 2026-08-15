import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FREEFORM_BUDGETS,
  validateFreeformCss,
  validateTokenValue,
} from '@/modules/appearance/freeform-css.js';

/**
 * What the freeform layer refuses, and — just as important — what it no longer
 * refuses.
 *
 * This file used to be a list of things a theme could not do: no `display`, no
 * `position` outside a pseudo-element, no opacity under 0.15, no filter outside
 * 0.5-2, no `!important`, no negative margins, no `:has()`, no media query that
 * was not one of three, no property outside a two-hundred-name allowlist. Every
 * one of those rules also blocked a look nobody had thought of, which for a
 * feature whose entire purpose is looks nobody has thought of is the wrong
 * trade. They are gone, and half of this file exists to hold them gone — a
 * removed restriction with no test is a restriction that grows back.
 *
 * Three rules survived, and each has its own test below. They are not aesthetic
 * rules: `url()` is the network boundary, `[data-tails-critical]` is the
 * permission prompt, and `content` is the app's own words. `safety.test.ts`
 * covers the two guarantees that live outside this file — the layer is never
 * persisted, and the panic key is out of process — because those are what make
 * everything above affordable.
 */

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

/* ------------------------------------------------------------------ *
 * Enforced rule 1 — the network boundary.
 * ------------------------------------------------------------------ */

test('ENFORCED: url() is rejected everywhere, in every spelling', () => {
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
  reject('.t-a { background-image: image("https://example.test/a.png") }', 'image()');
  reject('.t-a { background-image: element(#other) }', 'element()');
  reject('.t-a::before { content: attr(data-secret) }', 'attr() reads the DOM into a value');

  // An escaped spelling that a regex over the source text would sail past, and
  // the reason this validator parses instead of matching. It is also the case
  // that swapping the function *allowlist* for a denylist could have silently
  // reintroduced: an allowlist refuses an unrecognised spelling for free, a
  // denylist has to go and recognise it.
  reject(String.raw`.t-a { background: u\72 l("https://example.test/x") }`, 'escaped url');
  reject(String.raw`.t-a { background-image: image\2d set("x" 1x) }`, 'escaped image-set');
});

test('ENFORCED: @import is refused because its string form fetches without url()', () => {
  reject('@import "https://example.test/x.css";', '@import string');
  reject('@import url("x.css");', '@import url');
  reject(String.raw`@im\70 ort "https://example.test/x.css";`, 'escaped @import');

  // @font-face, by contrast, is now allowed — and is safe precisely *because*
  // of the url() ban. `local()` can only name a face already on the machine.
  accept('@font-face { font-family: Themed; src: local("Georgia") }', 'font-face with local()');
  reject('@font-face { font-family: Themed; src: url("https://example.test/f.woff2") }', 'font-face with url()');
});

/* ------------------------------------------------------------------ *
 * Enforced rule 2 — the permission prompt.
 * ------------------------------------------------------------------ */

test('ENFORCED: nothing can target the critical parts of the interface', () => {
  reject('[data-tails-critical] { color: red }', 'direct');
  reject('[data-tails-part="card"] [data-tails-critical] { color: red }', 'descendant');
  reject('.t-a:not([data-tails-critical]) { color: red }', 'inside :not()');
  reject('.t-a:is([data-tails-critical], .t-b) { color: red }', 'inside :is()');
  reject('.t-a:where([data-tails-critical]) { color: red }', 'inside :where()');
  reject(String.raw`[data-tails-critic\61 l] { color: red }`, 'escaped attribute name');

  // :has() is allowed now — it was banned for reaching upward, which is a
  // scoping concern rather than a safety one — but it does not become a way
  // around this rule.
  accept('.t-a:has(.t-b) { color: red }', ':has on ordinary selectors');
  reject('[data-tails-part="card"]:has([data-tails-critical]) { color: red }', ':has reaching critical');

  // The guarantee is "cannot be targeted", not "cannot be affected": a rule on
  // :root inherits into everything and always did. Targeting is the half that
  // matters, because it is the half that can make yes look like no.
  accept(':root { color: red }', 'inheritance is not targeting');
});

/* ------------------------------------------------------------------ *
 * Enforced rule 3 — the app's own words.
 * ------------------------------------------------------------------ */

test('ENFORCED: a theme cannot write text', () => {
  accept('.t-a::before { content: "" }', 'empty string');
  accept('.t-a::before { content: none }', 'none');
  reject('.t-a::before { content: "Safe to approve" }', 'injected text');
  reject('.t-a::before { content: counter(x) }', 'counter()');
  reject('[data-tails-part="card"]::after { content: "Sponsored" }', 'injected text on a card');
});

/* ------------------------------------------------------------------ *
 * The policy that replaced the rest: guidance, not a wall.
 * ------------------------------------------------------------------ */

test('layout, sizing and visibility properties are allowed', () => {
  // Each of these used to be a rejection. They are allowed because the
  // recovery story does not depend on them: the layer is never persisted, so a
  // reload clears it, and the panic key lives outside the renderer. Preventing
  // an ugly or even a broken result is not worth the cost of preventing every
  // good one nobody had thought of.
  for (const declaration of [
    'display: grid',
    'visibility: visible',
    'width: 42ch',
    'min-height: 4rem',
    'overflow: hidden',
    'pointer-events: none',
    'user-select: none',
    'order: 2',
    'float: left',
    'contain: paint',
    'aspect-ratio: 1',
    'clip-path: inset(4px round 8px)',
    'mask-image: linear-gradient(#000, transparent)',
    'position: sticky',
    'inset: 0',
    'z-index: 40',
  ]) {
    accept(`[data-tails-part="card"] { ${declaration} }`, declaration);
  }
});

test('a positioned decoration is no longer capped or confined to a pseudo-element', () => {
  accept('[data-tails-part="card"] { position: fixed; inset: 0; z-index: 4 }', 'positioned surface');
  accept('[data-tails-part="card"]::after { content: ""; position: absolute; z-index: 40 }', 'high z-index');
});

test('selectors are no longer confined to the theme namespace', () => {
  // The rooting rule was ownership etiquette, not safety, and it made a styled
  // caret, a themed selection and a page-level ambient layer inexpressible.
  accept('* { letter-spacing: 0.01em }', 'universal');
  accept('body { background-attachment: fixed }', 'body');
  accept('html { color-scheme: dark }', 'html');
  accept('div > p { text-wrap: pretty }', 'type selectors');
  accept('#app { isolation: isolate }', 'id selector');
  accept('.chat-message { border-radius: 12px }', 'an app class');
  accept('::selection { background: hsl(0 0% 50%) }', 'selection pseudo-element');
  accept('input::placeholder { opacity: 0.5 }', 'placeholder');

  // And the ones that always worked still do.
  accept('[data-tails-part="card"] { color: red }', 'part');
  accept('.prose-tails { line-height: 1.7 }', 'prose');
});

test('at-rules beyond the old allowlist are allowed', () => {
  accept('@layer theme { .t-a { color: red } }', '@layer');
  accept('@supports (corner-shape: squircle) { .t-a { corner-shape: squircle } }', '@supports');
  accept('@container (min-width: 40rem) { .t-a { padding: 2rem } }', '@container');
  accept('@keyframes t-x { from { opacity: 0.2 } to { opacity: 1 } }', '@keyframes');
  accept('@property --t-x { syntax: "<length>"; inherits: false; initial-value: 0px }', '@property');
});

test('@media may ask about anything, because there is nothing to report it to', () => {
  accept('@media (prefers-color-scheme: dark) { .t-a { color: red } }', 'colour scheme');
  accept('@media (prefers-reduced-motion: reduce) { .t-a { animation: none } }', 'reduced motion');

  // Viewport and resolution queries used to be refused as a fingerprinting
  // risk. Without url() a fingerprint has nowhere to go, so all the rule did
  // was stop a theme adapting to the window it is in.
  accept('@media (min-width: 400px) { .t-a { padding: 2rem } }', 'min-width');
  accept('@media (resolution: 2dppx) { .t-a { border-width: 0.5px } }', 'resolution');
  accept('@media screen { .t-a { color: red } }', 'media type');
});

test('the numeric floors and ceilings are gone', () => {
  accept('.t-a { opacity: 0 }', 'zero opacity');
  accept(':root { opacity: 0.5 }', 'root opacity');
  accept('.t-a { transform: scale(0) }', 'scaled to nothing');
  accept('.t-a { filter: brightness(0) }', 'brightness 0');
  accept('.t-a { backdrop-filter: contrast(8) }', 'contrast 8');
  accept('.t-a { transition: color 5s }', '5s transition');
  accept('.t-a { animation: t-x 90s linear infinite }', '90s animation');
  accept('.t-a { margin-top: -40px }', 'negative margin');
  accept('.t-a { color: red !important }', '!important');
});

/* ------------------------------------------------------------------ *
 * Mechanics that are not policy: parsing, re-serialisation, budgets.
 * ------------------------------------------------------------------ */

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

  // The nesting cap is generous rather than absent: @supports and @container
  // each cost a level now, and the old depth of three made an ordinary
  // conditional rule unreachable.
  const shallow = '@supports (display: grid) { @media (min-width: 40rem) { @media (prefers-color-scheme: dark) { .t-a { color: red } } } }';
  accept(shallow, 'three at-rules deep');
  const deep = Array.from({ length: FREEFORM_BUDGETS.nesting + 2 }, () => '@media (min-width: 1px) {').join('')
    + '.t-a { color: red }'
    + '}'.repeat(FREEFORM_BUDGETS.nesting + 2);
  reject(deep, 'past the nesting cap');
});

test('every problem is reported at once, with a path', () => {
  const result = validateFreeformCss(`
    .t-a { background: url(https://example.test/x) }
    [data-tails-critical] { color: red }
    .t-c::before { content: "Approved" }
  `);
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
      backdrop-filter: blur(var(--glass-blur, 24px)) saturate(1.8) brightness(1.02);
      -webkit-backdrop-filter: blur(var(--glass-blur, 24px)) saturate(1.8);
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
  assert.ok(output.includes('saturate(1.8) brightness(1.02)'));
  assert.ok(output.includes('@media (prefers-reduced-motion:reduce)'));
  assert.ok(output.includes('corner-shape:superellipse(4)'));

  // The `var(--glass-blur, 24px)` above is the shape a look has to take for
  // `theme_controls` to be able to publish a live slider for it.
  assert.match(output, /var\(--glass-blur,\s*24px\)/);

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

  // An unclosed block is recovered by the parser rather than rejected, and that
  // is the right outcome: the recovery is deterministic, the recovered tree is
  // validated like any other, and the output is regenerated from it. What the
  // author wrote never ships either way.
  assert.equal(accept('.t-a { color: red', 'unclosed block'), '.t-a{color:red}');
});

/* ------------------------------------------------------------------ *
 * The same rules, reached from the live-controls side.
 * ------------------------------------------------------------------ */

test('a control value is held to the url() ban even though it never forms a rule', () => {
  // `theme_controls` writes custom properties straight onto :root, so nothing
  // above ever sees them. A second, weaker check on that path would be a hole
  // through the one rule with no aesthetic component, from the direction nobody
  // inspects.
  assert.equal(validateTokenValue('url("https://example.test/x.png")').ok, false);
  assert.equal(validateTokenValue('image-set("https://example.test/x.png" 1x)').ok, false);
  assert.equal(validateTokenValue(String.raw`u\72 l("https://example.test/x")`).ok, false);
  assert.equal(validateTokenValue('attr(data-secret)').ok, false);
  assert.equal(validateTokenValue('x'.repeat(600)).ok, false);

  const blur = validateTokenValue('24px');
  assert.ok(blur.ok);
  assert.equal(blur.ok && blur.css, '24px');
  assert.ok(validateTokenValue('hsl(220 40% 60% / 0.4)').ok);
  assert.ok(validateTokenValue('superellipse(4)').ok);
});
