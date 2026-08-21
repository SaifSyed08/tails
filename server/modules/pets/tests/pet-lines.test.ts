import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { emptyBank, parseBank, pickKind, readBank } from '@/modules/pets/pet-lines.js';

/**
 * The bank has to survive whatever a small model sends back.
 *
 * Everything here is a shape that was actually observed, or one guarded because
 * its failure is invisible: a bank with a missing group is an index that returns
 * `undefined` a long way from the code that built it, and a line in a script the
 * bubble's font cannot draw is a row of empty boxes on screen.
 */

describe('parseBank', () => {
  it('reads a plain object', () => {
    const bank = parseBank('{"approve":["neat!"],"idle":["zzz"]}');
    assert.deepEqual(bank.approve, ['neat!']);
    assert.deepEqual(bank.idle, ['zzz']);
    // Absent groups are empty, never missing.
    assert.deepEqual(bank.problem, []);
  });

  it('reads it out of a fence or a sentence', () => {
    const bank = parseBank('Sure! ```json\n{"done":["boom"]}\n``` hope that helps');
    assert.deepEqual(bank.done, ['boom']);
  });

  it('is empty rather than thrown for nonsense', () => {
    assert.deepEqual(parseBank('not json at all'), emptyBank());
    assert.deepEqual(parseBank('{ broken'), emptyBank());
    assert.deepEqual(parseBank(''), emptyBank());
  });

  it('keeps a partial bank rather than discarding the call', () => {
    // Four keys out of five is a working pet, and the call cost half a minute.
    const bank = parseBank('{"approve":["a"],"done":["b"],"explain":["c"],"problem":["d"]}');
    assert.equal(bank.approve.length, 1);
    assert.equal(bank.idle.length, 0);
  });

  /*
    Observed: asked for duck noises, the generator offered 咕嘎. A good answer to
    the question, and unreadable in a pixel font.
  */
  it('drops a line the bubble cannot draw, keeping the rest', () => {
    const bank = parseBank('{"idle":["quack","\u5495\u560E","peep"]}');
    assert.deepEqual(bank.idle, ['quack', 'peep']);
  });

  it('keeps accented Latin', () => {
    assert.deepEqual(parseBank('{"idle":["café time"]}').idle, ['café time']);
  });

  it('drops a line too long for the bubble', () => {
    const long = 'x'.repeat(200);
    assert.deepEqual(parseBank(`{"idle":["ok","${long}"]}`).idle, ['ok']);
  });

  it('ignores a group that is not an array', () => {
    assert.deepEqual(parseBank('{"idle":"zzz"}').idle, []);
  });
});

describe('readBank', () => {
  it('normalises anything into the full shape', () => {
    assert.deepEqual(readBank(null), emptyBank());
    assert.deepEqual(readBank('nope'), emptyBank());
    // An unknown key from a newer or hand-edited payload is dropped rather than
    // carried into code that does not expect it.
    const bank = readBank({ idle: ['zzz'], nonsense: ['x'] });
    assert.deepEqual(Object.keys(bank).sort(), ['approve', 'done', 'explain', 'idle', 'problem']);
    assert.deepEqual(bank.idle, ['zzz']);
  });

  it('trims and drops blanks, which is what an edited textarea produces', () => {
    assert.deepEqual(readBank({ idle: ['  a  ', '', '   '] }).idle, ['a']);
  });
});

describe('pickKind', () => {
  it('reads a request off the user, not the reply', () => {
    // The "neat idea!" case: the pet reacts to being asked, before anything has
    // happened, so the signal has to be the user's own words.
    assert.equal(pickKind('add a retry loop', 'I will add that.'), 'approve');
    assert.equal(pickKind('can you fix the parser', 'Sure.'), 'approve');
  });

  it('puts a problem ahead of everything else', () => {
    // A turn can be several of these at once; the most specific true thing is
    // the most interesting one to react to.
    assert.equal(pickKind('add a retry loop', 'That failed with an error.'), 'problem');
  });

  it('notices something getting done', () => {
    assert.equal(pickKind('what about the tests', 'All 464 are passing now.'), 'done');
  });

  it('falls back to having been told something', () => {
    assert.equal(pickKind('what is a semaphore', 'It is a counter that limits access.'), 'explain');
  });
});
