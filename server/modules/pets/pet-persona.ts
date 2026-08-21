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
};

const SILENT: PetTurnVoice = { mode: 'none', name: '', description: '', persona: '', mayRemark: false };

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
      name: pet.definition.displayName,
      description: pet.definition.description ?? '',
      persona: pet.personaPrompt ?? '',
      mayRemark: mode === 'chatty' && mayRemark(sessionId),
    };
  } catch {
    return SILENT;
  }
}

/**
 * The briefing for a pet who comments.
 *
 * Deliberately short. It is competing for attention with the Claude Code preset
 * and this app's own appearance briefing, and every extra sentence here is a
 * sentence of pressure toward doing the decorative thing.
 *
 * It *encourages* the remark rather than offering it, and that only became safe
 * once the cadence moved into the app: this briefing is only assembled on turns
 * where the cooldown has elapsed, so the turns that see it are exactly the turns
 * where a remark is wanted. The earlier version called it "entirely optional",
 * and the model duly declined on an ordinary question — the right answer to the
 * wrong question, because it was being asked to pace something it cannot see
 * across turns.
 */
function chattyBriefing(voice: PetTurnVoice): string {
  return [
    `The user has a companion on screen called ${voice.name}.`,
    voice.description ? `He is: ${voice.description}` : '',
    'Finishing this turn includes one more step: call mcp__tails-pet__pet_say with a short remark in his voice about what just happened. Do it after your reply, as the last thing you do.',
    // Named explicitly because MCP tools are deferred in this CLI: the model
    // holds the name and has to fetch the schema before it can call one. Left
    // unsaid, it reads the round trip as a cost to be avoided and quietly skips
    // the remark — which is what "chatty" not being chatty turned out to be.
    'That tool is deferred, so load it with ToolSearch first — that is expected and its cost is accounted for.',
    'It is decoration and must never carry anything the user needs to know. The application decides which turns get one and it has chosen this turn, so it is not a judgement call about whether a remark is warranted — it is.',
    'Do not mention the companion, the tool, or the bubble in your reply.',
  ].filter(Boolean).join(' ');
}

/**
 * The briefing for a pet who *is* the voice.
 *
 * ## Why this reads like the user's own instructions
 *
 * Because it is the same kind of thing, and the same trap: text appended to a
 * system prompt that already contains app-authored prose about MCP tools will be
 * read as one more clause of ours unless it introduces itself. So it says who is
 * speaking and, more importantly, **what it does not outrank** — a character
 * voice must not be able to talk the agent out of using a tool, or into being
 * less careful, or into refusing to answer plainly when asked to.
 *
 * That last clause is the whole reason this is safe to offer. "Answer as Sonic"
 * is a request about *voice*; a persona that started declining work or inventing
 * facts in character would be a broken agent wearing a costume.
 */
function overrideBriefing(voice: PetTurnVoice): string {
  const head = [
    `The user wants your replies in this conversation to be voiced by ${voice.name}, their on-screen companion.`,
    voice.description ? `He is: ${voice.description}` : '',
    'This governs voice only — wording, register, the odd aside in character.',
    'It does not change what you do or how carefully you do it: keep using your tools exactly as you otherwise would, stay accurate, never invent something because it suits the character, and drop the act entirely if the user asks a direct question about it or asks you to stop.',
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
  // Silent on a turn inside the cooldown: no tool, so nothing to brief.
  if (voice.mode === 'chatty') return voice.mayRemark ? chattyBriefing(voice) : '';
  if (voice.mode === 'override') return overrideBriefing(voice);
  return '';
}
