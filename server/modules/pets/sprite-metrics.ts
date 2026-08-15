import type { FrameGrid } from '@/modules/pets/pet-spec.js';

/**
 * Reading image dimensions and guessing a frame grid from them.
 *
 * ## What we actually know about the Codex sheet format
 *
 * Nothing is documented, so this was measured. Both installed pets were
 * decoded and their alpha channel scanned for fully transparent gutters:
 *
 * | pet        | spriteVersionNumber | sheet      | cell pitch | grid  |
 * |------------|---------------------|------------|------------|-------|
 * | `sonic`    | absent              | 1536x1872  | 192 x 208  | 8x9   |
 * | `sonic-art`| 2                   | 1536x2288  | 192 x 208  | 8x11  |
 *
 * The transparent gutters fall exactly on multiples of 192 across and 208 down
 * in both files, so the cell size is certain for these two sheets. What is
 * *not* certain, and cannot be settled from two samples:
 *
 * - whether 192x208 is a format constant or just what this artist used;
 * - what `spriteVersionNumber` means. It correlates with row count here (v2 has
 *   two extra rows) but the cell size is identical, so branching on it would be
 *   inventing a rule from a single pair of files. We record it and ignore it.
 * - which row is which animation. Rows are clearly one animation each and have
 *   ragged lengths (a row may use 4 of its 8 cells), but nothing names them.
 *
 * Hence: infer, label the inference, and let the user correct it.
 */

/** The cell pitch measured in both installed Codex sheets. */
export const CODEX_SPRITE_CELL = { width: 192, height: 208 } as const;

/** Frames per second used when nothing better is known. */
export const DEFAULT_SPRITE_FPS = 8;

export type ImageSize = {
  width: number;
  height: number;
  format: 'webp' | 'png' | 'gif';
};

/**
 * How a grid was arrived at, so the UI can be honest about it.
 *
 * `authored` means the file or the user said so and nothing was guessed;
 * everything else is this module's opinion and should be presented as such.
 */
export type GridBasis = 'authored' | 'codex-cell-pitch' | 'square-cells' | 'single-frame';

export type GridInference = { grid: FrameGrid; basis: GridBasis };

const asciiAt = (bytes: Buffer, offset: number, length: number): string =>
  bytes.length >= offset + length ? bytes.toString('ascii', offset, offset + length) : '';

/**
 * Reads WebP canvas dimensions out of the RIFF container.
 *
 * WebP stores the size three different ways depending on the encoder — lossy
 * (`VP8 `), lossless (`VP8L`), and extended/animated (`VP8X`) — and the pets on
 * disk happen to use the lossless form. Handling all three costs a few lines
 * and avoids a "works for my two files" parser.
 */
function readWebpSize(bytes: Buffer): ImageSize | null {
  if (asciiAt(bytes, 0, 4) !== 'RIFF' || asciiAt(bytes, 8, 4) !== 'WEBP') return null;

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const fourcc = asciiAt(bytes, offset, 4);
    const length = bytes.readUInt32LE(offset + 4);
    const payload = offset + 8;

    if (fourcc === 'VP8X' && payload + 10 <= bytes.length) {
      return {
        width: bytes.readUIntLE(payload + 4, 3) + 1,
        height: bytes.readUIntLE(payload + 7, 3) + 1,
        format: 'webp',
      };
    }

    if (fourcc === 'VP8L' && payload + 5 <= bytes.length) {
      const packed = bytes.readUInt32LE(payload + 1);
      return {
        width: (packed & 0x3fff) + 1,
        height: ((packed >> 14) & 0x3fff) + 1,
        format: 'webp',
      };
    }

    if (fourcc === 'VP8 ' && payload + 10 <= bytes.length) {
      return {
        width: bytes.readUInt16LE(payload + 6) & 0x3fff,
        height: bytes.readUInt16LE(payload + 8) & 0x3fff,
        format: 'webp',
      };
    }

    // RIFF chunks are padded to an even length.
    offset = payload + length + (length % 2);
  }

  return null;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPngSize(bytes: Buffer): ImageSize | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_MAGIC)) return null;
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    format: 'png',
  };
}

function readGifSize(bytes: Buffer): ImageSize | null {
  if (bytes.length < 10 || asciiAt(bytes, 0, 3) !== 'GIF') return null;
  return {
    width: bytes.readUInt16LE(6),
    height: bytes.readUInt16LE(8),
    format: 'gif',
  };
}

/**
 * Reads image dimensions from a header, or null if the bytes are not an image
 * we recognise.
 *
 * Header-only by design: the caller passes the first few kilobytes of the file,
 * so listing twenty pets does not mean decoding forty megabytes of lossless
 * WebP. It also doubles as the import-time content check — a `.webp` whose
 * bytes are not a WebP fails here rather than at render time in the browser.
 */
export function readImageSize(bytes: Buffer): ImageSize | null {
  return readWebpSize(bytes) ?? readPngSize(bytes) ?? readGifSize(bytes);
}

/** Every cell size that divides both dimensions, largest first. */
function commonDivisors(width: number, height: number): number[] {
  const limit = Math.min(width, height);
  const found: number[] = [];
  for (let candidate = limit; candidate >= 8; candidate -= 1) {
    if (width % candidate === 0 && height % candidate === 0) found.push(candidate);
  }
  return found;
}

/**
 * Best-effort frame grid for a sheet of the given size.
 *
 * Three tiers, most-to-least confident, and the tier is returned alongside the
 * grid so the UI can say which one it used instead of presenting a guess as a
 * fact:
 *
 * 1. **Codex cell pitch** — the sheet divides evenly by the 192x208 pitch
 *    measured in the real files. Correct for every Codex pet seen so far.
 * 2. **Square cells** — the largest square that tiles the sheet into a
 *    plausible number of frames. The usual convention for hand-made sheets.
 * 3. **Single frame** — the whole image is one frame. Deliberately the
 *    fallback: a still pet is obviously un-animated, whereas a wrong grid looks
 *    like a rendering bug and sends the user hunting in the wrong place.
 */
export function inferFrameGrid(size: ImageSize): GridInference {
  const fps = DEFAULT_SPRITE_FPS;

  if (
    size.width % CODEX_SPRITE_CELL.width === 0
    && size.height % CODEX_SPRITE_CELL.height === 0
  ) {
    return {
      basis: 'codex-cell-pitch',
      grid: {
        width: CODEX_SPRITE_CELL.width,
        height: CODEX_SPRITE_CELL.height,
        columns: size.width / CODEX_SPRITE_CELL.width,
        rows: size.height / CODEX_SPRITE_CELL.height,
        fps,
      },
    };
  }

  for (const cell of commonDivisors(size.width, size.height)) {
    const columns = size.width / cell;
    const rows = size.height / cell;
    // More than one frame, but not so many that we have clearly found a
    // meaningless small divisor like 16.
    if (columns * rows < 2 || columns > 32 || rows > 32) continue;
    return { basis: 'square-cells', grid: { width: cell, height: cell, columns, rows, fps } };
  }

  return {
    basis: 'single-frame',
    grid: { width: size.width, height: size.height, columns: 1, rows: 1, fps },
  };
}

/** Content type for a sprite file, chosen from its extension. */
export function spriteContentType(fileName: string): string {
  if (/\.png$/i.test(fileName)) return 'image/png';
  if (/\.gif$/i.test(fileName)) return 'image/gif';
  if (/\.apng$/i.test(fileName)) return 'image/apng';
  return 'image/webp';
}
