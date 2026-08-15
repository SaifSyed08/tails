/**
 * The Codex spritesheet layout.
 *
 * ## This is documentation, not inference
 *
 * Everything here was read out of codex-pets.net's own JavaScript bundle
 * (`/assets/index-*.js`) and then checked against the two sheets on this
 * machine. It replaces the alpha-scanning this module used to do: those scans
 * were rediscovering a published convention one pixel at a time, and they
 * could only ever answer "which cells have paint in them", never "what is this
 * row *for*".
 *
 * Their constants: `Ce=192, Se=208, Cr=8, ef={1:9,2:11}` — a 192x208 cell, 8
 * columns, and 9 or 11 rows depending on `spriteVersionNumber`.
 *
 * ## The two selectors, which are not the same
 *
 * The bundle defines `Wd(version)` and `Ra(version)`. Both return the same
 * eleven rows for v2, but `Ra` overrides row 0 to **7** frames — the extra one
 * is labelled "Neutral look" — while `Wd` leaves it at 6.
 *
 * - `Ra` drives the **spritesheet**, so playback of a v2 sheet uses a 7-frame
 *   idle. Confirmed independently: an alpha scan of `sonic-art` (v2) finds
 *   exactly 7 cells with paint in row 0, and of `sonic` (v1) exactly 6.
 * - `Wd` drives the **filmstrip preview**, so the strip is 73 frames for v2 and
 *   57 for v1. Confirmed by measuring the real images: v1 previews are
 *   5472x104 (57 x 96px) and v2 previews are 7008x104 (73 x 96px).
 *
 * Getting those the wrong way round is a one-frame error in one direction and a
 * whole-row error in the other, so they are kept as two explicit exports.
 */

/** The cell, in source pixels. */
export const CODEX_CELL = { width: 192, height: 208 } as const;

/** Every Codex sheet is eight cells wide. */
export const CODEX_COLUMNS = 8;

/** Rows by `spriteVersionNumber`. A sheet that matches neither is not a Codex sheet. */
export const CODEX_ROWS_BY_VERSION: Record<number, number> = { 1: 9, 2: 11 };

/**
 * Milliseconds per frame, from their player: `duration = max(frames * 260, 1400)`.
 *
 * Adopted so a pet moves here at the speed its author saw. It is much slower
 * than the 8fps this module used to assume, which is why the pets read as
 * frantic before.
 */
export const CODEX_FRAME_MS = 260;

/** The frame rate that follows from it. */
export const CODEX_FPS = 1000 / CODEX_FRAME_MS;

export type CodexStateRow = {
  /** The state's canonical id, as the catalogue names it. */
  name: string;
  /** Row index into the sheet. */
  row: number;
  /** How many of the row's eight cells are used. */
  frames: number;
};

/** The nine rows every Codex sheet has, verbatim from the bundle. */
const BASE_ROWS: readonly CodexStateRow[] = [
  { name: 'idle', row: 0, frames: 6 },
  { name: 'running-right', row: 1, frames: 8 },
  { name: 'running-left', row: 2, frames: 8 },
  { name: 'waving', row: 3, frames: 4 },
  { name: 'jumping', row: 4, frames: 5 },
  { name: 'failed', row: 5, frames: 8 },
  { name: 'waiting', row: 6, frames: 6 },
  { name: 'running', row: 7, frames: 6 },
  { name: 'review', row: 8, frames: 6 },
];

/** The two rows v2 adds. */
const VERSION_2_ROWS: readonly CodexStateRow[] = [
  { name: 'look-right-side', row: 9, frames: 8 },
  { name: 'look-left-side', row: 10, frames: 8 },
];

/** Every state name that can appear, in sheet order. */
export const CODEX_STATE_NAMES = [
  ...BASE_ROWS.map((state) => state.name),
  ...VERSION_2_ROWS.map((state) => state.name),
] as const;

export type CodexStateName = (typeof CODEX_STATE_NAMES)[number];

/**
 * The rows of a sheet, as its **spritesheet** is laid out (their `Ra`).
 *
 * v2's idle is seven frames here. That seventh cell is real artwork — the alpha
 * scan finds paint in it — so leaving it out is a visibly shorter idle, and
 * including it in v1 is the blank frame the pet used to disappear on.
 */
export function codexSheetRows(version: number | undefined): readonly CodexStateRow[] {
  if (version !== 2) return BASE_ROWS;
  return [...BASE_ROWS, ...VERSION_2_ROWS].map(
    (state) => (state.row === 0 ? { ...state, frames: 7 } : state),
  );
}

/**
 * The rows as the **filmstrip preview** is laid out (their `Wd`).
 *
 * Same rows, but v2's idle stays at six, which is why a v2 strip is 73 frames
 * and not 74.
 */
export function codexStripRows(version: number | undefined): readonly CodexStateRow[] {
  return version === 2 ? [...BASE_ROWS, ...VERSION_2_ROWS] : BASE_ROWS;
}

/** Total frames in the filmstrip: every row's used cells, concatenated in row order. */
export function codexStripFrameCount(version: number | undefined): number {
  return codexStripRows(version).reduce((total, state) => total + state.frames, 0);
}

/**
 * Where the idle loop sits inside the filmstrip.
 *
 * Row 0 comes first in the concatenation, so it is simply the opening frames —
 * which is the sub-range a preview should play. Playing the whole strip walks
 * through every other animation and, at 96px a frame, mostly reads as flicker.
 */
export function codexStripIdleFrames(version: number | undefined): number {
  return codexStripRows(version)[0].frames;
}

/**
 * Whether a grid is a Codex sheet at all.
 *
 * Both the cell size and the column count have to match, and the row count has
 * to be one of the two published shapes. Anything else is somebody's own
 * spritesheet and gets none of these assumptions.
 */
export function isCodexGrid(
  grid: { width: number; height: number; columns: number; rows: number },
): boolean {
  return grid.width === CODEX_CELL.width
    && grid.height === CODEX_CELL.height
    && grid.columns === CODEX_COLUMNS
    && Object.values(CODEX_ROWS_BY_VERSION).includes(grid.rows);
}

/**
 * The version a grid implies, when the manifest does not say.
 *
 * Row count is the only signal, and it is unambiguous for the two published
 * shapes: 9 rows is v1, 11 is v2.
 */
export function codexVersionFromGrid(
  grid: { columns: number; rows: number },
): number | undefined {
  for (const [version, rows] of Object.entries(CODEX_ROWS_BY_VERSION)) {
    if (grid.rows === rows && grid.columns === CODEX_COLUMNS) return Number(version);
  }
  return undefined;
}
