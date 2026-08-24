import assert from 'node:assert/strict';
import test from 'node:test';

// Client code, reached by path: it imports only a type, and this is the repo's
// only test runner. Same arrangement as `thinking-phrases.test.ts`.
import {
  advanceMotion,
  BOUNCE,
  GRAVITY,
  MAX_STEP_S,
  REST_SPEED,
  WALK_SPEED,
  type Bounds,
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
  vx: 0,
};

/** A chat 400px across with 200px of headroom. */
const ROOM: Bounds = { maxX: 400, ceiling: -200 };

/** Runs frames until the predicate holds, or gives up. Returns the frame count. */
function until(
  start: Motion,
  stop: (motion: Motion) => boolean,
  limit = 600,
  bounds?: Bounds,
): { motion: Motion; frames: number } {
  let motion = start;
  for (let frames = 1; frames <= limit; frames += 1) {
    motion = advanceMotion(motion, 1 / 60, bounds);
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


/**
 * Throwing him.
 *
 * The rule the physics has to encode is that the chat is a *room*: a throw ends
 * against a wall, never outside. Leaving is something you do by carrying him
 * out, and if a hard enough throw could do it instead, the two gestures would
 * be the same gesture with a speed threshold between them.
 */

test('a throw is an arc, not a drop', () => {
  const thrown: Motion = { ...STANDING, x: 100, y: -50, vx: 300, vy: -200 };
  const first = advanceMotion(thrown, 1 / 60, ROOM);

  assert.ok(first.x > 100, 'he travels sideways');
  assert.ok(first.y < -50, 'and upwards, at first');
  assert.ok(first.vy > -200, 'while gravity takes the rise out of him');
});

test('he bounces off the walls rather than leaving the room', () => {
  const hurled: Motion = { ...STANDING, x: 380, y: -100, vx: 2000, vy: 0 };
  const { motion } = until(hurled, (next) => next.vx <= 0, 600, ROOM);

  assert.ok(motion.x <= ROOM.maxX, 'never past the wall');
  assert.ok(motion.vx < 0, 'and comes back off it');
  assert.ok(Math.abs(motion.vx) < 2000 * BOUNCE + 1, 'with less speed than it arrived with');
});

test('a throw at the left wall does the same thing', () => {
  const hurled: Motion = { ...STANDING, x: 20, y: -100, vx: -1500, vy: 0 };
  const { motion } = until(hurled, (next) => next.vx >= 0, 600, ROOM);

  assert.ok(motion.x >= 0);
  assert.ok(motion.vx > 0);
});

test('every throw ends with him standing still, inside the room', () => {
  for (const [vx, vy] of [[2400, -2400], [-2400, 0], [900, 1200], [40, -40]]) {
    let motion: Motion = { ...STANDING, x: 200, y: -80, vx, vy };
    for (let frame = 0; frame < 1200; frame += 1) motion = advanceMotion(motion, 1 / 60, ROOM);

    assert.equal(motion.vx, 0, `still moving after a throw of ${vx}, ${vy}`);
    assert.equal(motion.vy, 0);
    assert.equal(motion.y, 0, 'on the floor');
    assert.ok(motion.x >= 0 && motion.x <= ROOM.maxX, `left the room: ${motion.x}`);
  }
});

test('the ceiling is a wall too', () => {
  const upwards: Motion = { ...STANDING, x: 200, y: -190, vx: 0, vy: -2000 };
  const { motion } = until(upwards, (next) => next.vy > 0, 60, ROOM);

  assert.ok(motion.y >= ROOM.ceiling, 'never above the room');
});

test('a shiver is not a throw', () => {
  // Below the resting speed he is put down, not thrown: without this he creeps
  // sideways for a second after every release.
  const nudged: Motion = { ...STANDING, vx: REST_SPEED - 1 };
  assert.equal(advanceMotion(nudged, 1 / 60, ROOM).vx, 0);
});

test('he faces the way he was thrown', () => {
  assert.equal(advanceMotion({ ...STANDING, x: 200, vx: -600 }, 1 / 60, ROOM).facing, 'left');
  assert.equal(advanceMotion({ ...STANDING, x: 200, vx: 600 }, 1 / 60, ROOM).facing, 'right');
});

test('a throw cancels a walk', () => {
  const interrupted: Motion = { ...STANDING, x: 100, target: 300, vx: -500 };
  assert.equal(advanceMotion(interrupted, 1 / 60, ROOM).target, null);
});

/*
  Contact.

  `bumped` is the speed of an impact, reported for exactly one frame so a sound
  can be played from it. It used to be cleared inside the throw branch, so only
  the side walls could report one — the floor and the ceiling are reached by
  falling, and falling is not throwing. That is why a thrown pet thudded against
  the sidebar and landed in silence.
*/

test('landing reports the speed it landed at', () => {
  const falling: Motion = { ...STANDING, x: 200, y: -300, vy: 900 };
  const { motion } = until(falling, (next) => next.y === 0, 60, ROOM);

  assert.ok(motion.bumped !== undefined && motion.bumped > 0, 'the floor is a surface too');
});

test('a harder landing reports a bigger number', () => {
  // The whole point of carrying the speed rather than a boolean: every impact
  // sounding identical reads as a bug within about three bounces.
  const gentle = until({ ...STANDING, x: 200, y: -40, vy: 0 }, (n) => n.y === 0, 60, ROOM);
  const hard = until({ ...STANDING, x: 200, y: -300, vy: 1200 }, (n) => n.y === 0, 60, ROOM);

  assert.ok((hard.motion.bumped ?? 0) > (gentle.motion.bumped ?? 0));
});

test('hitting the ceiling reports it', () => {
  const upwards: Motion = { ...STANDING, x: 200, y: -190, vx: 0, vy: -2000 };
  const { motion } = until(upwards, (next) => next.y <= ROOM.ceiling, 60, ROOM);

  assert.ok(motion.bumped !== undefined && motion.bumped > 0);
});

test('contact lasts one frame, not for as long as he rests there', () => {
  // A pet sitting on the floor reporting contact on frame after frame is a
  // drum roll rather than a thud.
  const landed = until({ ...STANDING, x: 200, y: -200, vy: 600 }, (n) => n.y === 0, 60, ROOM);
  assert.ok((landed.motion.bumped ?? 0) > 0, 'the landing itself');

  const resting = advanceMotion(landed.motion, 1 / 60, ROOM);
  assert.equal(resting.bumped, 0, 'and nothing after it');
});

test('a walk is not an impact', () => {
  const strolling: Motion = { ...STANDING, x: 100, target: 300 };
  assert.equal(advanceMotion(strolling, 1 / 60, ROOM).bumped, 0);
});
