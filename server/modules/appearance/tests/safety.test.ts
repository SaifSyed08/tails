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
