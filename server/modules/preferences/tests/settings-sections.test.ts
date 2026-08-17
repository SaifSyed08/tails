import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The settings panel's index, and the two ways it can quietly stop working.
 *
 * A jump link whose target id no longer exists does not throw and does not warn
 * — `getElementById` returns null and the click does nothing, which reads as a
 * dead button. And a preference that is added without an index entry is exactly
 * the defect the index was built to fix, one section later.
 *
 * Both are absences, so both are asserted against the source.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');
const panel = readFileSync(join(repo, 'src', 'components', 'settings', 'SettingsPanel.tsx'), 'utf8');

/** The ids listed in the `SECTIONS` constant, in order. */
function indexedIds(): string[] {
  const start = panel.indexOf('const SECTIONS = [');
  assert.notEqual(start, -1, 'SettingsPanel.tsx has lost its SECTIONS constant');
  const block = panel.slice(start, panel.indexOf('] as const;', start));

  return [...block.matchAll(/id: '([^']+)'/g)].map((match) => match[1]);
}

test('every jump link points at a section that exists', () => {
  const ids = indexedIds();
  assert.ok(ids.length > 0, 'the index is empty');

  for (const id of ids) {
    assert.ok(
      panel.includes(`id="${id}"`),
      `The settings index offers "${id}" and nothing in the panel carries that id, so the button does nothing when clicked.`,
    );
  }
});

test('every section in the panel is in the index', () => {
  // The other direction, which is the one that decays: a new preference gets a
  // section and the index is not touched, and the setting is once again only
  // findable by scrolling.
  const rendered = [...panel.matchAll(/id="(settings-[\w-]+)"/g)].map((match) => match[1]);
  const indexed = new Set(indexedIds());

  for (const id of rendered) {
    assert.ok(
      indexed.has(id),
      `The panel renders a section "${id}" that the index does not list. Add it to SECTIONS.`,
    );
  }
});

test('the voice module\'s own settings are mounted, not reimplemented', () => {
  // The speech models, wake words and sensitivity belong to the voice module and
  // are mounted whole. This module owns only the app-level default voice — the
  // one that speaks when no pet supplies one — and the two must not both grow a
  // list of platform voices.
  assert.match(panel, /<VoiceSettings \/>/, 'the voice module\'s section must be mounted');
  assert.doesNotMatch(
    panel,
    /voiceApi|downloadWakeWord|wake-worker/,
    'model downloads and wake words belong to the voice module; this panel mounts its section rather than rebuilding it.',
  );
});
