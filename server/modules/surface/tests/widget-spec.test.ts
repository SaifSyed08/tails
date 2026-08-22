import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';
import { LIMITS, readSurfaceSpec, WIDGET_KINDS } from '@/modules/surface/widget-spec.js';

const stat = { kind: 'stat', label: 'Tests passing', value: '516' };

/** The dotted paths a rejection reported, so a test can assert on all of them. */
function issuePaths(input: unknown): string[] {
  try {
    readSurfaceSpec(input);
  } catch (error) {
    assert.ok(error instanceof AppError, String(error));
    const details = error.details as { path: string; message: string }[];
    return details.map((issue) => issue.path);
  }
  return assert.fail('expected the surface to be refused');
}

test('a well-formed surface survives', () => {
  const surface = readSurfaceSpec({ title: 'Test run', widgets: [stat] });
  assert.equal(surface.title, 'Test run');
  assert.equal(surface.widgets.length, 1);
});

/*
  The refusals. This module's entire security value is that the vocabulary is
  closed, so the tests that matter are the ones that prove it stays shut.
*/

test('a kind the app cannot draw is refused, not passed through', () => {
  // The whole model in one test: an unrecognised kind has no renderer, so
  // accepting it would put an empty box beside the conversation and call it a
  // feature. There is no "custom", "html" or "other".
  for (const kind of ['html', 'custom', 'iframe', 'script', 'gallery', 'form']) {
    assert.ok(
      issuePaths({ title: 'x', widgets: [{ kind, body: 'hi' }] }).length > 0,
      `${kind} must be refused`,
    );
  }
});

test('a colour cannot be smuggled in as a tone', () => {
  // Tone is meaning. A widget that could name a colour is a widget that looks
  // wrong in every look the user asks for after the one it was written in.
  for (const value of ['#ff0000', 'red', 'var(--primary)', 'rgb(1,2,3)']) {
    assert.deepEqual(
      issuePaths({ title: 'x', widgets: [{ ...stat, tone: value }] }),
      ['widgets.0.tone'],
    );
  }
});

test('every bad field is reported at once, with its path', () => {
  // One revision rather than one round trip per mistake.
  const paths = issuePaths({
    title: 'x',
    widgets: [
      { kind: 'stat', label: 'a', value: 'b', tone: 'chartreuse' },
      { kind: 'progress', label: 'b', fraction: 4 },
    ],
  });

  assert.deepEqual(new Set(paths), new Set(['widgets.0.tone', 'widgets.1.fraction']));
});

test('limits refuse rather than truncate', () => {
  // Losing half a table silently is worse than an error the agent can correct.
  const tooMany = {
    title: 'x',
    widgets: Array.from({ length: LIMITS.widgets + 1 }, () => stat),
  };
  assert.deepEqual(issuePaths(tooMany), ['widgets']);

  const tooWide = {
    title: 'x',
    widgets: [{
      kind: 'table',
      columns: Array.from({ length: LIMITS.columns + 1 }, (_, i) => `c${i}`),
      rows: [],
    }],
  };
  assert.deepEqual(issuePaths(tooWide), ['widgets.0.columns']);

  const tooLong = { title: 'x', widgets: [{ ...stat, label: 'a'.repeat(LIMITS.label + 1) }] };
  assert.deepEqual(issuePaths(tooLong), ['widgets.0.label']);
});

test('a progress bar past its own end is a bug, not a value to clamp', () => {
  assert.deepEqual(
    issuePaths({ title: 'x', widgets: [{ kind: 'progress', label: 'a', fraction: 1.2 }] }),
    ['widgets.0.fraction'],
  );
  assert.deepEqual(
    issuePaths({ title: 'x', widgets: [{ kind: 'progress', label: 'a', fraction: -0.1 }] }),
    ['widgets.0.fraction'],
  );
});

test('an empty panel is refused', () => {
  // Nothing to draw is a generation that went wrong, and showing an empty panel
  // beside the conversation would report it as success.
  assert.deepEqual(issuePaths({ title: 'x', widgets: [] }), ['widgets']);
});

test('a monitor can only report a status the app knows how to draw', () => {
  assert.deepEqual(
    issuePaths({ title: 'x', widgets: [{ kind: 'monitor', label: 'a', status: 'exploded' }] }),
    ['widgets.0.status'],
  );
});

test('text is stripped of what should never be in it, and nothing else', () => {
  const surface = readSurfaceSpec({
    title: 'x',
    widgets: [{
      kind: 'note',
      // A bidirectional override makes a string render in an order its
      // characters do not have — a label that reads as one thing and is
      // another. Control characters break layout and logs.
      body: `safe‮text⁩ <b>kept</b>`,
    }],
  });

  const widget = surface.widgets[0];
  assert.equal(widget.kind, 'note');
  assert.equal(widget.kind === 'note' ? widget.body : '', 'safetext <b>kept</b>');
});

test('markup characters survive, because the renderer is the defence', () => {
  // Escaping here would be a second opinion about safety that disagrees with
  // the renderer sooner or later. React children never parse markup, so `<` is
  // a character — and a note about HTML should be able to contain HTML.
  const surface = readSurfaceSpec({
    title: 'x',
    widgets: [{ kind: 'note', body: '<script>alert(1)</script>' }],
  });
  assert.equal(
    surface.widgets[0].kind === 'note' ? surface.widgets[0].body : '',
    '<script>alert(1)</script>',
  );
});

test('every kind in the union parses, so none is unreachable', () => {
  // Guards the quiet failure: a kind listed for the model, described in the
  // tool schema, and refused by the validator.
  const samples: Record<string, unknown> = {
    stat,
    chart: { kind: 'chart', series: [{ label: 'a', value: 1 }] },
    table: { kind: 'table', columns: ['a'], rows: [['1']] },
    checklist: { kind: 'checklist', items: [{ label: 'a', done: false }] },
    timeline: { kind: 'timeline', events: [{ label: 'a' }] },
    progress: { kind: 'progress', label: 'a', fraction: 0.5 },
    note: { kind: 'note', body: 'a' },
    monitor: { kind: 'monitor', label: 'a', status: 'watching' },
  };

  for (const kind of WIDGET_KINDS) {
    assert.ok(samples[kind], `no sample for ${kind}`);
    const surface = readSurfaceSpec({ title: 'x', widgets: [samples[kind]] });
    assert.equal(surface.widgets[0].kind, kind);
  }
});
