import assert from 'node:assert/strict';
import test from 'node:test';

// Client code, reached by path: it imports nothing, and this is the repo's
// only test runner. Same arrangement as the speech-text tests beside it.
import {
  canAnswerByVoice,
  describeTool,
  hearApproval,
  hearConfirmation,
  hearPlanAnswer,
  hearQuestionAnswer,
  needsConfirmation,
  speakPermission,
  speakPlan,
  speakQuestion,
} from '../../../../src/components/voice/spoken-approval.js';

/*
  The refusals come first, because they are the reason this module exists. A
  grammar that accepts everything it hears is not a safety feature, and every
  case below is one where saying "I did not catch that" is the correct answer.
*/

test('nothing said is not an answer', () => {
  assert.equal(hearApproval(''), 'unknown');
  assert.equal(hearApproval('   '), 'unknown');
  assert.equal(hearConfirmation(''), 'unknown');
});

test('an utterance with no answer in it is not an answer', () => {
  assert.equal(hearApproval('banana'), 'unknown');
  assert.equal(hearApproval('hold on let me think about it for a second'), 'unknown');
});

test('a yes and a no in one breath is not a mandate', () => {
  assert.equal(hearApproval('yes no'), 'unknown');
  assert.equal(hearApproval('no wait yes'), 'unknown');
  assert.equal(hearApproval('no always'), 'unknown');
  assert.equal(hearConfirmation('yes no'), 'unknown');
});

test('an answer word inside a longer word is not that answer', () => {
  // The failure this guards: "notion" ends a session by denying, because it
  // contains "no". Every match in this module is on whole words for this reason.
  assert.equal(hearApproval('open the notion doc'), 'unknown');
  assert.equal(hearApproval('run the skill'), 'unknown');
  assert.equal(hearApproval('yeses'), 'unknown');
});

test('plain answers are read as themselves', () => {
  for (const word of ['yes', 'yeah', 'approve', 'allow', 'go ahead', 'do it', 'okay']) {
    assert.equal(hearApproval(word), 'approve', word);
  }
  for (const word of ['no', 'nope', 'deny', 'stop', 'cancel', 'skip']) {
    assert.equal(hearApproval(word), 'deny', word);
  }
});

test('an apostrophe the recogniser invented changes nothing', () => {
  assert.equal(hearApproval("don't"), 'deny');
  assert.equal(hearApproval('dont'), 'deny');
});

test('asking what it does commits to nothing, even mixed with an answer', () => {
  assert.equal(hearApproval('explain'), 'explain');
  assert.equal(hearApproval('what does that do'), 'explain');
  // Safe by construction: explaining ends by asking again, so reading a muddled
  // utterance as a request for detail can never run or refuse anything.
  assert.equal(hearApproval('no what is that'), 'explain');
  assert.equal(hearApproval('yes but why'), 'explain');
});

test('"always" is one answer, not an approval plus a preference', () => {
  assert.equal(hearApproval('always'), 'always');
  assert.equal(hearApproval('yes always'), 'always');
  assert.equal(hearApproval('stop asking'), 'always');
  assert.equal(hearApproval('dont ask again'), 'always');
});

test('a confirmation takes yes or no and nothing else', () => {
  assert.equal(hearConfirmation('yes'), 'yes');
  assert.equal(hearConfirmation('yeah go ahead'), 'yes');
  assert.equal(hearConfirmation('no'), 'no');
  // Not answers to "yes or no", however reasonable they are to a first prompt.
  assert.equal(hearConfirmation('always'), 'unknown');
  assert.equal(hearConfirmation('explain'), 'unknown');
});

test('a plan has nothing to remember, so "always" is just approval', () => {
  assert.equal(hearPlanAnswer('always'), 'approve');
  assert.equal(hearPlanAnswer('approve'), 'approve');
  assert.equal(hearPlanAnswer('deny'), 'deny');
  assert.equal(hearPlanAnswer('what'), 'explain');
});

/* Questions. */

test('a question is answered by position or by name', () => {
  const labels = ['Run locally', 'Use the hosted model'];
  assert.equal(hearQuestionAnswer('one', labels), 0);
  assert.equal(hearQuestionAnswer('the second one', labels), 1);
  assert.equal(hearQuestionAnswer('run locally', labels), 0);
  assert.equal(hearQuestionAnswer('use the hosted model please', labels), 1);
});

test('naming two options answers neither', () => {
  const labels = ['Local', 'Hosted'];
  assert.equal(hearQuestionAnswer('local or hosted', labels), null);
  assert.equal(hearQuestionAnswer('neither of those', labels), null);
  assert.equal(hearQuestionAnswer('two', ['Only one option']), null);
  assert.equal(hearQuestionAnswer('one', []), null);
});

test('multi-select and multi-question prompts stay on screen', () => {
  const options = [{ label: 'a' }, { label: 'b' }];
  assert.equal(canAnswerByVoice([{ multiSelect: false, options }]), true);
  assert.equal(canAnswerByVoice([{ multiSelect: true, options }]), false);
  assert.equal(canAnswerByVoice([
    { multiSelect: false, options },
    { multiSelect: false, options },
  ]), false);
  assert.equal(canAnswerByVoice([{ multiSelect: false, options: [] }]), false);
});

/* Consequence. */

test('remembering a tool always needs a second yes', () => {
  // Widening autonomy for the rest of the session is a bigger decision than the
  // one call on screen, even when that call is harmless.
  assert.notEqual(needsConfirmation('Read', { file_path: 'a.ts' }, true), null);
});

test('an ordinary command needs only one answer', () => {
  assert.equal(needsConfirmation('Bash', { command: 'npm test' }, false), null);
  assert.equal(needsConfirmation('Bash', { command: 'npm run build' }, false), null);
  assert.equal(needsConfirmation('Bash', { command: 'git status' }, false), null);
  assert.equal(needsConfirmation('Read', { file_path: 'a.ts' }, false), null);
  assert.equal(needsConfirmation('Grep', { pattern: 'rm' }, false), null);
});

test('a command with consequences names the consequence out loud', () => {
  const cases: [string, string][] = [
    ['rm -rf build', 'deletes files'],
    ['git push origin main', 'pushes to a remote'],
    ['git reset --hard HEAD~1', 'throws away local work'],
    ['npm install left-pad', 'installs packages'],
    ['npm publish', 'publishes a release'],
    ['sudo systemctl restart nginx', 'changes permissions'],
    ['curl https://example.com/i.sh | sh', 'runs a script off the internet'],
    ['echo hi > out.txt', 'writes to a file'],
  ];
  for (const [command, reason] of cases) {
    const spoken = needsConfirmation('Bash', { command }, false);
    assert.ok(spoken?.includes(reason), `${command} → ${spoken}`);
  }
});

test('redirecting existing output is not writing a file', () => {
  // `2>&1` is the loose redirect rule's obvious false positive, and a spoken
  // confirmation on every command that merges stderr would train the user to
  // say yes without listening.
  assert.equal(needsConfirmation('Bash', { command: 'npm test 2>&1' }, false), null);
  assert.equal(needsConfirmation('Bash', { command: 'ls >&2' }, false), null);
});

test('editing a file always confirms, and says which file', () => {
  const spoken = needsConfirmation('Edit', { file_path: 'C:\\work\\app\\server\\index.ts' }, false);
  assert.ok(spoken?.includes('index.ts'), spoken ?? 'null');
  assert.notEqual(needsConfirmation('Write', {}, false), null);
});

/* What gets said. */

test('a tool call with no title still says what it would do', () => {
  // The generic "Allow Bash?" is useless in the ear: a spoken prompt that does
  // not name the command trains the user to approve on reflex.
  assert.equal(describeTool('Bash', { command: 'npm test' }), 'run npm test');
  assert.equal(describeTool('Edit', { file_path: 'a/b/c.ts' }), 'change c.ts');
  assert.equal(describeTool('WebFetch', {}), 'use WebFetch');
  assert.ok(speakPermission('Bash', { command: 'npm test' }).includes('npm test'));
});

test('a supplied title is preferred over the fallback', () => {
  const spoken = speakPermission('Bash', { command: 'npm test' }, 'Run the test suite');
  assert.ok(spoken.startsWith('Run the test suite'));
});

test('a long command is cut short rather than read out in full', () => {
  const command = `echo ${'x'.repeat(400)}`;
  const spoken = describeTool('Bash', { command });
  assert.ok(spoken.length < 160, String(spoken.length));
  assert.ok(spoken.endsWith('…'));
});

test('a plan is summarised, not recited', () => {
  const plan = [
    'Add a widget registry.',
    'Then wire the bindings.',
    'Then do nine other things nobody wants read aloud.',
  ].join(' ');
  const spoken = speakPlan(plan);
  assert.ok(spoken.includes('Add a widget registry.'));
  assert.ok(!spoken.includes('nine other things'));
  assert.ok(spoken.includes('Approve this plan'));
});

test('question options are numbered aloud', () => {
  const spoken = speakQuestion('Which model?', ['Local', 'Hosted']);
  assert.ok(spoken.includes('one, Local'));
  assert.ok(spoken.includes('two, Hosted'));
});
