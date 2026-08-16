import assert from 'node:assert/strict';
import test from 'node:test';

// Client code, reached by path: it imports only a type, and this is the repo's
// only test runner. Same arrangement as `thinking-phrases.test.ts`.
import {
  advanceMotion,
  GRAVITY,
  MAX_STEP_S,
  WALK_SPEED,
  type Motion,
} from '../../../../src/components/petstage/pet-motion.js';

/**
 * The in-chat pet's physics.
 *
 * Worth testing because every failure here is silent: a fall that overshoots
 * leaves him under the composer, a fall that never terminates burns a frame
 * loop forever, and a settled pet whose state object is rebuilt every frame
 * re-renders sixty times a second while apparently doing nothing at all.
 */

const STANDING: Motion = {
  arrival: 'session:pet',
  x: 100,
  y: 0,
  vy: 0,
  target: null,
  facing: 'right',
  gesture: null,
  grow: 1,
  carried: false,
  squash: false,
};

/** Runs frames until the predicate holds, or gives up. Returns the frame count. */
function until(start: Motion, stop: (motion: Motion) => boolean, limit = 600): {
  motion: Motion;
  frames: number;
} {
  let motion = start;
  for (let frames = 1; frames <= limit; frames += 1) {
    motion = advanceMotion(motion, 1 / 60);
    if (stop(motion)) return { motion, frames };
  }
  return { motion, frames: limit };
}

test('a settled pet is left exactly as he was', () => {
  // Reference equality, not deep equality: the caller holds this in React state
  // and a new object every frame is a render every frame.
  assert.equal(advanceMotion(STANDING, 1 / 60), STANDING);
});

test('a carried pet ignores gravity entirely', () => {
  const held: Motion = { ...STANDING, y: -200, carried: true };
  assert.equal(advanceMotion(held, 1 / 60), held);
});

test('he falls to the floor and stops on it', () => {
  const dropped: Motion = { ...STANDING, y: -300 };
  const { motion, frames } = until(dropped, (next) => next.y === 0);

  assert.equal(motion.y, 0, 'lands exactly on the floor, never below it');
  assert.equal(motion.vy, 0);
  assert.ok(motion.squash, 'the landing is reported, for the squash');
  // Half a second at most: this is a pet being put down, not a lift descending.
  assert.ok(frames > 1 && frames < 40, `took ${frames} frames`);

  // And having landed, he is finished: nothing further changes.
  assert.equal(advanceMotion({ ...motion, squash: false }, 1 / 60).y, 0);
});

test('the fall accelerates', () => {
  const first = advanceMotion({ ...STANDING, y: -400 }, 1 / 60);
  const second = advanceMotion(first, 1 / 60);

  assert.ok(second.vy > first.vy, 'speed increases');
  assert.ok(second.y - first.y > first.y - (-400), 'so each frame covers more ground');
  assert.ok(Math.abs(first.vy - GRAVITY / 60) < 0.001);
});

test('a long gap between frames does not teleport him', () => {
  // A backgrounded tab hands back seconds, not milliseconds. Integrating that
  // in one step would put him through the floor and out the other side.
  const stalled = advanceMotion({ ...STANDING, y: -400 }, 5);
  assert.equal(stalled.vy, GRAVITY * MAX_STEP_S);
  assert.ok(stalled.y < 0, 'still in the air after one clamped frame');
});

test('walking arrives on the target, once, and then stops', () => {
  const walking: Motion = { ...STANDING, x: 0, target: 240 };
  const { motion } = until(walking, (next) => next.target === null);

  assert.equal(motion.x, 240, 'lands on the target rather than near it');
  assert.equal(motion.target, null);
  assert.equal(advanceMotion(motion, 1 / 60), motion, 'and is settled afterwards');
});

test('he faces the way he is walking', () => {
  assert.equal(advanceMotion({ ...STANDING, x: 300, target: 0 }, 1 / 60).facing, 'left');
  assert.equal(advanceMotion({ ...STANDING, x: 0, target: 300 }, 1 / 60).facing, 'right');

  const step = advanceMotion({ ...STANDING, x: 0, target: 300 }, 1 / 60);
  assert.ok(Math.abs(step.x - WALK_SPEED / 60) < 0.001);
});

test('falling suspends the walk rather than cancelling it', () => {
  // Picked up mid-stroll and let go again: he should carry on to where he was
  // going, from wherever he lands.
  const interrupted: Motion = { ...STANDING, x: 0, y: -120, target: 300 };
  const { motion } = until(interrupted, (next) => next.y === 0);

  assert.equal(motion.x, 0, 'no horizontal travel while in the air');
  assert.equal(motion.target, 300, 'and the journey is still his');
});

test('a pet dropped in grows to full size, and only once', () => {
  const arriving: Motion = { ...STANDING, grow: 0 };
  const { motion, frames } = until(arriving, (next) => next.grow === 1);

  assert.equal(motion.grow, 1);
  assert.ok(frames < 30, `took ${frames} frames`);
  assert.equal(advanceMotion(motion, 1 / 60), motion);
});
