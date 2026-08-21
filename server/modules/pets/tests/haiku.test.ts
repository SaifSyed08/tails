import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { tidy } from '@/modules/pets/haiku.js';

/**
 * What a small model adds when asked for one line.
 *
 * Every case here was observed rather than imagined. None of them are failures
 * worth discarding an answer over, and all of them look wrong in a speech bubble
 * two inches wide.
 */
describe('tidy', () => {
  it('keeps a clean line alone', () => {
    assert.equal(tidy('Gotta go fast!'), 'Gotta go fast!');
  });

  it('drops wrapping quotes', () => {
    assert.equal(tidy('"neat idea!"'), 'neat idea!');
    assert.equal(tidy('“neat idea!”'), 'neat idea!');
  });

  it('drops a label the model gave itself', () => {
    assert.equal(tidy('Sonic: gotta go fast'), 'gotta go fast');
  });

  /*
    Observed: `*perks up and curls into a happy little ball* Ooh, changes`.
    Stripping the edge asterisks was worse than leaving them — it turned a
    recognisable stage direction into prose the pet appeared to be saying.
  */
  it('removes a stage direction as a span, not as edge characters', () => {
    assert.equal(tidy('*perks up happily* Ooh, changes!'), 'Ooh, changes!');
    assert.equal(tidy('Ooh! *wags tail*'), 'Ooh!');
  });

  it('takes the content line out of an over-helpful answer', () => {
    assert.equal(tidy('Sure! Here you go:\nGotta go fast!'), 'Gotta go fast!');
  });

  it('is empty for nothing', () => {
    assert.equal(tidy(''), '');
    assert.equal(tidy('   \n  '), '');
  });
});
