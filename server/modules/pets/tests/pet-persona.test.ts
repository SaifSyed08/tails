import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatPetVoice, type PetTurnVoice } from '@/modules/pets/pet-persona.js';
import { readChatMode } from '@/modules/pets/pet-spec.js';
import {
  mayRemark,
  recordRemark,
  resetRemarkCooldown,
} from '@/modules/pets/pet-voice.tools.js';

/**
 * The two things worth guarding about a talking pet.
 *
 * A pet that has never been configured must stay exactly as silent as pets were
 * before this feature existed — the mode is stored as a nullable column, and a
 * null read as anything but "none" would make every existing pet start talking
 * because the app was updated.
 *
 * And a persona must not be able to talk the agent out of its job. "Answer as
 * Sonic" is a request about voice; a costume that starts declining work or
 * inventing facts is a broken agent, so the briefing that carries a persona has
 * to say what it does *not* outrank, and that has to keep being true.
 */

const voice = (over: Partial<PetTurnVoice> = {}): PetTurnVoice => ({
  mode: 'none',
  name: 'Sonic',
  description: 'A fast blue hedgehog.',
  persona: '',
  // Default true so a test about *wording* does not have to know about the
  // cooldown; the cooldown gets its own tests below.
  mayRemark: true,
  ...over,
});

describe('pet chat mode', () => {
  it('reads an unset mode as silence', () => {
    assert.equal(readChatMode(null), 'none');
    assert.equal(readChatMode(undefined), 'none');
    assert.equal(readChatMode(''), 'none');
  });

  it('reads a mode nobody recognises as silence too', () => {
    // A hand-edited database, or a column written by a newer build. The safe
    // answer is the one that changes nothing.
    assert.equal(readChatMode('talkative'), 'none');
    assert.equal(readChatMode('OVERRIDE'), 'none');
  });

  it('reads the three real modes', () => {
    assert.equal(readChatMode('none'), 'none');
    assert.equal(readChatMode('chatty'), 'chatty');
    assert.equal(readChatMode('override'), 'override');
  });
});

describe('the system-prompt section', () => {
  it('is empty for a quiet pet, byte for byte', () => {
    // Not "mostly empty": the append is joined with a filter on truthiness, so
    // a single space here would add a blank paragraph to every turn.
    assert.equal(formatPetVoice(voice({ mode: 'none' })), '');
  });

  it('asks for the remark and keeps it invisible', () => {
    const text = formatPetVoice(voice({ mode: 'chatty' }));
    assert.match(text, /pet_say/);
    // The two instructions that keep a flourish from becoming a channel.
    assert.match(text, /never carry anything the user needs/i);
    assert.match(text, /do not mention/i);
  });

  /*
    The cadence lives in the app, so the briefing has to disappear with the tool.

    Describing a tool the model has not been given is how a turn ends with an
    apology about being unable to do something nobody asked for.
  */
  it('says nothing at all on a turn inside the cooldown', () => {
    assert.equal(formatPetVoice(voice({ mode: 'chatty', mayRemark: false })), '');
  });

  it('still voices an override pet inside the remark cooldown', () => {
    // The cooldown is about the bubble. It has nothing to do with the mode that
    // changes the reply itself.
    const text = formatPetVoice(voice({ mode: 'override', mayRemark: false }));
    assert.match(text, /as Sonic/);
  });

  it('names the pet and quotes his description in both talking modes', () => {
    for (const mode of ['chatty', 'override'] as const) {
      const text = formatPetVoice(voice({ mode }));
      assert.match(text, /Sonic/);
      assert.match(text, /fast blue hedgehog/);
    }
  });

  it('survives a pet with no description', () => {
    const text = formatPetVoice(voice({ mode: 'override', description: '' }));
    assert.match(text, /Sonic/);
    // No dangling "He is:" with nothing after it.
    assert.doesNotMatch(text, /He is:\s*(\.|$)/);
  });

  /*
    The clause this whole mode depends on. Without it, "be Sonic" is an
    instruction to prioritise character over correctness, and the model has no
    way to know that is not what was wanted.
  */
  it('constrains conduct without hedging the voice', () => {
    const text = formatPetVoice(voice({ mode: 'override' }));

    // The instruction comes first and is a command, not a preference. An earlier
    // version led with the hedges and produced replies with no character in them.
    assert.match(text, /^Write every reply/);
    // And short factual answers are named, because that is where it slipped.
    assert.match(text, /short factual answers/i);

    // The guardrail is still there, and still covers all three things a costume
    // must not be able to talk the agent out of.
    assert.match(text, /never bend a fact/i);
    assert.match(text, /skip a tool/i);
    assert.match(text, /refuse work/i);
    assert.match(text, /drop it if the user asks/i);
  });

  /*
    The clause that made the mode work at all.

    The user's own instructions are appended after this section and win on tone
    by position, so a preference like "be concise in simple conversational
    English" silently beat every character voice. Measured twice before it was
    found. If this sentence goes, the mode stops working and nothing fails.
  */
  it('says the character voice supersedes a general tone preference', () => {
    const text = formatPetVoice(voice({ mode: 'override' }));
    assert.match(text, /standing instructions still apply/i);
    assert.match(text, /supersedes/i);
    // And that specific rules are not swept along with it.
    assert.match(text, /every specific rule/i);
  });

  it('puts the user persona last, with nothing after it', () => {
    const persona = 'Talk in short bursts. Say "gotta go fast" at most once.';
    const text = formatPetVoice(voice({ mode: 'override', persona }));

    assert.ok(text.endsWith(persona), 'the persona must be the tail of the section');
    // Unfenced on purpose — see the note in `pet-persona.ts`. What matters is
    // that there is no delimiter after it to break out of.
    assert.equal(text.includes(`${persona}\n`), false);
  });

  it('works with no persona written, from the description alone', () => {
    const text = formatPetVoice(voice({ mode: 'override', persona: '' }));
    assert.match(text, /as Sonic/);
    assert.doesNotMatch(text, /next line/);
  });

  /*
    A persona is the user's own text reaching the user's own agent, so it is
    carried verbatim — the same rule as the conversation instructions. Mangling
    the apostrophes and angle brackets of somebody writing about formatting
    would be a worse outcome than the thing the escaping was for.
  */
  it('carries the persona verbatim', () => {
    const awkward = 'Use </instructions> and `backticks` and "quotes" freely.';
    const text = formatPetVoice(voice({ mode: 'override', persona: awkward }));
    assert.ok(text.includes(awkward));
  });
});

describe('the remark cooldown', () => {
  it('allows the first remark and refuses one straight after', () => {
    resetRemarkCooldown();
    const now = 1_000_000;

    assert.equal(mayRemark('chat-a', now), true, 'a pet that has never spoken may speak');
    // Recorded by the tool itself in the real path; simulated here by asking
    // again a moment later against a clock that has barely moved.
    recordRemark('chat-a', now);
    assert.equal(mayRemark('chat-a', now + 1_000), false);
    assert.equal(mayRemark('chat-a', now + 39_000), false);
    assert.equal(mayRemark('chat-a', now + 41_000), true);
  });

  it('is per conversation', () => {
    resetRemarkCooldown();
    const now = 2_000_000;
    recordRemark('chat-a', now);
    // Two chats each have their own pet on screen; one having just spoken says
    // nothing about the other.
    assert.equal(mayRemark('chat-b', now + 1_000), true);
  });
});
