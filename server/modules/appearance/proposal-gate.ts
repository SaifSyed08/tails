import { themeSpecV2Schema, type ThemeSpecV2 } from '@/modules/appearance/theme-spec.js';

/**
 * Whether a change is big enough that the user should see it before it happens.
 *
 * ## Why this is code and not a sentence in a tool description
 *
 * `theme_propose` shipped with the threshold written down in three places — the
 * tool description, the guide, and `/personalize` — as "structural change or
 * genuine ambiguity: propose two; colour, type, density or radius: just do it".
 * Then "make it look like Minecraft" went straight to `theme_apply`, which is
 * about as far into the first category as a request can get.
 *
 * Guidance that is ignored is not guidance, it is decoration, and this project
 * has now watched the same thing happen four times in a row with things that
 * existed but did nothing. So the threshold is evaluated rather than described.
 * The model still gets a sentence explaining it, but the sentence is now the
 * *error message*, which is the one piece of documentation that arrives at
 * exactly the moment it is relevant.
 *
 * ## What counts
 *
 * Structure, in the sense the surface vocabulary means it: fills, borders,
 * corners, shadows, backdrops, textures, ambient motion, the caret and pointer,
 * where the ramp is anchored, and whether the colour mode is pinned. Those are
 * the fields that make a look a *different look* rather than the same look in
 * another colour.
 *
 * Deliberately not counted: palette, typography, density and motion feel. A hue
 * rotation or a font swap is a refinement, and putting one behind a comparison
 * modal is its own kind of bad job — the failure mode on the other side, where
 * a system asks permission so often that the asking stops carrying information.
 *
 * ## What it is not
 *
 * Not an adversarial check. A model determined to skip the comparison can
 * propose two variants and apply one immediately, and that is fine: the point
 * is that the user *sees* the comparison, not that the model is prevented from
 * having opinions. This closes an oversight, not an attack.
 */

/**
 * `JSON.stringify` with keys sorted, recursively.
 *
 * Plain `stringify` compares insertion order, and zod does not produce a stable
 * one: a group filled in by a `.default(() => ({…}))` factory comes out in the
 * factory's literal order, while the same group re-parsed from an existing spec
 * comes out in the schema's declaration order. Identical specs, different
 * strings — so the gate fired on re-applying the very same look, which is the
 * most annoying possible false positive. Sorting is the whole fix and it is
 * cheap: these objects are small and this runs once per apply.
 */
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` members vanish under `JSON.stringify` and must vanish here
    // too, or an explicitly-absent optional compares differently to a missing
    // one.
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : 1));

  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${stable(member)}`).join(',')}}`;
}

/** The fields that make a look a different look rather than a recolour. */
const structure = (spec: ThemeSpecV2): string => stable({
  mode: spec.mode,
  surface: spec.surface,
  surfaces: spec.surfaces,
  interaction: spec.interaction,
});

/**
 * What "no theme at all" looks like structurally.
 *
 * A first apply is compared against this rather than being waved through:
 * arriving at the built-in floor and immediately applying a look with a full
 * `surfaces` map is the single most common shape of the request this gate
 * exists for, and treating "nothing to compare against" as "nothing changed"
 * would exempt exactly that case.
 */
const BARE = themeSpecV2Schema.parse({
  specVersion: 2,
  name: 'bare',
  summary: 'The structural baseline a first application is measured against.',
  mode: 'adaptive',
  palette: {
    surfaceHue: 0, surfaceChroma: 'neutral',
    accentHue: 0, accentChroma: 'muted',
    scheme: 'mono', statusHueShift: 0,
  },
  type: {
    sansFamily: 'system-sans', displayFamily: 'system-sans', monoFamily: 'mono',
    scale: 'default', displayWeight: 'medium', letterSpacing: 'normal',
    lineHeight: 'default', measure: 'default',
  },
  density: 'default',
  motion: 'standard',
});

export function isSubstantialChange(next: ThemeSpecV2, previous: ThemeSpecV2 | null): boolean {
  return structure(next) !== structure(previous ?? BARE);
}

/**
 * The message the model gets when it skips the step.
 *
 * Written as an instruction rather than a complaint, and it names the two
 * variants it wants, because the failure this addresses was not the model
 * refusing to propose — it was the model not registering that it should.
 */
export const PROPOSAL_REQUIRED = [
  'This is a structural change — it moves fills, shadows, borders, corners, backdrops, textures, ambient motion, the caret or pointer, where the ramp is anchored, or it pins the colour mode. Changes that large go past the user before they land, not after.',
  'Call mcp__tails-appearance__theme_propose first with two readings of the request — one bold, one restrained — then ask which they want with AskUserQuestion, then apply the winner. The miniatures render the real app chrome in each candidate, so the choice is made against something visible rather than against a description.',
  'This does not apply to refinements. A hue rotation, a font swap, a density or motion change applies straight through; only structure needs showing first.',
].join(' ');
