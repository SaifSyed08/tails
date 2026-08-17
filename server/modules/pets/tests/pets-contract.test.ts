import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { petDefinitionSchema } from '@/modules/pets/pet-spec.js';

/**
 * The client's picture of `/api/pets`, held against what the server sends.
 *
 * ## Why this exists
 *
 * Three bugs, one mechanism: a hand-written client type that disagreed with the
 * payload.
 *
 * - `definition.name` where the server sends `displayName` — every read was
 *   `undefined`, and the thinking indicator silently fell back to no pet;
 * - `thinkingPhrases` declared *inside* `definition` where the server sends it
 *   as a sibling — seeded phrases reached nothing;
 * - `voice` omitted entirely — a pet could not be heard.
 *
 * None of them could fail a typecheck, **because the type was the thing that
 * was wrong**. TypeScript checks that code agrees with its types; nothing
 * checked that the types agreed with the wire. The symptom each time was a
 * feature quietly reaching nothing, which is the hardest kind to notice and the
 * easiest kind to ship.
 *
 * So this reads both sides as text and compares them by name. It is deliberately
 * literal: the zod schema is the server's actual validator, and the client
 * mirror is the text a developer edits. Comparing anything more abstract than
 * those two would be comparing something other than the thing that broke.
 *
 * ## Scope
 *
 * `/api/pets` only — this module's own endpoint, and where all three happened.
 * The mechanism generalises to any hand-written client mirror, but a guard that
 * reaches into other modules' payloads is one that rots and gets deleted.
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLIENT_MIRROR = 'src/components/marketplace/marketplace-api.ts';
const SERVICE = 'server/modules/pets/pets.service.ts';
const SHARED_CLIENT = 'src/lib/api.ts';

const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/** Strips comments, so prose inside a doc block is never mistaken for a field. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * The field names an exported object type declares, at its top level only.
 *
 * Depth-aware rather than a line regex: `preview: { frame: number }` and
 * `voice?: { engine: ... }` are nested objects whose inner names are not fields
 * of the outer type, and treating them as such would make this guard lie in
 * both directions.
 */
function topLevelKeys(source: string, typeName: string): Set<string> {
  const clean = withoutComments(source);
  const start = clean.indexOf(`export type ${typeName} = {`);
  assert.notEqual(start, -1, `${typeName} is not declared in this file any more`);

  const keys = new Set<string>();
  let depth = 0;

  for (let index = clean.indexOf('{', start); index < clean.length; index += 1) {
    const character = clean[index];
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) break;
    } else if (depth === 1) {
      const rest = clean.slice(index);
      const field = /^([A-Za-z_$][\w$]*)\s*\??\s*:/.exec(rest);
      if (field) {
        keys.add(field[1]);
        index += field[0].length - 1;
      }
    }
  }

  assert.ok(keys.size > 0, `${typeName} parsed as empty, so this guard is not guarding anything`);
  return keys;
}

/** "Did you mean displayName?" — the difference between a fix and a puzzle. */
function nearest(name: string, candidates: Iterable<string>): string | null {
  const needle = name.toLowerCase();
  for (const candidate of candidates) {
    const other = candidate.toLowerCase();
    if (other.includes(needle) || needle.includes(other)) return candidate;
  }
  return null;
}

test('the client mirror of a pet definition matches the schema the server validates with', () => {
  const server = new Set(Object.keys(petDefinitionSchema.shape));
  const client = topLevelKeys(read(CLIENT_MIRROR), 'PetDefinition');
  // Read here too, so the *first* failure a reader sees can tell the difference
  // between an invented field and a real one on the wrong side of `definition`.
  const siblings = topLevelKeys(read(SERVICE), 'InstalledPet');

  const missing = [...server].filter((field) => !client.has(field));
  assert.deepEqual(
    missing, [],
    `${CLIENT_MIRROR} omits ${missing.map((f) => `"${f}"`).join(', ')} from PetDefinition, `
    + 'which /api/pets sends. A field left out of this type is a field the app cannot read.',
  );

  const invented = [...client].filter((field) => !server.has(field));
  assert.deepEqual(
    invented, [],
    invented.map((field) => {
      if (siblings.has(field)) {
        return `${CLIENT_MIRROR} declares "${field}" inside PetDefinition, but the server sends it `
          + 'as a sibling of `definition`, not a field within it.';
      }
      const guess = nearest(field, server);
      return `${CLIENT_MIRROR} declares PetDefinition."${field}", which the server does not send`
        + `${guess ? `. Did you mean "${guess}"?` : '.'}`;
    }).join(' '),
  );
});

test('a pet field is on the same side of `definition` in both halves', () => {
  // The `thinkingPhrases` bug: declared inside `definition` where the server
  // sends it beside it. Both halves parse, both typecheck, and the read is
  // `undefined` for ever.
  const serverPet = topLevelKeys(read(SERVICE), 'InstalledPet');
  const clientPet = topLevelKeys(read(CLIENT_MIRROR), 'InstalledPet');
  const clientDefinition = topLevelKeys(read(CLIENT_MIRROR), 'PetDefinition');

  const misplaced = [...clientDefinition].filter(
    (field) => !petDefinitionSchema.shape[field as keyof typeof petDefinitionSchema.shape]
      && serverPet.has(field),
  );
  assert.deepEqual(
    misplaced, [],
    misplaced.map((field) => `${CLIENT_MIRROR} declares "${field}" inside PetDefinition, but the `
      + 'server sends it as a sibling of `definition`, not a field within it.').join(' '),
  );

  const missing = [...serverPet].filter((field) => !clientPet.has(field));
  assert.deepEqual(
    missing, [],
    `${CLIENT_MIRROR} omits ${missing.map((f) => `"${f}"`).join(', ')} from InstalledPet, `
    + `which ${SERVICE} sends.`,
  );

  const invented = [...clientPet].filter((field) => !serverPet.has(field));
  assert.deepEqual(
    invented, [],
    invented.map((field) => {
      const guess = nearest(field, serverPet);
      return `${CLIENT_MIRROR} declares InstalledPet."${field}", which ${SERVICE} does not send`
        + `${guess ? `. Did you mean "${guess}"?` : '.'}`;
    }).join(' '),
  );
});

test('nothing hand-writes a second picture of the pets payload', () => {
  // The three bugs were all in a *separate*, narrower copy of this payload in
  // the shared client. There is now one mirror, maintained by the surface that
  // renders every field of it; a second one would be free to drift again.
  const shared = withoutComments(read(SHARED_CLIENT));
  // Bounded by characters rather than by a line ending: this file is CRLF on
  // Windows and LF elsewhere, and a guard that only works on one of them is a
  // guard that passes for the wrong reason.
  const listPets = /listPets:[\s\S]{0,300}/.exec(shared)?.[0] ?? '';

  assert.ok(
    listPets.includes('request<PetLibrary>'),
    `${SHARED_CLIENT} should read /api/pets as the pets module's own PetLibrary type rather than `
    + 'describing the payload again. Three bugs came from the second description drifting from '
    + 'the first; see the note above listPets.',
  );
});
