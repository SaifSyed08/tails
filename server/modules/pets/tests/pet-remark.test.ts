import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { composeRemark, relevance, remarkDue } from '@/modules/pets/pet-remark.js';

/**
 * The app's own remark, which exists because the model's is unreliable.
 *
 * Two properties matter. A pet with nothing authored in his voice must stay
 * silent rather than say something generic — a companion speaking in nobody's
 * voice is the failure this feature is trying to avoid. And the choice has to be
 * a function of its inputs, so the roll is passed in: `Math.random()` inside
 * would make every test here either flaky or vacuous.
 */

const SONIC = [
  'collecting rings...',
  'gotta go fast!',
  'pondering at the speed of sound...',
  'waiting for the chaos emeralds to load...',
];

describe('relevance', () => {
  it('scores a shared distinctive word', () => {
    assert.ok(relevance('collecting rings...', 'how do I collect rings in this game') > 0);
  });

  it('ignores words too common to mean anything', () => {
    // Every sentence shares "the" and "is"; matching on them would make every
    // phrase equally relevant, which is the same as no relevance at all.
    assert.equal(relevance('the is a of', 'the thing is a kind of thing'), 0);
  });

  it('is zero against a message with nothing in it', () => {
    assert.equal(relevance('gotta go fast!', ''), 0);
    assert.equal(relevance('gotta go fast!', 'is it the a of'), 0);
  });
});

describe('composeRemark', () => {
  it('says nothing for a pet with no phrases', () => {
    assert.equal(composeRemark({ phrases: [], message: 'anything', roll: 0.5 }), null);
    assert.equal(composeRemark({ phrases: ['  ', ''], message: 'anything', roll: 0.5 }), null);
  });

  it('prefers a phrase that shares a word with the request', () => {
    const picked = composeRemark({
      phrases: SONIC,
      message: 'how fast can this loop go',
      roll: 0,
    });
    assert.equal(picked, 'gotta go fast!');
  });

  it('falls back to the roll when nothing is relevant', () => {
    const message = 'explain postgres indexes';
    assert.equal(composeRemark({ phrases: SONIC, message, roll: 0 }), SONIC[0]);
    assert.equal(composeRemark({ phrases: SONIC, message, roll: 0.99 }), SONIC[3]);
  });

  it('never runs off the end of the list', () => {
    // `Math.random()` can return values that floor to the length on short lists
    // once multiplied; the clamp is what stops this returning undefined.
    assert.equal(composeRemark({ phrases: ['only one'], message: 'x', roll: 0.999999 }), 'only one');
  });

  it('trims the phrase it returns', () => {
    assert.equal(composeRemark({ phrases: ['  spaced  '], message: 'x', roll: 0 }), 'spaced');
  });
});

describe('the odds', () => {
  it('is a flourish, not a certainty', () => {
    assert.equal(remarkDue(0), true);
    assert.equal(remarkDue(0.69), true);
    assert.equal(remarkDue(0.7), false);
    assert.equal(remarkDue(0.99), false);
  });
});
