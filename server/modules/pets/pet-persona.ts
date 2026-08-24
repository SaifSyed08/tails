import { emptyBank, remarkDue, type LineBank } from '@/modules/pets/pet-lines.js';
import { mayRemark } from '@/modules/pets/pet-voice.tools.js';
import { readChatMode, type PetChatMode } from '@/modules/pets/pet-spec.js';
import { petsService } from '@/modules/pets/pets.service.js';

/**
 * What the pet in a conversation is allowed to do to it.
 *
 * Resolved per turn, in one place, because two different parts of the runtime
 * need the answer and they must not disagree: whether to register the remark
 * tool, and whether to append a persona to the system prompt. A pet who is
 * chatty in one of those and silent in the other is a model with a tool it has
 * been told not to use.
 */

export type PetTurnVoice = {
  mode: PetChatMode;
  /**
   * Which installed pet this is, when there is one.
   *
   * Everything else here is *character* — a name, a look, a persona — and the
   * briefing is built from that alone. The id is carried separately because
   * counters are about the pet rather than the character, and empty when the
   * conversation has no pet.
   */
  petId: string;
  /** The pet's own name, for the briefing. */
  name: string;
  /** The pet's description, which is the only characterisation most pets have. */
  description: string;
  /** The persona text, when there is one and the mode uses it. */
  persona: string;
  /**
   * Whether a remark is wanted on *this* turn.
   *
   * False inside the cooldown, and it gates the briefing as well as the tool:
   * telling the model about a tool it has not been given is how a turn ends with
   * an apology about being unable to do something nobody asked for.
   */
  mayRemark: boolean;
  /**
   * The pet's prebuilt lines.
   *
   * Only the idle group now: reactions are generated live from the actual
   * exchange, and a canned reaction read as canned. See `pet-lines.ts`.
   */
  lines: LineBank;
};

const SILENT: PetTurnVoice = {
  mode: 'none', petId: '', name: '', description: '', persona: '', mayRemark: false, lines: emptyBank(),
};

/**
 * Which pet is in this conversation, and in what mode.
 *
 * The *session's* pet, and the globally active one only as a fallback — the same
 * resolution the on-screen pet uses, so the character in the reply is the
 * character standing in the window. Reading a different pet here than the one
 * the user can see would be the strangest possible bug in this feature.
 *
 * Never throws. A pet that has been deleted mid-conversation, an unreadable
 * sprite directory, a pets table that has not been migrated: all of them mean
 * "no pet is talking", which is the behaviour of every conversation before this
 * existed.
 */
export function readPetVoice(sessionId: string): PetTurnVoice {
  try {
    const { pet } = petsService.resolveDisplayPet(null, sessionId);
    if (!pet) return SILENT;

    const mode = readChatMode(pet.chatMode);
    if (mode === 'none') return SILENT;

    return {
      mode,
      petId: pet.definition.id,
      name: pet.definition.displayName,
      description: pet.definition.description ?? '',
      persona: pet.personaPrompt ?? '',
      /*
        The dice are rolled here, once, and gate everything downstream — the
        tool, the briefing and the app's own fallback. Rolling them in three
        places would be three different answers to one question.
      */
      mayRemark: mode === 'chatty' && mayRemark(sessionId) && remarkDue(Math.random()),
      lines: pet.lines,
    };
  } catch {
    return SILENT;
  }
}

/*
  There is no briefing for a chatty pet, and that is the point.

  There used to be one, describing a `pet_say` tool the model could call at the
  end of a turn. Both are gone: the tool almost never fired (deferred tools cost
  a round trip the model declined) and reactions are generated outside the turn
  instead. So "chimes in" now costs the system prompt exactly nothing, which is
  a better place to be than a paragraph asking for a flourish.
*/

/**
 * The briefing for a pet who *is* the voice.
 *
 * ## Why this reads like the user's own instructions
 *
 * Because it is the same kind of thing, and the same trap: text appended to a
 * system prompt that already contains app-authored prose about MCP tools will be
 * read as one more clause of ours unless it introduces itself. So it says who is
 * speaking and **what it does not outrank** — a character voice must not be able
 * to talk the agent out of using a tool, into being less careful, or into
 * refusing work.
 *
 * That clause is the whole reason this is safe to offer. "Answer as Sonic" is a
 * request about *voice*; a persona that started declining work or inventing facts
 * in character would be a broken agent wearing a costume.
 *
 * It is one sentence, though, and that is deliberate — see the note inside. An
 * earlier version spent three clauses on the guardrail and produced replies with
 * no character in them at all.
 */
function overrideBriefing(voice: PetTurnVoice): string {
  /*
    Imperative first, hedges second, and that order was earned.

    The first version led with "the user wants your replies voiced by X" and then
    spent three clauses on what the persona does *not* change. Measured result:
    the briefing arrived in full, in the right conversation, and the reply came
    back barely in character at all — the guardrails were louder than the
    instruction. "This governs voice only" reads as a limit on the voice, and
    "drop the act entirely if…" primes dropping it.
    
    So the instruction is now a plain command, it says explicitly that short
    factual answers are included (that being exactly where the voice was getting
    dropped), and the guardrail is one sentence that constrains *conduct* without
    hedging the voice.
  */
  const head = [
    `Write every reply in this conversation as ${voice.name}, the user's on-screen companion — including short factual answers, which is where a voice usually slips.`,
    voice.description ? `He is: ${voice.description}` : '',
    'Accuracy and tool use are unaffected: never bend a fact, skip a tool, or refuse work for the sake of the voice, and drop it if the user asks you to.',
    /*
      And the one that actually decided it.

      The user's standing instructions are appended *after* this, deliberately —
      see `conversation-instructions.ts` — because tone is theirs to set. Which
      means a general preference like "be concise in simple conversational
      English" wins on position over any character voice, and that is precisely
      what it did: the briefing arrived intact and the reply came back in plain
      English, twice.

      Turning a pet to "in character" is the user choosing a register for this
      one conversation, so it has to be said out loud that it supersedes the
      general one. Their specific rules are untouched: a ban on a phrase or a
      punctuation mark is not a tone preference and the character has to obey it.
    */
    'Their standing instructions still apply in full, with one exception: where those describe a general tone — plain, concise, conversational — this character voice is the tone they have chosen for this conversation and supersedes it. Every specific rule they give (banned words or phrases, punctuation, formatting, length) still binds you, in character.',
  ].filter(Boolean).join(' ');

  if (!voice.persona) return head;

  /*
    The persona goes last and unfenced, for the same reason the user's own
    instructions do — see `conversation-instructions.ts`. There is no closing
    delimiter to break out of and nothing after it to be mistaken for, so the
    worst a stray backtick can do is look odd. Anything added to this append
    later belongs above this call.
  */
  return `${head} Everything from the next line to the end of this section is how the user described that character:\n\n${voice.persona}`;
}

/** The system-prompt section for this conversation's pet, or nothing. */
export function formatPetVoice(voice: PetTurnVoice): string {
  // Only the mode that changes the reply says anything to the model. A chatty
  // pet is handled entirely after the turn.
  if (voice.mode === 'override') return overrideBriefing(voice);
  return '';
}
