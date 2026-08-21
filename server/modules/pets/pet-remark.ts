/**
 * A remark the app can produce on its own.
 *
 * ## Why this exists at all
 *
 * The first design asked the model to call a tool at the end of a chatty turn.
 * It works — the bubble rendered, in character, transcript clean — and it fires
 * far too rarely to feel like a feature. Measured cause: MCP tools are
 * *deferred* in this CLI, so the model holds the tool's name and must spend a
 * `ToolSearch` round trip before it can call one. On a routine turn it
 * reasonably declines, and three rounds of stronger wording did not move it.
 *
 * Asking harder was the wrong lever. A flourish should not depend on the model
 * choosing to spend a round trip on a flourish. So the app decides whether a
 * remark happens and, when the model has not supplied one, says something
 * itself.
 *
 * ## Where the words come from
 *
 * The pet's own thinking phrases. They are already authored in his voice —
 * "collecting rings…", "pika pika.." — which is the thing that cannot be
 * synthesised offline, and they are already editable in the same panel as the
 * mode. Nothing is generated, nothing is fetched, and it cannot be wrong about
 * the character because the character's owner wrote the lines.
 *
 * The consequence, stated because it decides what the UI has to say: a pet with
 * no phrases has nothing to say. He then only speaks when the model supplies a
 * remark, which is the old behaviour. Inventing a generic line for him would be
 * worse than silence — a companion saying something bland in nobody's voice is
 * the failure this whole feature is trying to avoid.
 */

/** Words too common to mean anything when they match. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'is', 'are', 'was', 'were', 'be', 'been',
  'do', 'does', 'did', 'can', 'could', 'will', 'would', 'should', 'to', 'of', 'in', 'on', 'at',
  'for', 'with', 'from', 'by', 'as', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you',
  'me', 'my', 'your', 'we', 'us', 'our', 'they', 'them', 'what', 'which', 'who', 'how', 'why',
  'when', 'where', 'not', 'no', 'yes', 'so', 'just', 'up', 'out', 'about', 'into', 'than', 'too',
  'very', 'get', 'got', 'make', 'made', 'please', 'thanks',
]);

/** Words worth comparing, lowercased and de-duplicated. */
function terms(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word)),
  );
}

/**
 * How well a phrase matches what the user asked, from 0 to 1.
 *
 * Overlap of significant words over the phrase's own length, so a short phrase
 * that shares one distinctive word scores well and a long one needs more. This
 * is the cheap stand-in for the similarity idea: no embeddings, no model, no
 * network, and for the job — picking the least irrelevant of a dozen authored
 * lines — a word in common is most of the signal there is.
 */
export function relevance(phrase: string, message: string): number {
  const wanted = terms(message);
  if (wanted.size === 0) return 0;

  const words = [...terms(phrase)];
  if (words.length === 0) return 0;

  const shared = words.filter((word) => wanted.has(word)).length;
  return shared / words.length;
}

export type RemarkSource = {
  phrases: string[];
  /** The user's message, for the relevance pass. */
  message: string;
  /**
   * A number in [0, 1). Supplied by the caller so the choice is testable —
   * `Math.random()` inside here would make every test either flaky or
   * meaningless.
   */
  roll: number;
};

/**
 * Picks something for the pet to say, or nothing.
 *
 * A relevant line wins if there is one; otherwise it is whichever line the roll
 * lands on. The threshold is deliberately low — one shared word out of three is
 * enough — because the alternative to a loosely relevant remark is a random one,
 * not a better one.
 */
export function composeRemark(source: RemarkSource): string | null {
  const phrases = source.phrases.map((phrase) => phrase.trim()).filter(Boolean);
  if (phrases.length === 0) return null;

  const scored = phrases
    .map((phrase) => ({ phrase, score: relevance(phrase, source.message) }))
    .filter((entry) => entry.score >= 0.25)
    .sort((a, b) => b.score - a.score);

  if (scored.length > 0) return scored[0].phrase;

  const index = Math.min(phrases.length - 1, Math.floor(source.roll * phrases.length));
  return phrases[index];
}

/**
 * Whether a chatty pet speaks on this turn.
 *
 * Two gates, and they answer different questions. The cooldown stops him
 * commenting on every message in a fast exchange; the odds are what make it
 * "occasionally" rather than "always" once he is allowed to. Seventy percent was
 * asked for and is about right: often enough to read as a companion paying
 * attention, rare enough that the bubble is still a small event.
 */
export const REMARK_ODDS = 0.7;

export const remarkDue = (roll: number): boolean => roll < REMARK_ODDS;
