import assert from 'node:assert/strict';
import test from 'node:test';

import { decide, nextSeen, type Probe } from '@/modules/surface/bindings.js';
import { AppError } from '@/shared/utils.js';
import { readSurfaceSpec, WATCH_INTERVAL, type Watch } from '@/modules/surface/widget-spec.js';

const httpWatch: Watch = { source: 'http', url: 'http://localhost:5173', everyMs: 5_000 };
const expecting: Watch = { ...httpWatch, expect: 'MATCH FOUND' };
const fileWatch: Watch = { source: 'file', path: 'build/out.txt', everyMs: 5_000 };

const reachable = (body = ''): Probe => ({ ok: true, kind: 'http', status: 200, body });
const changed = (changedAt: string): Probe => ({ ok: true, kind: 'file', changedAt, bytes: 12 });

/* What a look at the world means. The half with the rules, kept pure. */

test('a service that is not answering is an error, not a silence', () => {
  const patch = decide({ ok: false, reason: 'Not responding.' }, httpWatch, null);
  assert.equal(patch.status, 'error');
  assert.equal(patch.detail, 'Not responding.');
});

test('an answering service with nothing to look for is simply watching', () => {
  assert.equal(decide(reachable(), httpWatch, null).status, 'watching');
});

test('a server error is the monitor\'s error too', () => {
  const patch = decide({ ok: true, kind: 'http', status: 500, body: '' }, httpWatch, null);
  assert.equal(patch.status, 'error');
});

test('the phrase appearing is the match, and it reports the line it was on', () => {
  const body = 'nothing here\n  <div>MATCH FOUND: listing 41</div>\nmore';
  const patch = decide(reachable(body), expecting, null);

  assert.equal(patch.status, 'match');
  assert.equal(patch.match, '<div>MATCH FOUND: listing 41</div>');
});

test('the phrase absent keeps it watching rather than erroring', () => {
  // Not finding it yet is the normal state of a search, and reporting it as a
  // failure would make every monitor look broken for as long as it works.
  assert.equal(decide(reachable('still looking'), expecting, null).status, 'watching');
});

test('a match is trimmed to something worth reading aloud', () => {
  const long = `x${'y'.repeat(500)}MATCH FOUND`;
  const patch = decide(reachable(long), expecting, null);
  assert.ok((patch.match?.length ?? 0) <= 200, String(patch.match?.length));
});

/* Files. The distinction that matters is change, not existence. */

test('the first look at a file establishes a baseline rather than reporting one', () => {
  // Otherwise every monitor announces a match the instant it starts, for a file
  // that was last written last week.
  const patch = decide(changed('2026-08-22T10:00:00.000Z'), fileWatch, null);
  assert.equal(patch.status, 'watching');
});

test('an unchanged file is not news', () => {
  const at = '2026-08-22T10:00:00.000Z';
  assert.equal(decide(changed(at), fileWatch, at).status, 'watching');
});

test('a changed file is', () => {
  const patch = decide(changed('2026-08-22T11:00:00.000Z'), fileWatch, '2026-08-22T10:00:00.000Z');
  assert.equal(patch.status, 'match');
  assert.match(patch.detail, /11:00/);
});

test('a missing file is an error, and the baseline survives it', () => {
  // A file that vanishes for one tick — mid-write, say — must not reset the
  // comparison, or its reappearance would be reported as a change that is
  // really the same file coming back.
  const missing: Probe = { ok: false, reason: 'Not there.' };
  assert.equal(decide(missing, fileWatch, 'earlier').status, 'error');
  assert.equal(nextSeen(missing, 'earlier'), 'earlier');
});

test('only a file probe moves the baseline', () => {
  assert.equal(nextSeen(changed('now'), 'earlier'), 'now');
  assert.equal(nextSeen(reachable('body'), 'earlier'), 'earlier');
});

/* The contract the agent has to satisfy to get a watcher at all. */

function refuse(watch: unknown): string[] {
  try {
    readSurfaceSpec({
      title: 'x',
      widgets: [{ kind: 'monitor', label: 'a', status: 'watching', watch }],
    });
  } catch (error) {
    assert.ok(error instanceof AppError, String(error));
    return (error.details as { path: string }[]).map((issue) => issue.path);
  }
  return assert.fail('expected the watch to be refused');
}

test('there is no source that runs a command', () => {
  // The omission is the design. A shell command on a repeating timer is a
  // standing grant to execute and there is no turn for it to be approved in.
  for (const source of ['command', 'shell', 'exec', 'bash']) {
    assert.ok(refuse({ source, command: 'npm test' }).length > 0, source);
  }
});

test('an interval faster than the floor is refused, not quietly raised', () => {
  // A watcher runs unattended for hours. The gap between two seconds and two
  // hundred milliseconds is the gap between a monitor and a load test.
  assert.deepEqual(
    refuse({ source: 'http', url: 'http://localhost:1', everyMs: 100 }),
    ['widgets.0.watch.everyMs'],
  );
  assert.deepEqual(
    refuse({ source: 'file', path: 'a', everyMs: WATCH_INTERVAL.max + 1 }),
    ['widgets.0.watch.everyMs'],
  );
});

test('an interval left unsaid gets the default rather than none', () => {
  const surface = readSurfaceSpec({
    title: 'x',
    widgets: [{
      kind: 'monitor', label: 'a', status: 'watching',
      watch: { source: 'file', path: 'a' },
    }],
  });
  const widget = surface.widgets[0];
  assert.equal(widget.kind === 'monitor' ? widget.watch?.everyMs : 0, WATCH_INTERVAL.fallback);
});

test('a monitor without a watch is still a monitor', () => {
  // The agent redrawing the panel itself is the ordinary case; watching is the
  // addition, not the requirement.
  const surface = readSurfaceSpec({
    title: 'x',
    widgets: [{ kind: 'monitor', label: 'a', status: 'idle' }],
  });
  assert.equal(surface.widgets[0].kind, 'monitor');
});
