import { z } from 'zod';

import {
  CODEX_FPS,
  codexSheetRows,
  codexVersionFromGrid,
  isCodexGrid,
} from '@/modules/pets/codex-layout.js';

/**
 * The pet definition surface.
 *
 * Codex writes a deliberately minimal `pet.json` — id, displayName,
 * description, spritesheetPath, and sometimes `kind` / `spriteVersionNumber`.
 * Crucially it records **nothing about how the spritesheet is cut into
 * frames**. Every consumer of those files is therefore guessing, and a wrong
 * guess is not a subtle bug: the pet renders as a sliding collage.
 *
 * So this schema keeps the Codex fields verbatim and adds the frame grid as a
 * first-class, required, user-correctable field. The app never has to infer at
 * render time — inference happens once, at discovery, and whatever it produced
 * is visible and editable in the UI.
 */

/**
 * Ids double as directory names under `~/.tails/pets`.
 *
 * The character class alone rules out separators, drive letters and the `.` /
 * `..` traversal names (a leading dot is rejected), so an id can never address
 * anything outside the pets directory. The service still re-checks the
 * resolved path — this is the cheap first gate, not the only one.
 */
export const petIdSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, 'Use letters, digits, dots, dashes or underscores; must not start with a dot.');

/**
 * A sprite path relative to the pet's own directory.
 *
 * Absolute paths, UNC paths, drive letters and any `..` segment are rejected
 * here rather than sanitised. Sanitising a hostile path produces a path that
 * looks fine and points somewhere unexpected; rejecting it produces an error
 * the importer can read.
 */
export const spritePathSchema = z.string()
  .min(1)
  .max(200)
  .refine((value) => !/^([a-zA-Z]:|[\\/])/.test(value), 'Must be relative to the pet folder.')
  .refine(
    (value) => !value.split(/[\\/]/).includes('..'),
    'Must not contain ".." segments.',
  )
  .refine(
    (value) => /\.(webp|png|gif|apng)$/i.test(value),
    'Must point at a .webp, .png, .gif or .apng file.',
  );

/**
 * How the spritesheet is cut up.
 *
 * `width`/`height` are the cell size in source pixels; `columns`/`rows` are how
 * many cells the sheet holds. Frames are numbered row-major from 0.
 *
 * This is stored rather than derived on every read so that a user correction
 * survives, and so that the renderer's `steps()` animation and the importer's
 * inference can never disagree about the same sheet.
 */
export const frameGridSchema = z.object({
  width: z.number().int().min(1).max(4096)
    .describe('Cell width in source pixels.'),
  height: z.number().int().min(1).max(4096)
    .describe('Cell height in source pixels.'),
  columns: z.number().int().min(1).max(256)
    .describe('Cells per row across the sheet.'),
  rows: z.number().int().min(1).max(256)
    .describe('Rows of cells down the sheet.'),
  fps: z.number().min(0.5).max(60).default(8)
    .describe('Playback rate for animations that do not override it.'),
}).strict();

export type FrameGrid = z.infer<typeof frameGridSchema>;

/**
 * An inclusive run of frames, numbered row-major from 0.
 *
 * Inclusive rather than half-open because these are authored by hand in a UI
 * that shows "frames 0-7", and an off-by-one in an animation range is invisible
 * in code review and obvious on screen.
 */
export const frameRangeSchema = z.object({
  start: z.number().int().min(0).max(65535),
  end: z.number().int().min(0).max(65535),
  fps: z.number().min(0.5).max(60).optional()
    .describe('Overrides the grid fps for this state only.'),
}).strict().refine((range) => range.end >= range.start, {
  message: 'end must not be before start.',
  path: ['end'],
});

export type FrameRange = z.infer<typeof frameRangeSchema>;

/**
 * The animations the app knows how to ask for.
 *
 * Only `idle` is required: it is the one state that must always be renderable,
 * and a sheet whose other rows we cannot identify is still a usable pet. The
 * alternative — requiring all four and inventing three of them — would bake a
 * guess into the data file where nobody would ever question it again.
 */
/**
 * The animations a pet can have.
 *
 * The first eleven are the Codex convention, read from codex-pets.net's own
 * bundle and listed in `codex-layout.ts` — a sheet has nine of them, or eleven
 * for `spriteVersionNumber: 2`. They are the real vocabulary: a Codex sheet is
 * not "an idle row and some spare rows", it is a labelled set of animations,
 * and treating it as the former is why this app could only ever show one of
 * them.
 *
 * `walk`, `talk` and `sleep` are kept because earlier manifests could declare
 * them and because callers ask for them by name. They are aliases, resolved
 * against the real states at render time rather than stored — see
 * `resolveStateName` in the renderer.
 */
export const PET_STATE_NAMES = [
  'idle',
  'running-right',
  'running-left',
  'waving',
  'jumping',
  'failed',
  'waiting',
  'running',
  'review',
  'look-right-side',
  'look-left-side',
  'walk',
  'talk',
  'sleep',
] as const;

export type PetStateName = (typeof PET_STATE_NAMES)[number];

export const petStatesSchema = z.object(
  Object.fromEntries(
    PET_STATE_NAMES.map((name) => [
      name,
      name === 'idle' ? frameRangeSchema : frameRangeSchema.optional(),
    ]),
  ) as { idle: typeof frameRangeSchema } & Record<
    Exclude<PetStateName, 'idle'>,
    z.ZodOptional<typeof frameRangeSchema>
  >,
).strict();

export type PetStates = z.infer<typeof petStatesSchema>;

/**
 * A theme the pet brings with it.
 *
 * An opaque id: the appearance module owns what these mean, and this module
 * deliberately does not import it — a pet holding a theme reference must not
 * couple pets to theming. Presets come and go, so a stored id that no longer
 * resolves is treated as "no theme" by whoever applies it, never as an error.
 */
export const assignedThemeSchema = z.string().min(1).max(64);

/**
 * How many things a pet may say while thinking, and how long each may be.
 *
 * Capped because these are stored per pet and rendered in a small indicator: a
 * hundred phrases is not a personality, it is a payload, and a 500-character
 * "phrase" is a paragraph in a space built for four words.
 */
export const MAX_THINKING_PHRASES = 12;

export const thinkingPhrasesSchema = z.array(
  z.string().trim().min(1).max(80)
    .describe('Plain text. Rendered as text, never as markup.'),
).max(MAX_THINKING_PHRASES);

export type ThinkingPhrases = z.infer<typeof thinkingPhrasesSchema>;

/**
 * How much of a personality a pet is allowed to be.
 *
 * Three modes, and the gap between the second and third is the whole point:
 *
 * - **none** — a sprite. He walks, he reacts to being thrown, and he says
 *   nothing. What every pet was before this existed, and the default for every
 *   pet that has never been configured.
 *
 * - **chatty** — he *comments*. The model is given one tool and asked to call it
 *   at the end of a turn with a short in-character remark about what just
 *   happened. The remark goes in a bubble above the pet and never touches the
 *   reply: it is a tool call, not text, which is what makes it impossible for a
 *   half-formed aside to end up in the middle of an answer.
 *
 * - **override** — he *is* the voice. The pet's persona is appended to the
 *   system prompt for conversations he lives in, so the reply itself is in
 *   character. This is the one with teeth, and the reason it is a separate mode
 *   rather than a stronger setting of `chatty`: one decorates the answer and the
 *   other changes it.
 */
export const PET_CHAT_MODES = ['none', 'chatty', 'override'] as const;

export const petChatModeSchema = z.enum(PET_CHAT_MODES);

export type PetChatMode = (typeof PET_CHAT_MODES)[number];

/**
 * The persona is read as "none" until somebody chooses.
 *
 * A null mode has to mean silence rather than a default personality: pets
 * installed before this feature existed must behave exactly as they did, and a
 * pet that starts talking because the app was updated is a surprise nobody
 * asked for.
 */
export const readChatMode = (value: string | null | undefined): PetChatMode => {
  const parsed = petChatModeSchema.safeParse(value);
  return parsed.success ? parsed.data : 'none';
};

/**
 * How long a persona may be.
 *
 * Appended to the system prompt of every turn in the conversations this pet
 * lives in, so the same standing tax as the user's own instructions — see
 * `conversation-instructions.ts`. Shorter than that budget on purpose: a
 * character is a voice and a handful of habits, and anything approaching a page
 * is a second system prompt fighting the first.
 */
export const MAX_PERSONA_LENGTH = 700;

export const personaPromptSchema = z.string().trim().max(MAX_PERSONA_LENGTH);


/**
 * How a pet should sound, if speech is ever wired up.
 *
 * Carried now because it belongs to the pet, not to the speech engine: adding
 * it later would mean re-importing every pet to pick up a field the author
 * already knew at authoring time.
 */
export const petVoiceSchema = z.object({
  engine: z.enum(['none', 'system']).default('system'),
  name: z.string().max(80).optional()
    .describe('Platform voice name, e.g. a SpeechSynthesis voice.'),
  pitch: z.number().min(0).max(2).default(1),
  rate: z.number().min(0.1).max(3).default(1),
  /*
    A cloud voice, when the pet has been given one.

    Beside `name` rather than a third `engine` value, for the reason the field
    it mirrors on the app default gives: a pet whose cloud voice cannot be
    reached — no key, no quota — should fall back to the platform voice it was
    authored with, and an engine enum would have thrown that away. `engine:
    'none'` still outranks it, because silence is a choice rather than an empty
    field.
  */
  elevenVoiceId: z.string().max(80).optional()
    .describe('An ElevenLabs voice id. Used only when the user has a key; falls back to `name` otherwise.'),
}).strict();

export type PetVoice = z.infer<typeof petVoiceSchema>;

/**
 * The canonical, complete pet definition.
 *
 * Strict: an unknown key is a typo or a format we have not understood, and
 * either way silently dropping it is worse than saying so. On-disk files are
 * read through `petFileSchema` first, which is lenient by design.
 */
export const petDefinitionSchema = z.object({
  id: petIdSchema,
  displayName: z.string().min(1).max(80),
  description: z.string().max(500).default(''),

  /** Codex's own taxonomy field, preserved verbatim so a round-trip is lossless. */
  kind: z.string().max(40).optional(),

  /**
   * Who made the pet.
   *
   * Optional and never inferred. Codex's manifests do not carry it, so most
   * pets will have none — and a gallery that invents an author for them would
   * be attributing artwork to someone at random.
   */
  author: z.string().max(80).optional(),

  /**
   * Codex's sheet revision marker.
   *
   * Preserved but never interpreted — see `sprite-metrics.ts` for what the two
   * observed values actually correlate with.
   */
  spriteVersionNumber: z.number().int().min(0).max(9999).optional(),

  spritesheetPath: spritePathSchema,
  frame: frameGridSchema,
  states: petStatesSchema,

  personality: z.string().max(2000).optional()
    .describe('A prompt fragment describing how this pet behaves and talks.'),

  voice: petVoiceSchema.optional(),
}).strict();

export type PetDefinition = z.infer<typeof petDefinitionSchema>;

/**
 * What a `pet.json` on disk is allowed to look like.
 *
 * Lenient on purpose, and used for both sources: Codex's files omit everything
 * we added, and our own files carry all of it. Unknown keys are stripped rather
 * than rejected because `~/.codex/pets` belongs to another tool that is free to
 * add fields without asking us.
 */
export const petFileSchema = z.object({
  id: petIdSchema,
  displayName: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  kind: z.string().max(40).optional(),
  author: z.string().max(80).optional(),
  spriteVersionNumber: z.number().int().min(0).max(9999).optional(),
  spritesheetPath: spritePathSchema.optional(),
  frame: frameGridSchema.optional(),
  states: petStatesSchema.optional(),
  personality: z.string().max(2000).optional(),
  voice: petVoiceSchema.optional(),
});

export type PetFile = z.infer<typeof petFileSchema>;

/** The filename Codex uses, and the one we assume when a file omits the field. */
export const DEFAULT_SPRITESHEET_NAME = 'spritesheet.webp';

/** The manifest filename, identical in both sources. */
export const PET_MANIFEST_NAME = 'pet.json';

/**
 * Rejected rather than truncated: a sheet that large is a mistake or an attack,
 * and half of one is not a pet.
 */
export const MAX_SPRITE_BYTES = 8 * 1024 * 1024;

/**
 * The `states` for a sheet whose manifest does not declare any.
 *
 * Which is nearly all of them: neither the local Codex manifests nor the ones
 * inside catalogue downloads carry a `states` block, so this function was the
 * only thing deciding what a pet could do — and it used to answer "idle, the
 * whole of row 0". That was wrong twice over. Row 0 is six or seven frames,
 * not eight, so the extra cells were empty and the pet blinked; and the other
 * eight or ten rows are real, labelled animations that nothing could reach.
 *
 * For a sheet matching the published layout, every row is named. For anything
 * else the old conservative guess stands: one row, one state, and the frame
 * editor to correct it.
 */
export function buildDefaultStates(grid: FrameGrid, spriteVersionNumber?: number): PetStates {
  if (isCodexGrid(grid)) {
    const version = spriteVersionNumber ?? codexVersionFromGrid(grid);
    const states = {} as PetStates;

    for (const row of codexSheetRows(version)) {
      const start = row.row * grid.columns;
      states[row.name as PetStateName] = {
        start,
        end: start + row.frames - 1,
        fps: CODEX_FPS,
      };
    }

    return states;
  }

  return { idle: { start: 0, end: Math.max(0, grid.columns - 1) } };
}

/**
 * Checks that every state's frames exist in the grid.
 *
 * Separate from the schema because the schema validates a range and a grid
 * independently, and the interesting failure is the relationship between them:
 * a range that ran off the end of the sheet renders as blank cells, which reads
 * as "the pet is broken" rather than "the range is wrong".
 */
export function findOutOfRangeStates(
  grid: FrameGrid,
  states: PetStates,
): { path: string; message: string }[] {
  const lastFrame = grid.columns * grid.rows - 1;

  return PET_STATE_NAMES.flatMap((name) => {
    const range = states[name];
    if (!range || range.end <= lastFrame) return [];
    return [{
      path: `states.${name}.end`,
      message: `Frame ${range.end} is past the last frame (${lastFrame}) of this ${grid.columns}x${grid.rows} grid.`,
    }];
  });
}
