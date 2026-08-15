import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CODEX_SPRITE_CELL, inferFrameGrid, readImageSize } from '@/modules/pets/sprite-metrics.js';
import { petDefinitionSchema, spritePathSchema } from '@/modules/pets/pet-spec.js';

/**
 * The parts of the pets module that can be wrong silently.
 *
 * Frame-grid inference and sprite path containment both fail invisibly: a bad
 * grid looks like a rendering glitch, and a path escape looks like nothing at
 * all. Everything else in the module fails loudly on its own.
 */

/** A minimal lossless WebP header, which is all `readImageSize` reads. */
function webpHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(22, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write('VP8L', 12, 'ascii');
  bytes.writeUInt32LE(10, 16);
  bytes.writeUInt8(0x2f, 20);
  // 14 bits of (width - 1), then 14 bits of (height - 1).
  bytes.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 21);
  return bytes;
}

test('reads WebP dimensions from the lossless header', () => {
  assert.deepEqual(readImageSize(webpHeader(1536, 2288)), {
    width: 1536,
    height: 2288,
    format: 'webp',
  });
});

test('reads PNG dimensions', () => {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(320, 16);
  bytes.writeUInt32BE(64, 20);
  assert.deepEqual(readImageSize(bytes), { width: 320, height: 64, format: 'png' });
});

test('rejects bytes that are not an image', () => {
  assert.equal(readImageSize(Buffer.from('not an image at all', 'utf8')), null);
});

/**
 * The two real sheets on disk, measured by scanning their alpha gutters. If
 * inference ever stops reproducing these, every installed pet renders wrong.
 */
test('infers the measured grid for both real Codex sheets', () => {
  const artwork = inferFrameGrid({ width: 1536, height: 2288, format: 'webp' });
  assert.equal(artwork.basis, 'codex-cell-pitch');
  assert.deepEqual(artwork.grid, {
    width: CODEX_SPRITE_CELL.width,
    height: CODEX_SPRITE_CELL.height,
    columns: 8,
    rows: 11,
    fps: 8,
  });

  const original = inferFrameGrid({ width: 1536, height: 1872, format: 'webp' });
  assert.equal(original.basis, 'codex-cell-pitch');
  assert.equal(original.grid.columns, 8);
  assert.equal(original.grid.rows, 9);
});

test('falls back to square cells, then to a single frame', () => {
  const square = inferFrameGrid({ width: 512, height: 512, format: 'png' });
  assert.equal(square.basis, 'square-cells');
  assert.equal(square.grid.width, square.grid.height);
  assert.ok(square.grid.columns * square.grid.rows >= 2);

  // A prime-sided sheet tiles into nothing sensible; one static frame is the
  // honest answer rather than an invented grid.
  const odd = inferFrameGrid({ width: 397, height: 101, format: 'png' });
  assert.equal(odd.basis, 'single-frame');
  assert.deepEqual([odd.grid.columns, odd.grid.rows], [1, 1]);
});

test('sprite paths that could escape the pet folder are rejected', () => {
  const hostile = [
    '../../../.ssh/id_rsa.png',
    '..\\..\\secrets.webp',
    '/etc/passwd.png',
    'C:\\Windows\\System32\\config\\sam.png',
    '\\\\server\\share\\evil.webp',
  ];

  for (const value of hostile) {
    assert.equal(spritePathSchema.safeParse(value).success, false, `should reject ${value}`);
  }

  assert.equal(spritePathSchema.safeParse('spritesheet.webp').success, true);
  assert.equal(spritePathSchema.safeParse('frames/idle.png').success, true);
  // Not an image extension, so not servable.
  assert.equal(spritePathSchema.safeParse('spritesheet.exe').success, false);
});

test('a definition needs a frame grid and an idle state', () => {
  const base = {
    id: 'sonic-art',
    displayName: 'Sonic',
    description: 'A speedy blue pixel-art hedgehog.',
    spritesheetPath: 'spritesheet.webp',
    frame: { width: 192, height: 208, columns: 8, rows: 11, fps: 8 },
    states: { idle: { start: 0, end: 7 } },
  };

  assert.equal(petDefinitionSchema.safeParse(base).success, true);
  assert.equal(petDefinitionSchema.safeParse({ ...base, frame: undefined }).success, false);
  assert.equal(petDefinitionSchema.safeParse({ ...base, states: {} }).success, false);
  // Strict: an unrecognised key is a typo, not something to swallow.
  assert.equal(petDefinitionSchema.safeParse({ ...base, framez: base.frame }).success, false);
});

/**
 * End-to-end discovery against a throwaway home, so the test never depends on
 * — or writes to — the developer's real `~/.codex` or `~/.tails`.
 */
test('discovers pets from both sources and refuses to delete Codex ones', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tails-pets-'));
  const codexDir = path.join(root, 'codex-pets');
  process.env.TAILS_HOME = path.join(root, 'tails-home');
  process.env.TAILS_CODEX_PETS_DIR = codexDir;

  fs.mkdirSync(path.join(codexDir, 'testpet'), { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, 'testpet', 'pet.json'),
    JSON.stringify({
      id: 'testpet',
      displayName: 'Test Pet',
      description: 'A fixture.',
      spritesheetPath: 'spritesheet.webp',
    }),
  );
  fs.writeFileSync(path.join(codexDir, 'testpet', 'spritesheet.webp'), webpHeader(1536, 416));

  // Imported after the env vars are set, because both directories are read at
  // module load.
  const { petsService } = await import('@/modules/pets/pets.service.js');
  const { closeConnection } = await import('@/db/connection.js');

  try {
    const library = petsService.listPets();
    const pet = library.pets.find((candidate) => candidate.definition.id === 'testpet');

    assert.ok(pet, 'the fixture pet should be discovered');
    assert.equal(pet.source, 'codex');
    assert.equal(pet.removable, false);
    assert.equal(pet.gridBasis, 'codex-cell-pitch');
    assert.deepEqual(
      [pet.definition.frame.columns, pet.definition.frame.rows],
      [8, 2],
    );
    assert.deepEqual(pet.definition.states.idle, { start: 0, end: 7 });

    assert.throws(() => petsService.removePet('testpet'), /will not delete it/);
    assert.throws(() => petsService.getPet('../../../etc'), /not installed/);

    petsService.setActivePet('testpet');
    assert.equal(petsService.listPets().activePetId, 'testpet');

    // A corrected grid must survive a rescan.
    petsService.updatePet('testpet', {
      frame: { width: 96, height: 104, columns: 16, rows: 4, fps: 12 },
    });
    const corrected = petsService.getPet('testpet');
    assert.equal(corrected.definition.frame.columns, 16);
    assert.equal(corrected.gridBasis, 'authored');
  } finally {
    closeConnection();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
