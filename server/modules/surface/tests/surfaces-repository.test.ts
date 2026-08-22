import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

/*
  A real directory, and set before the modules load.

  `TAILS_HOME` is read at import time, so this has to happen before the dynamic
  imports below — a static import would bind the real home directory and this
  test would write panels into the user's own database.
*/
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tails-surfaces-test-'));
process.env.TAILS_HOME = home;

const { surfacesRepository } = await import('@/db/surfaces.repository.js');
const { getConnection } = await import('@/db/connection.js');

const widgets = [{ id: 'w_1', kind: 'note' as const, body: 'hello' }];
const panel = (title: string, revision = 1) => ({ title, widgets, revision });

/** A conversation this app has a row for, so `prune` does not sweep it away. */
function makeSession(id: string): void {
  getConnection()
    .prepare("INSERT INTO sessions (id, title, cwd) VALUES (?, 'chat', 'C:\\\\work')")
    .run(id);
}

describe('stored panels', () => {
  it('comes back after being written', () => {
    makeSession('a');
    surfacesRepository.write('a', panel('Test run'));

    const stored = surfacesRepository.read('a');
    assert.equal(stored?.title, 'Test run');
    assert.equal(stored?.widgets.length, 1);
    assert.equal(stored?.pinned, false);
  });

  it('is replaced whole, never merged', () => {
    // The same rule the service enforces in memory: a panel is always a
    // complete statement, so a rewrite cannot leave half of the previous one.
    surfacesRepository.write('a', { title: 'Second', widgets: [], revision: 2 });
    // An empty widget list is not a panel, and reading it back as one would put
    // an empty box beside a conversation.
    assert.equal(surfacesRepository.read('a'), null);

    surfacesRepository.write('a', panel('Third', 3));
    assert.equal(surfacesRepository.read('a')?.revision, 3);
  });

  it('refuses a row it can no longer parse', () => {
    // A stored panel outlives the code that wrote it. Losing it is the right
    // failure — the agent can build a new one — and drawing half of an older
    // app's dashboard is not.
    getConnection().prepare("UPDATE surfaces SET widgets_json = '{ not json' WHERE session_id = ?")
      .run('a');
    assert.equal(surfacesRepository.read('a'), null);
    surfacesRepository.write('a', panel('Recovered', 4));
  });

  it('pins exactly one panel', () => {
    // Two would be two claims on the same strip of screen beside every
    // conversation, and nothing would decide between them.
    makeSession('b');
    surfacesRepository.write('b', panel('Other'));

    surfacesRepository.pin('a');
    assert.equal(surfacesRepository.readPinned()?.sessionId, 'a');

    surfacesRepository.pin('b');
    assert.equal(surfacesRepository.readPinned()?.sessionId, 'b');
    assert.equal(surfacesRepository.read('a')?.pinned, false, 'pinning b released a');
  });

  it('keeps the pin when the panel behind it is rewritten', () => {
    // Redrawing is the agent's; pinning is the user's. A monitor that updates
    // itself must not quietly stop following the person who asked it to.
    surfacesRepository.write('b', panel('Other, updated', 2));
    assert.equal(surfacesRepository.readPinned()?.sessionId, 'b');
  });

  it('unpins without removing', () => {
    surfacesRepository.unpin('b');
    assert.equal(surfacesRepository.readPinned(), null);
    assert.ok(surfacesRepository.read('b'));
  });

  it('drops panels whose conversation is gone', () => {
    // A conversation can also disappear outside this app entirely, by being
    // removed from the transcripts this app treats as read-only — so this is a
    // sweep at startup rather than something hung off a delete.
    getConnection().prepare('DELETE FROM sessions WHERE id = ?').run('b');

    assert.equal(surfacesRepository.prune(), 1);
    assert.equal(surfacesRepository.read('b'), null);
    assert.ok(surfacesRepository.read('a'), 'the surviving conversation kept its panel');
  });

  it('lists what is left, newest first', () => {
    const listed = surfacesRepository.list();
    assert.deepEqual(listed.map((entry) => entry.sessionId), ['a']);
  });
});
