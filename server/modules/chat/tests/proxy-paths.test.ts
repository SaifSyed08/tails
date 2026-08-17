import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * Every websocket the renderer opens must be proxied in development.
 *
 * ## The bug this exists to prevent, which had no symptom
 *
 * `/voice` was missing from `vite.config.ts`. In a packaged build the renderer
 * is served by the same Express server that answers the socket, so the path
 * resolves and dictation works. Under `npm run dev` the renderer is served by
 * Vite on a *different port*, the handshake goes nowhere, and dictation
 * produces nothing.
 *
 * What made it survive so long is that the feature reported itself healthy.
 * `/api/voice/status` **is** proxied, so the button enabled, the microphone
 * opened, the level meter moved, the wake word fired — every visible signal
 * said it was working, and the only thing missing was the text. Three separate
 * rounds of debugging looked at the recogniser, the stability gate and the
 * engine path, because those are the parts that produce text, and the fault was
 * in a build config none of them touch.
 *
 * ## Why a file scan rather than a shared constant
 *
 * A constant would work only if everybody imported it, and the failure mode
 * here is precisely that somebody adds a socket without thinking about the
 * proxy. This reads the truth on both sides — the `new WebSocket(...)` calls in
 * the renderer, and the proxy table in the Vite config — so a fourth socket is
 * caught by existing, and cannot be caught any other way than by remembering.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');

/** Every source file under `src`, so nothing is missed by listing directories. */
function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

/**
 * The paths the renderer opens sockets on.
 *
 * Matches the one shape this app uses — a template literal ending in
 * `${window.location.host}/<path>` — deliberately rather than any string that
 * looks like a path. A socket written some other way would not be found, which
 * is why the count is asserted below: if this stops finding all of them, the
 * test says so instead of passing vacuously.
 */
function socketPaths(): string[] {
  const found = new Set<string>();

  for (const file of sourceFiles(path.join(ROOT, 'src'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/new WebSocket\(\s*`[^`]*\$\{window\.location\.host\}(\/[a-z0-9-]+)/gi)) {
      found.add(match[1]);
    }
  }

  return [...found].sort();
}

/** The keys of the `proxy` table in the Vite config. */
function proxiedPaths(): string[] {
  const config = fs.readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');
  const table = /proxy:\s*\{([\s\S]*?)\n {4}\},/.exec(config);
  assert.ok(table, 'could not find the proxy table in vite.config.ts');

  return [...table[1].matchAll(/^\s*'(\/[a-z0-9-]+)'\s*:/gim)].map((match) => match[1]).sort();
}

test('the renderer opens the sockets this test knows how to find', () => {
  // A guard on the guard. If the shape of these calls changes, the assertion
  // below would pass by finding nothing, and the check would be worthless
  // exactly when it started being needed.
  const paths = socketPaths();
  assert.ok(paths.length >= 3, `expected at least three sockets, found ${paths.join(', ') || 'none'}`);
  assert.deepEqual(paths, ['/shell', '/voice', '/ws']);
});

test('every websocket the renderer opens is proxied in development', () => {
  const proxied = new Set(proxiedPaths());

  for (const socket of socketPaths()) {
    assert.ok(
      proxied.has(socket),
      `${socket} is opened by the renderer but not proxied in vite.config.ts — `
      + 'it will work in the packaged build and silently fail under npm run dev',
    );
  }
});

test('the API prefix is proxied too, so it is not only sockets that are covered', () => {
  // `/api` is how every non-streaming call reaches the server. Not a socket, so
  // the scan above cannot see it, and losing it would break everything at once
  // rather than one feature quietly.
  assert.ok(proxiedPaths().includes('/api'));
});
