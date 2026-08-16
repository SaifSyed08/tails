import assert from 'node:assert/strict';
import test from 'node:test';

import type { ModelChoice } from '@/modules/chat/model.service.js';
import { readEffortLevel, resolveTurnSettings } from '@/modules/chat/turn-settings.js';

const CATALOGUE: ModelChoice[] = [
  { id: 'opus[1m]', displayName: 'Opus (1M context)', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'sonnet', displayName: 'Sonnet', effortLevels: ['low', 'medium', 'high'] },
  { id: 'haiku', displayName: 'Haiku', effortLevels: [] },
];

test('a model the account has is passed through', () => {
  const resolved = resolveTurnSettings({ model: 'sonnet', effort: 'medium' }, CATALOGUE);

  assert.deepEqual(resolved, { model: 'sonnet', effort: 'medium', problems: [] });
});

test('a model the account does not have is refused out loud', () => {
  const resolved = resolveTurnSettings({ model: 'opus-42' }, CATALOGUE);

  assert.equal(resolved.model, undefined, 'the turn runs on the default instead');
  assert.equal(resolved.problems.length, 1);
  assert.match(resolved.problems[0], /opus-42/, 'and says which model it was');
});

test('an effort the chosen model does not offer is refused out loud', () => {
  const resolved = resolveTurnSettings({ model: 'sonnet', effort: 'max' }, CATALOGUE);

  assert.equal(resolved.model, 'sonnet', 'the model still stands');
  assert.equal(resolved.effort, undefined);
  assert.match(resolved.problems[0], /Sonnet/, 'named, so the message means something');
});

test('a model with no effort control accepts no effort', () => {
  const resolved = resolveTurnSettings({ model: 'haiku', effort: 'high' }, CATALOGUE);

  assert.equal(resolved.effort, undefined);
  assert.equal(resolved.problems.length, 0, 'and does not scold: it simply has no such setting');
});

test('an unreadable catalogue does not block sending', () => {
  // Empty means "we could not read it", not "nothing is available". Refusing
  // every model on that basis would break sending for anyone whose catalogue
  // read failed.
  const resolved = resolveTurnSettings({ model: 'sonnet', effort: 'max' }, []);

  assert.deepEqual(resolved, { model: 'sonnet', effort: 'max', problems: [] });
});

test('choosing nothing stays nothing', () => {
  assert.deepEqual(resolveTurnSettings({}, CATALOGUE), { problems: [] });
});

test('only the levels the SDK defines are accepted off the wire', () => {
  assert.equal(readEffortLevel('xhigh'), 'xhigh');
  assert.equal(readEffortLevel('HIGH'), undefined, 'exact, since it goes straight to the SDK');
  assert.equal(readEffortLevel('extreme'), undefined);
  assert.equal(readEffortLevel(9), undefined);
  assert.equal(readEffortLevel(undefined), undefined);
});
