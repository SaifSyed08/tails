import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { emptyBank, parseBank, readBank, remarkDue } from '@/modules/pets/pet-lines.js';

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
    assert.deepEqual(parseBank('{"idle":["zzz","hmm"]}').idle, ['zzz', 'hmm']);
  });

  it('ignores groups that no longer exist', () => {
    // Four reaction groups used to live here. A bank written by that build must
    // not resurrect them, and its idle lines are still worth keeping.
    const bank = parseBank('{"approve":["neat!"],"idle":["zzz"]}');
    assert.deepEqual(Object.keys(bank), ['idle']);
    assert.deepEqual(bank.idle, ['zzz']);
  });

  it('reads it out of a fence or a sentence', () => {
    const bank = parseBank('Sure! ```json\n{"idle":["boom"]}\n``` hope that helps');
    assert.deepEqual(bank.idle, ['boom']);
  });

  it('is empty rather than thrown for nonsense', () => {
    assert.deepEqual(parseBank('not json at all'), emptyBank());
    assert.deepEqual(parseBank('{ broken'), emptyBank());
    assert.deepEqual(parseBank(''), emptyBank());
  });

  it('is empty rather than broken when the one group is missing', () => {
    assert.deepEqual(parseBank('{"something":["a"]}'), emptyBank());
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
    assert.deepEqual(Object.keys(bank), ['idle']);
    assert.deepEqual(bank.idle, ['zzz']);
  });

  it('trims and drops blanks, which is what an edited textarea produces', () => {
    assert.deepEqual(readBank({ idle: ['  a  ', '', '   '] }).idle, ['a']);
  });
});

describe('the odds', () => {
  it('is a flourish, not a certainty', () => {
    // Also the cost control, now that a reaction is a model call.
    assert.equal(remarkDue(0), true);
    assert.equal(remarkDue(0.69), true);
    assert.equal(remarkDue(0.7), false);
  });
});
