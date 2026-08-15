import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The two guarantees that make the rest of the freedom affordable.
 *
 * The freeform CSS validator gave up almost every rule it had — the property
 * allowlist, the opacity floor, the filter ranges, the scale minimum, the
 * z-index cap, the rooted-selector requirement, the `!important` ban. That was
 * the right trade only because two things underneath it are true:
 *
 *   1. **Nothing is persisted that the app cannot boot without.** Freeform CSS
 *      and live control values live in the renderer until reload. This is what
 *      makes the worst case "reload the window" rather than "the app opens
 *      broken and the thing that would fix it is the thing that is broken".
 *   2. **The panic key is handled out of process.** `Ctrl+Alt+Shift+T` is
 *      caught in the Electron main process, where no stylesheet and no renderer
 *      bug can reach it.
 *
 * Neither can be tested by calling a function: the first is the *absence* of a
 * write and the second lives in another process. So both are asserted against
 * the source, the way `renderer-contract.test.ts` asserts the client half of
 * the token contract — a guarantee nobody checks is a guarantee that quietly
 * stops holding, and these two are load-bearing for everything above them.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');
const read = (...parts: string[]): string => readFileSync(join(repo, ...parts), 'utf8');

const themeService = read('server', 'modules', 'appearance', 'theme.service.ts');

/** The body of one method in the service object literal, by name. */
const methodBody = (source: string, name: string): string => {
  const start = source.indexOf(`\n  ${name}(`);
  assert.notEqual(start, -1, `theme.service.ts has no method named ${name}`);
  const end = source.indexOf('\n  },', start);
  assert.notEqual(end, -1, `could not find the end of ${name}`);
  return source.slice(start, end);
};

test('ENFORCED: the ephemeral layers never touch the database', () => {
  // `themesRepository` is the only way anything in this module reaches disk, so
  // its absence from these three bodies is the whole assertion. A future edit
  // that adds a "remember the user\'s custom CSS" convenience would fail here,
  // which is exactly when someone should have to argue for it: persisting the
  // layer means the app can boot into a stylesheet that hides the control you
  // would use to remove it.
  for (const name of ['applyFreeformCss', 'clearFreeformCss', 'publishControls', 'proposeVariants']) {
    assert.doesNotMatch(
      methodBody(themeService, name),
      /themesRepository/,
      `${name} writes to the theme repository. The freeform, control and proposal layers must stay in the renderer until reload — that is the recovery path the loosened validator depends on.`,
    );
  }
});

test('an ephemeral layer cannot outlive the look it was written for', () => {
  // A real leak, found from a user report: "one of the styles gave me a cursor
  // glow but I'm not sure if that was supposed to be permanent". It was not.
  // The freeform CSS layer is adopted as its own stylesheet, and neither
  // `unbind` nor `applyTheme` ever dropped it — so an effect written into it
  // survived switching to a different theme *and* survived "reset appearance",
  // and the only things that cleared it were a reload and the panic key. To the
  // user that is indistinguishable from a permanent app feature with no switch.
  //
  // Asserted against the source for the same reason as the tests around it: the
  // bug was the *absence* of a call, and absences do not show up in a unit test
  // that only checks what a function returns.
  const unbind = methodBody(themeService, 'unbind');
  assert.match(unbind, /this\.clearFreeformCss\(/, 'unbind must drop the freeform layer: "reset appearance" has to mean every layer.');
  assert.match(unbind, /this\.clearControls\(/, 'unbind must drop the published controls too — a knob wired to a theme that is gone is a knob that does nothing.');

  const apply = methodBody(themeService, 'applyTheme');
  assert.match(apply, /keepFreeformLayer/, 'switching theme must retire the freeform layer unless the caller opts out.');

  // The opt-out belongs to the agent and only to the agent: it is
  // mid-composition and the CSS it wrote a moment ago is part of the look it is
  // applying. The user picking a theme in Settings means the opposite, so the
  // HTTP route must not pass it.
  const tools = read('server', 'modules', 'appearance', 'appearance.tools.ts');
  assert.match(tools, /keepFreeformLayer: true/);
  const routes = read('server', 'modules', 'appearance', 'appearance.routes.ts');
  assert.doesNotMatch(routes, /keepFreeformLayer/, 'the Settings apply path must start from a clean slate.');
});

test('the pointer writer does not run when nothing reads it', () => {
  // An always-on rAF loop writing four custom properties on :root invalidates
  // computed style across the document on every frame the mouse moves. For a
  // feature no bound theme uses, that is a battery cost with no benefit — and
  // it was shipping that way.
  const pointer = read('src', 'components', 'appearance', 'pointerTokens.ts');
  assert.match(pointer, /if \(!needed\(\)\) return;/, 'the move handler must bail before scheduling a frame when nothing consumes the tokens.');
  assert.match(pointer, /adoptedStyleSheets/, 'the check must look at what the theme and freeform layers actually reference.');
  assert.match(pointer, /export function refreshPointerTracking/, 'the answer has to be re-derivable when the appearance changes.');

  // And the trail's own loop is mounted only when there is a trail.
  const layer = read('src', 'components', 'appearance', 'PointerLayer.tsx');
  assert.match(layer, /if \(drawn\.segments === 0\) return undefined;/);
  assert.match(layer, /prefers-reduced-motion: reduce/, 'a trail is autonomous motion and must honour the preference.');
});

test('an app-drawn cursor never takes the native one away where it is load-bearing', () => {
  // `--t-cursor: none` is how a theme hides the real pointer. Over a text
  // field, a resize handle or a permission prompt, the pointer's shape and
  // exact position are carrying information — the same reasoning as the
  // [data-tails-critical] selector ban, one property along.
  const css = read('src', 'index.css');
  const start = css.indexOf('Where the native cursor always comes back');
  assert.notEqual(start, -1, 'index.css has lost the native-cursor safety rule');

  // The selector list and its declaration, taken as one block so the assertion
  // cannot pass on a selector list that has drifted away from its rule.
  const rule = css.slice(start, css.indexOf('cursor: auto;', start) + 'cursor: auto;'.length);
  for (const selector of ['input', 'textarea', '[contenteditable]', '[data-tails-critical]']) {
    assert.ok(
      rule.includes(selector),
      `${selector} must keep the native cursor when a theme sets --t-cursor: none.`,
    );
  }
});

test('ENFORCED: nothing ephemeral is served from /resolve either', () => {
  // The other half of non-persistence. Even without a database write, an
  // ephemeral layer replayed on boot from `resolveAppearance` would survive a
  // reload, and "reload the window" would stop being a recovery path.
  const resolve = methodBody(themeService, 'resolveAppearance');
  for (const forbidden of ['freeform', 'controls', 'proposal']) {
    assert.doesNotMatch(
      resolve,
      new RegExp(forbidden, 'i'),
      `resolveAppearance mentions "${forbidden}". Only the persisted theme layer may be replayed on boot.`,
    );
  }
});

test('ENFORCED: the panic key is handled in the main process, not the renderer', () => {
  const main = read('electron', 'main.js');

  // Caught before the page sees it, in the process the page cannot reach.
  assert.match(main, /before-input-event/, 'the panic key must be caught in the main process');
  assert.match(main, /input\.key\.toLowerCase\(\) === 't'/);
  assert.match(main, /event\.preventDefault\(\)/, 'the keystroke must not also reach the page');

  // The reset deletes the sheets rather than trying to out-specify them.
  // Specificity and `!important` are games a theme can play too, and now that
  // `!important` is allowed in the freeform layer it can play them well.
  assert.match(main, /document\.adoptedStyleSheets = \[\]/);
  assert.match(main, /localStorage\.removeItem\('tails\.themeCss'\)/);
  assert.match(main, /appearance\/unbind/);
});

test('ENFORCED: the live-control layer is inside the panic key\'s reach', () => {
  // Control overrides are written into `adoptedStyleSheets` specifically so the
  // reset above clears them for free. An inline style on documentElement, or a
  // <style> element with an id the main process was never told about, would
  // survive the panic key and leave a knob stuck at whatever it was dragged to.
  const liveTokens = read('src', 'components', 'appearance', 'liveTokens.ts');
  assert.match(liveTokens, /adoptedStyleSheets/);
  assert.doesNotMatch(
    liveTokens,
    /documentElement\.style\.setProperty/,
    'control values must not be written as inline styles: they would outrank the theme\'s own .dark block and survive the panic reset.',
  );
});

test('no renderer code tries to own the panic key', () => {
  // Two handlers for one keystroke is one handler too many, and the renderer's
  // would be the one a stylesheet could interfere with.
  for (const file of ['App.tsx', 'index.css']) {
    const source = read('src', file);
    assert.doesNotMatch(source, /Alt.*Shift.*\bT\b/i, `src/${file} appears to bind the panic key; it belongs in the main process.`);
  }
});
