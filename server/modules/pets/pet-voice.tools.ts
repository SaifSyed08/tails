import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { MAX_PERSONA_LENGTH, personaPromptSchema } from '@/modules/pets/pet-spec.js';
import { petsService } from '@/modules/pets/pets.service.js';

/**
 * How a pet gets a word in.
 *
 * ## What used to be here
 *
 * A `pet_say` tool, so the model could make the pet speak at the end of a turn.
 * The design was sound — a tool call is not text, so a half-formed aside could
 * never land in the middle of an answer the way a marker-in-the-reply scheme
 * would. It simply never fired: MCP tools are deferred in this CLI, so calling
 * one cost a `ToolSearch` round trip that the model reasonably skipped on a
 * routine turn, and three rounds of firmer wording did not move it.
 *
 * Reactions are generated outside the turn now — see `pet-reaction.ts` — which
 * is more reliable, reads better, and means a chatty pet costs the system prompt
 * nothing at all.
 *
 * The cooldown below outlived the tool, because it is about the *pet* rather
 * than about who produced the line.
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

/** Stamps a remark, whoever made it. The tool calls this; so does the fallback. */
export function recordRemark(sessionId: string, at = Date.now()): void {
  lastRemarkAt.set(sessionId, at);
}

/** Test seam. The cooldown is process-wide state and a test must be able to clear it. */
export function resetRemarkCooldown(): void {
  lastRemarkAt.clear();
}



/**
 * The longest remark that fits.
 *
 * It is drawn in a small bubble over a sprite that is about a hundred pixels
 * wide. Past a dozen words the bubble is bigger than the animal, which reads as
 * a dialog box rather than as a companion saying something.
 */
export const MAX_REMARK_LENGTH = 120;

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

export const PET_PERSONA_ALLOWED_TOOLS = ['mcp__tails-pet__pet_persona'];

/**
 * One tool: writing a pet a persona.
 *
 * There used to be a second — `pet_say`, which had the model call a tool at the
 * end of a chatty turn to make the pet speak. It worked and it almost never
 * fired: MCP tools are deferred in this CLI, so a remark cost the model a
 * `ToolSearch` round trip that it reasonably declined on a routine turn. The
 * reaction is generated outside the turn now (`pet-reaction.ts`), which also
 * means a chatty pet adds nothing at all to the system prompt.
 *
 * Still a factory rather than a constant, because `sessionId` is what a second
 * tool would need and the shape should not have to be rediscovered.
 */
export const createPetVoiceServer = (_sessionId: string) => createSdkMcpServer({
  name: 'tails-pet',
  version: '1.0.0',
  tools: [personaTool],
});
