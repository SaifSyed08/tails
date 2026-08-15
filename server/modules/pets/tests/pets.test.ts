import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import { CODEX_SPRITE_CELL, inferFrameGrid, readImageSize } from '@/modules/pets/sprite-metrics.js';
import { petDefinitionSchema, spritePathSchema } from '@/modules/pets/pet-spec.js';
import { isSafeEntryName, listZipEntries, readZipEntry } from '@/modules/pets/zip.js';

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
 * The service, end to end, against a throwaway home — so no test depends on, or
 * writes to, the developer's real `~/.codex` or `~/.tails`.
 *
 * One test with subtests rather than several tests, because the service reads
 * both pet directories **at module load**: whichever test imports it first
 * decides where every later one looks. Sharing one fixture is the honest way to
 * express that, instead of writing tests that quietly pass only in file order.
 *
 * The fixture mirrors the real machine: two Codex pets that are different
 * folders with different artwork and the same display name, which is where the
 * "there are two Sonics" report came from.
 */
test('the pet library', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tails-pets-'));
  const codexDir = path.join(root, 'codex-pets');
  process.env.TAILS_HOME = path.join(root, 'tails-home');
  process.env.TAILS_CODEX_PETS_DIR = codexDir;

  const writePet = (id: string, displayName: string) => {
    fs.mkdirSync(path.join(codexDir, id), { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, id, 'pet.json'),
      JSON.stringify({ id, displayName, description: 'A fixture.', spritesheetPath: 'spritesheet.webp' }),
    );
    fs.writeFileSync(path.join(codexDir, id, 'spritesheet.webp'), webpHeader(1536, 416));
  };

  writePet('testpet', 'Test Pet');
  writePet('sonic', 'Sonic');
  writePet('sonic-art', 'Sonic');

  // Imported after the env vars are set, because both directories are read at
  // module load.
  const { petsService } = await import('@/modules/pets/pets.service.js');
  const { closeConnection } = await import('@/db/connection.js');

  try {
    await t.test('discovers pets from both sources and refuses to delete Codex ones', () => {
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
    });

    /**
     * Hiding exists because `~/.codex/pets` is another tool's directory: "I only
     * want one of these two Sonics" cannot mean deleting a file we did not
     * write, so it means leaving one out of our own listing.
     */
    await t.test('hides a Codex pet from the library without touching its files', () => {
      const both = petsService.listPets().pets.filter((pet) => pet.definition.displayName === 'Sonic');
      assert.equal(both.length, 2, 'both Sonic folders are real, separate pets');

      petsService.setActivePet('sonic');
      petsService.setPetHidden('sonic', true);

      const afterHiding = petsService.listPets();
      assert.deepEqual(
        afterHiding.pets.filter((pet) => pet.definition.displayName === 'Sonic')
          .map((pet) => pet.definition.id),
        ['sonic-art'],
      );
      assert.deepEqual(afterHiding.hidden.map((pet) => pet.definition.id), ['sonic']);
      // Hidden means "not in my library", so it cannot still be the pet on screen.
      assert.equal(afterHiding.activePetId, null);
      // And the files are exactly where Codex left them.
      assert.equal(fs.existsSync(path.join(codexDir, 'sonic', 'pet.json')), true);

      petsService.setPetHidden('sonic', false);
      assert.equal(petsService.listPets().hidden.length, 0, 'hiding is reversible');
    });

    await t.test('resolves which pet belongs on screen, dangling ids included', () => {
      petsService.setActivePet('testpet');

      assert.equal(petsService.resolveDisplayPet('sonic-art').pet?.definition.id, 'sonic-art');
      assert.equal(petsService.resolveDisplayPet('sonic-art').source, 'session');
      assert.equal(petsService.resolveDisplayPet(null).pet?.definition.id, 'testpet');
      assert.equal(petsService.resolveDisplayPet(null).source, 'global');

      // A conversation pointing at a pet that no longer exists falls back to the
      // global choice rather than throwing, and so does one pointing at a pet
      // the user has hidden.
      assert.equal(petsService.resolveDisplayPet('deleted-pet').pet?.definition.id, 'testpet');
      assert.equal(petsService.resolveDisplayPet('../../../etc/passwd').pet?.definition.id, 'testpet');
      petsService.setPetHidden('sonic-art', true);
      assert.equal(petsService.resolveDisplayPet('sonic-art').source, 'global');
      petsService.setPetHidden('sonic-art', false);

      assert.equal(petsService.findPet('deleted-pet'), null);
      assert.equal(petsService.findPet(null), null);

      petsService.setActivePet(null);
      assert.deepEqual(petsService.resolveDisplayPet(null), { pet: null, source: 'none' });
    });

    await t.test('names one representative frame, always inside the sheet', () => {
      const pet = petsService.getPet('sonic');
      const lastFrame = pet.definition.frame.columns * pet.definition.frame.rows - 1;

      assert.deepEqual(pet.preview, { frame: 0, column: 0, row: 0 });
      assert.ok(pet.preview.frame <= lastFrame);

      // A pet whose idle range starts partway through the sheet reports that
      // frame's real column and row, so no caller has to derive them.
      petsService.updatePet('sonic', { states: { idle: { start: 9, end: 12 } } });
      assert.deepEqual(petsService.getPet('sonic').preview, { frame: 9, column: 1, row: 1 });
    });
  } finally {
    closeConnection();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The ZIP reader.
 *
 * This is the only code in the app that parses bytes downloaded from the public
 * internet, and every one of its failure modes is silent: a mis-parsed offset
 * reads someone else's memory-mapped buffer, a trusted size allocates whatever
 * the archive claims, and an unchecked member name is the classic path escape.
 * So the interesting cases are all the refusals.
 */

/** Builds a ZIP in memory. Real headers, so the reader is exercised, not stubbed. */
function makeZip(
  members: { name: string; data: Buffer; method?: 0 | 8 }[],
  options: { corruptCrc?: boolean } = {},
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const member of members) {
    const method = member.method ?? 0;
    const stored = method === 8 ? zlib.deflateRawSync(member.data) : member.data;
    const name = Buffer.from(member.name, 'utf8');
    const crc = options.corruptCrc ? 0 : zlib.crc32(member.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.byteLength, 18);
    local.writeUInt32LE(member.data.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    locals.push(local, name, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.byteLength, 20);
    central.writeUInt32LE(member.data.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.byteLength + stored.byteLength;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(directory.byteLength, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, eocd]);
}

const ZIP_LIMITS = { maxEntries: 8, maxEntryBytes: 1024, maxTotalBytes: 4096 };

test('reads stored and deflated members', () => {
  const manifest = Buffer.from('{"id":"x"}', 'utf8');
  const sprite = Buffer.from('x'.repeat(400), 'utf8');
  const archive = makeZip([
    { name: 'pet.json', data: manifest },
    { name: 'spritesheet.webp', data: sprite, method: 8 },
  ]);

  const entries = listZipEntries(archive, ZIP_LIMITS);
  assert.deepEqual(entries.map((entry) => entry.name), ['pet.json', 'spritesheet.webp']);
  assert.equal(readZipEntry(archive, entries[0], 1024).toString('utf8'), '{"id":"x"}');
  assert.equal(readZipEntry(archive, entries[1], 1024).byteLength, 400);
});

test('rejects member names that try to escape', () => {
  for (const name of [
    '../escape.json',
    'nested/../../escape.json',
    '/absolute.json',
    'C:\\windows\\system32\\evil.json',
    'back\\slash.json',
  ]) {
    assert.equal(isSafeEntryName(name), false, `${name} should be refused`);
    assert.throws(
      () => listZipEntries(makeZip([{ name, data: Buffer.from('x') }]), ZIP_LIMITS),
      /unsafe file name/,
      `${name} should be refused by the reader`,
    );
  }

  assert.equal(isSafeEntryName('pet.json'), true);
  assert.equal(isSafeEntryName('frames/idle.png'), true);
});

test('rejects archives that are too big, too many, or not archives', () => {
  const big = makeZip([{ name: 'big.bin', data: Buffer.alloc(2048) }]);
  assert.throws(() => listZipEntries(big, ZIP_LIMITS), /larger than/);

  const many = makeZip(
    Array.from({ length: 9 }, (_unused, index) => ({ name: `f${index}.txt`, data: Buffer.from('x') })),
  );
  assert.throws(() => listZipEntries(many, ZIP_LIMITS), /the limit is 8/);

  const total = makeZip(
    Array.from({ length: 6 }, (_unused, index) => ({ name: `f${index}.bin`, data: Buffer.alloc(1000) })),
  );
  assert.throws(() => listZipEntries(total, ZIP_LIMITS), /size limit/);

  assert.throws(
    () => listZipEntries(Buffer.from('this is not a zip, it is a sentence'), ZIP_LIMITS),
    /ZIP/,
  );
});

test('rejects a member whose bytes do not match its checksum', () => {
  const archive = makeZip([{ name: 'pet.json', data: Buffer.from('{}') }], { corruptCrc: true });
  const [entry] = listZipEntries(archive, ZIP_LIMITS);
  assert.throws(() => readZipEntry(archive, entry, 1024), /checksum/);
});
