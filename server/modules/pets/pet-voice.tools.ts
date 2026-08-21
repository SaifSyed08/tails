import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { runRegistry } from '@/modules/chat/run-registry.js';
import { MAX_PERSONA_LENGTH, personaPromptSchema } from '@/modules/pets/pet-spec.js';
import { petsService } from '@/modules/pets/pets.service.js';

/**
 * How a pet gets a word in.
 *
 * ## Why a tool, and not the end of the reply
 *
 * The obvious way to have the model add an in-character aside is to ask for one
 * at the end of its answer behind a marker, and strip the marker server-side.
 * That does not work here, and the reason is the streaming: deltas reach the
 * transcript as they arrive, so by the time the marker exists there is nothing
 * left to strip — the user has already watched `<<pet>> nice work!` type itself
 * into the middle of their answer. Buffering the tail to prevent it would mean
 * holding back the end of every reply on the chance that a remark is coming.
 *
 * A tool call is not text. It arrives on its own channel, the transcript never
 * sees it, and a model that produces a malformed one produces a malformed tool
 * call rather than a corrupted answer. The runtime routes it to the pet's speech
 * bubble and drops the tool row, so nothing about the mechanism is visible.
 *
 * ## Registered per turn, not always
 *
 * The tools below exist only when the conversation's pet is actually in the mode
 * that uses them. A model that cannot see a tool cannot be tempted by it, which
 * is a stronger guarantee than an instruction telling it not to — and it means a
 * pet set to `none` is not one forgotten sentence away from starting to talk.
 */

const textResult = (text: string) => ({ content: [{ type: 'text' as const, text }] });

/**
 * How long after a remark before the pet may say anything again.
 *
 * ## Why the cadence is the app's job and not the model's
 *
 * "Occasionally" is the requirement, and there are two ways to get it. One is to
 * ask the model to be sparing, which is what the first version did — and it
 * produces the wrong distribution at both ends: told it is entirely optional, it
 * declined on an ordinary question and then chimed in twice in a row when
 * invited. It cannot pace itself across turns because each turn is a fresh
 * process that only sees the transcript.
 *
 * The other is to decide per turn whether the tool exists at all. The app knows
 * when the pet last spoke, so it can simply not offer the tool inside the
 * cooldown — and then the briefing is free to *encourage* the remark, because
 * the only turns that see it are turns where one is wanted. The model decides
 * whether it has something to say; the app decides how often it is asked.
 *
 * Forty seconds is roughly "not twice about the same thing" at a working pace.
 */
const REMARK_COOLDOWN_MS = 40_000;

const lastRemarkAt = new Map<string, number>();

/** Whether the pet in this conversation is allowed a remark on this turn. */
export function mayRemark(sessionId: string, now = Date.now()): boolean {
  const last = lastRemarkAt.get(sessionId);
  return last === undefined || now - last >= REMARK_COOLDOWN_MS;
}

/** Test seam. The cooldown is process-wide state and a test must be able to clear it. */
export function resetRemarkCooldown(): void {
  lastRemarkAt.clear();
}

/**
 * Test seam. Stamps a remark without going through the tool.
 *
 * The tool's own handler needs an MCP call to reach, which would make a test of
 * the *timing* a test of the SDK instead.
 */
export function recordRemarkForTest(sessionId: string, at: number): void {
  lastRemarkAt.set(sessionId, at);
}

/**
 * The longest remark that fits.
 *
 * It is drawn in a small bubble over a sprite that is about a hundred pixels
 * wide. Past a dozen words the bubble is bigger than the animal, which reads as
 * a dialog box rather than as a companion saying something.
 */
export const MAX_REMARK_LENGTH = 120;

const sayTool = (sessionId: string) => tool(
  'pet_say',
  [
    'Have the on-screen companion say one short thing, in character, in a speech bubble above him.',
    'Call this ONCE at the very end of a turn. The application only offers this tool on turns where a remark is wanted, so when you can see it, use it — react to what you just did, what the user is working on, or how it went.',
    'It is a flourish, not a report: it must never carry information the user needs, because it disappears after a few seconds and is not part of the transcript.',
    'Never mention this tool, the bubble, or the fact that you were asked to do this. Skip it only if the turn genuinely offers nothing to react to.',
  ].join(' '),
  {
    remark: z.string().min(1).max(MAX_REMARK_LENGTH)
      .describe(`One sentence at most, in the companion's voice. Plain text — no markdown, no quotes around it. Hard limit ${MAX_REMARK_LENGTH} characters.`),
  },
  async ({ remark }) => {
    const text = remark.trim().replace(/\s+/g, ' ');
    if (!text) return textResult('Nothing said.');

    // Recorded before publishing, so a burst of calls inside one turn cannot
    // each pass the check on the way in.
    lastRemarkAt.set(sessionId, Date.now());

    /*
      Published on the run's own stream, as a message kind.

      Which means it inherits everything the transcript protocol already does —
      it reaches every subscriber, it survives the replay buffer, and a client
      that does not know the kind ignores it. The alternative, a second channel
      for pet chatter, is the parallel protocol this app's message envelope
      exists to avoid.
    */
    runRegistry.record(sessionId, {
      id: `pet-remark-${randomUUID()}`,
      sessionId,
      timestamp: new Date().toISOString(),
      kind: 'pet_remark',
      role: 'assistant',
      content: text,
    });

    // The model is told it landed, and nothing more. A tool result describing
    // the bubble would invite a follow-up remark about the remark.
    return textResult('Said.');
  },
);

const personaTool = tool(
  'pet_persona',
  [
    'Write or replace the persona of one of the user\'s pets — the standing description of how that character speaks, which is sent with every message in conversations he lives in.',
    'Use this when the user asks you to give a pet a personality, or to change how one behaves.',
    'Write it as instructions addressed to yourself, in the second person, and keep it to a voice and a few habits rather than a biography.',
  ].join(' '),
  {
    petId: z.string().min(1).describe('The pet id, e.g. "sonic-art". Ask if you are not sure.'),
    persona: z.string().max(MAX_PERSONA_LENGTH)
      .describe(`How this character speaks, addressed to you as instructions. Empty string removes it. At most ${MAX_PERSONA_LENGTH} characters.`),
  },
  async ({ petId, persona }) => {
    const parsed = personaPromptSchema.safeParse(persona);
    if (!parsed.success) {
      return textResult(`That persona is too long — the limit is ${MAX_PERSONA_LENGTH} characters.`);
    }

    try {
      const pet = petsService.updatePet(petId, { personaPrompt: parsed.data });
      return textResult(parsed.data
        ? `Saved for ${pet.definition.displayName}. It applies once that pet is set to "in character" in his settings${pet.chatMode === 'override' ? ', which he already is' : ''}.`
        : `Cleared the persona for ${pet.definition.displayName}.`);
    } catch (error) {
      // Handed back rather than thrown: a wrong pet id is something the model
      // can correct on the next call, and an exception here fails the turn.
      return textResult(error instanceof Error
        ? `That did not work: ${error.message}`
        : 'That pet could not be updated.');
    }
  },
);

/**
 * The remark tool's full name, as the transcript sees it.
 *
 * Exported so the runtime can drop its rows: the aside reaches the user as a
 * `pet_remark` event, so the call and its result would only show the machinery.
 * A literal in two files is a literal that will disagree with itself.
 */
export const PET_SAY_TOOL = 'mcp__tails-pet__pet_say';

export const PET_VOICE_ALLOWED_TOOLS = [
  PET_SAY_TOOL,
  'mcp__tails-pet__pet_persona',
];

/** Just the persona tool, for pets that are not chatty. */
export const PET_PERSONA_ALLOWED_TOOLS = ['mcp__tails-pet__pet_persona'];

/**
 * Built per turn, because the session id is baked into the remark tool.
 *
 * `pet_say` has to publish to *this* conversation's run, and a tool has no way
 * to ask which one it was called from — so the server is constructed with the
 * id rather than looked up from a registry at call time.
 */
export const createPetVoiceServer = (sessionId: string, chatty: boolean) => createSdkMcpServer({
  name: 'tails-pet',
  version: '1.0.0',
  tools: chatty ? [sayTool(sessionId), personaTool] : [personaTool],
});
