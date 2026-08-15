/**
 * When the composer's ghost text stops being an offer.
 *
 * A prompt suggestion answers exactly one turn. Typing is only one of the ways
 * the next turn begins — answering a question, approving a plan, granting a
 * permission, or another window sending all resume the conversation without
 * this client calling `sendMessage` — so the rule has to be about the
 * conversation moving, not about the composer being used.
 *
 * Clearing on send alone is what let one suggestion sit in the composer
 * through an entire `/personalize` flow, which reads as the app only ever
 * having produced a single suggestion.
 *
 * Import-free so the repo's test runner can execute it directly.
 */

/** Event kinds that mean the model is working on something new. */
const TURN_ACTIVITY_KINDS = new Set([
  'text',
  'thinking',
  'tool_use',
  'tool_result',
  'stream_delta',
  'permission_request',
  'question_request',
  'plan_request',
]);

/**
 * Whether this event means the standing suggestion has been overtaken.
 *
 * `complete` is deliberately not activity: the suggestion for a turn arrives
 * *after* that turn's `complete`, so treating it as the start of something new
 * would discard every suggestion the moment before it appeared.
 */
export function endsSuggestion(kind: string): boolean {
  return TURN_ACTIVITY_KINDS.has(kind);
}
