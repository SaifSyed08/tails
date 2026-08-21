/**
 * The invariant: whenever the pet window is visible, it is usable.
 *
 *     npx electron electron/harness/pet-invariant.mjs
 *
 * Exits 0 when it holds on every path, 1 when it does not.
 *
 * ## Why this exists
 *
 * "Visible" and "usable" were separate states that nothing forced to agree, and
 * they came apart four times by four unrelated routes — a drag band placed
 * against a stale rectangle, a show that skipped the page's reset, a carry flag
 * that could never clear, and a suppression release that showed a pet nobody
 * had prepared. Each fix was a repair to one path, and the next report arrived
 * by another. This checks the property instead of the route: one checklist, run
 * against every way the window can come to be on screen.
 *
 * **Adding a path should be the whole cost of covering it.** If a new reason to
 * show the pet appears, add a case here; you should not have to work out which
 * of the eight conditions it might break.
 *
 * ## When this is not enough
 *
 * This covers paths it knows about. For a report that arrives by a route not
 * listed here, the shell can be made to write down what it believed, which is
 * how the pill's-X-then-handoff case below was finally pinned to a flag rather
 * than guessed at:
 *
 *     TAILS_PET_TRACE=/some/where/pet-trace.jsonl npm run desktop
 *
 * One JSONL line per state change -- see `pet-trace.js`. Pair it with the
 * page's own published beliefs (the `data-` attributes on `#pet`, written by
 * `publishState` in `desktop-window.ts`) and both halves of any "visible but
 * unusable" report can be read side by side instead of argued about.
 *
 * ## What it needs
 *
 * Electron, and two pets installed in `~/.tails/pets` (`sonic-art` and `pika`).
 * It serves its own fixture of the real page, drives the real `pet-window.js`,
 * and forces every window it shows to zero opacity — so it is a genuinely shown
 * window as far as Electron and the page are concerned, with layout, hit
 * testing, drag regions and IPC all real, and nothing appearing on screen.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

/*
 * The pet's page is TypeScript on the server, and this is an Electron main
 * process, which cannot load it. Bundling it here rather than asking whoever
 * runs this to remember a build step: the whole value of this harness is that
 * adding a path to the list is the only cost of covering a new one.
 */
const BUNDLE = path.join(os.tmpdir(), 'tails-pet-invariant-page.cjs');
const ENTRY = path.join(os.tmpdir(), 'tails-pet-invariant-entry.ts');
fs.writeFileSync(ENTRY, [
  `export { renderDesktopWindowHtml } from ${JSON.stringify(path.join(ROOT, 'server/modules/pets/desktop-window.js'))};`,
  `export { codexSheetRows, CODEX_CELL, CODEX_COLUMNS, CODEX_FPS } from ${JSON.stringify(path.join(ROOT, 'server/modules/pets/codex-layout.js'))};`,
].join(String.fromCharCode(10)));
// esbuild's API rather than its CLI: spawning `npx` differs per platform and
// fails outright for `.cmd` shims on recent Node.
require(path.join(ROOT, 'node_modules', 'esbuild')).buildSync({
  entryPoints: [ENTRY],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: BUNDLE,
});

const { armWatchdog } = require('../harness-guard.cjs');
const { renderDesktopWindowHtml, codexSheetRows, CODEX_CELL, CODEX_COLUMNS, CODEX_FPS } = require(BUNDLE);
const { app, BrowserWindow } = require('electron');
const pet = await import('../pet-window.js');
armWatchdog(180000);

/** Nothing may actually appear. Every show is forced transparent. */
const originalShowInactive = BrowserWindow.prototype.showInactive;
BrowserWindow.prototype.showInactive = function patched() {
  this.setOpacity(0);
  const result = originalShowInactive.call(this);
  this.setOpacity(0);
  return result;
};

const mouse = [];
const originalIgnore = BrowserWindow.prototype.setIgnoreMouseEvents;
BrowserWindow.prototype.setIgnoreMouseEvents = function patched(ignore, opts) {
  mouse.push(ignore ? 'through' : 'INTERACTIVE');
  return originalIgnore.call(this, ignore, opts);
};

function loadPet(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.tails', 'pets', dir, 'pet.json'), 'utf8'));
  const sprite = fs.readFileSync(path.join(os.homedir(), '.tails', 'pets', dir, manifest.spritesheetPath));
  const rows = codexSheetRows(manifest.spriteVersionNumber);
  const states = {};
  for (const row of rows) states[row.name] = { start: row.row * CODEX_COLUMNS, end: row.row * CODEX_COLUMNS + row.frames - 1 };
  return {
    sprite,
    payload: {
      definition: {
        id: manifest.id,
        displayName: manifest.displayName,
        description: '',
        spriteVersionNumber: manifest.spriteVersionNumber,
        spritesheetPath: manifest.spritesheetPath,
        frame: { width: CODEX_CELL.width, height: CODEX_CELL.height, columns: CODEX_COLUMNS, rows: rows.length, fps: CODEX_FPS },
        states,
      },
      spriteUrl: `/sprite/${manifest.id}`,
      preview: { frame: 0, column: 0, row: 0 },
      stage: { scale: 1, walks: true },
    },
  };
}

const A = loadPet('sonic-art');
const B = loadPet('pika');
let active = A;

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/pets/window')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(renderDesktopWindowHtml({ testHooks: true })); }
  else if (req.url.startsWith('/api/pets/display')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ source: 'global', pet: active.payload })); }
  else if (req.url.startsWith('/sprite/')) {
    const which = req.url.endsWith(A.payload.definition.id) ? A : B;
    res.writeHead(200, { 'content-type': 'image/webp' });
    res.end(which.sprite);
  } else { res.writeHead(404); res.end('no'); }
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let win = null;

/**
 * Everything that has to be true for a press to reach the drag region.
 *
 * Read from the page's published state plus the shell's own view, and asserted
 * as one lump: any single one of these being false is a pet nobody can pick up,
 * and each has been the culprit at least once.
 */
async function check(label) {
  await wait(450);
  const page = await win.webContents.executeJavaScript(`(() => {
    const el = document.getElementById('pet');
    const handle = document.getElementById('handle');
    const box = handle.getBoundingClientRect();
    return {
      pet: el.dataset.pet || '',
      mask: el.dataset.mask || '',
      carry: el.dataset.carry || '',
      handle: { width: Math.round(box.width), height: Math.round(box.height) },
      region: getComputedStyle(handle).getPropertyValue('-webkit-app-region'),
      spriteBox: (() => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; })(),
    };
  })()`);

  // The handshake: a pointer on his body must make the window accept the mouse.
  mouse.length = 0;
  await win.webContents.executeJavaScript(`document.dispatchEvent(new MouseEvent('mousemove', { clientX: 2, clientY: 2, bubbles: true })), true`);
  await wait(60);
  mouse.length = 0;
  const body = { x: page.spriteBox.left + Math.round(page.spriteBox.width / 2), y: page.spriteBox.top + Math.round(page.spriteBox.height * 0.62) };
  await win.webContents.executeJavaScript(`document.dispatchEvent(new MouseEvent('mousemove', { clientX: ${body.x}, clientY: ${body.y}, bubbles: true })), true`);
  await wait(90);
  const becameInteractive = mouse.includes('INTERACTIVE');

  const failures = [];
  if (!win.isVisible()) failures.push('window not visible');
  if (!win.isMovable()) failures.push('window not movable');
  /*
   * Topmost is part of usable, not part of visible.
   *
   * A pet behind the app window looks completely fine — he is on the desktop,
   * he animates, nothing is wrong with him — and every press lands in the app.
   * That is the same symptom as a page that has stopped reporting the pointer,
   * which is why it was worth adding here rather than reasoning about.
   */
  if (!win.isAlwaysOnTop()) failures.push('window is no longer topmost');
  if (!page.pet) failures.push('page is showing no pet');
  if (page.mask !== page.pet) failures.push(`mask is for "${page.mask}" but the pet is "${page.pet}"`);
  if (page.carry) failures.push('page still believes it is being carried');
  if (page.handle.width < 12 || page.handle.height < 10) failures.push(`no drag region (${page.handle.width}x${page.handle.height})`);
  if (page.region !== 'drag') failures.push(`drag region is "${page.region}"`);
  if (!becameInteractive) failures.push('pointer on his body did not make the window interactive');

  console.log(`${failures.length ? 'FAIL' : 'ok  '}  ${label}${failures.length ? `\n        ${failures.join('\n        ')}` : ''}`);
  return failures.length === 0;
}

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  win = pet.createPetWindow({
    serverUrl: `http://127.0.0.1:${server.address().port}`,
    appRoot: ROOT,
    readState: () => ({}), writeState: () => {},
    onOpenPetDetails: () => {}, onOpenSession: () => {},
  });
  win.setOpacity(0);
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await wait(900);

  let allPassed = true;
  const run = async (label) => { allPassed = (await check(label)) && allPassed; };

  // 1. Restored on launch: the page reported a pet and the shell showed him.
  await run('restored on launch');

  // 2. Hidden, then shown again.
  pet.setPetHidden(true);
  await wait(200);
  pet.setPetHidden(false);
  await run('shown again after being hidden');

  // 3. Carried out of a chat: suppressed while the in-chat pet has him, then
  //    released when the user leaves that chat.
  pet.setPetSuppressed(true);
  await wait(200);
  pet.setPetSuppressed(false);
  await run('suppression released (in-chat pet handed back)');

  // 4. His exact case: a second pet is active from the marketplace while a
  //    *different* pet stands in a conversation, then the user navigates away.
  pet.setPetSuppressed(true);   // a chat with pet B in the interface
  await wait(300);
  active = B;                   // ...and the marketplace pet is changed underneath
  pet.refreshPetWindow();
  await wait(400);
  active = A;
  pet.refreshPetWindow();
  await wait(400);
  pet.setPetSuppressed(false);  // navigate away: the window comes back
  await run('marketplace pet returns after a chat pet had the screen');

  // 5. The pet is swapped while he is on screen (activate another from the
  //    marketplace with nothing suppressed).
  active = B;
  pet.refreshPetWindow();
  await run('a different pet activated while he is on screen');

  // 6. The notification path: a bubble arrives, which resizes the window.
  pet.notifyPetOfCompletion({ sessionId: 'chat-1', title: 'Fix the drag bug', at: Date.now() });
  await run('a notification arrives');
  pet.clearPetAlert('chat-1');
  await run('and is cleared');

  // 7. A carry the app is actually driving. He is *meant* to be uninterruptible
  //    here — the hand is holding him — so the only thing asserted is that the
  //    shell and the page agree that he is being carried.
  const at = win.getBounds();
  for (let i = 0; i < 3; i += 1) pet.placePetAt(at.x + 40 + i, at.y + 40, true);
  await wait(120);
  const midFlight = await win.webContents.executeJavaScript("document.getElementById('pet').dataset.carry === '1'");
  console.log(`${midFlight ? 'ok  ' : 'FAIL'}  mid-handoff: the page is carrying him, as the shell says`);
  allPassed = midFlight && allPassed;

  // 8. ...and that same carry abandoned: no release, no final frame. The window
  //    must come back to usable on its own, without the 2s safety timer.
  await wait(700);
  pet.setPetSuppressed(true);
  await wait(150);
  pet.setPetSuppressed(false);
  await run('shown after an abandoned carry');

  /*
   * 9. Navigation, at the speed navigation actually happens.
   *
   * Every suppression path above releases with a pause in it, and that pause is
   * not real. Leaving a chat unmounts the in-chat pet and mounts the next one
   * in the same React commit, so the shell sees suppress(true) and
   * suppress(false) — a real `hide()` and a real `showInactive()` — inside one
   * tick, with no frame between them. That is the case the reported bug
   * describes and the one none of the paths above covered.
   */
  pet.setPetSuppressed(true);
  pet.setPetSuppressed(false);
  await run('suppression flapped within one tick, as a navigation does');

  // 10. And the other order a remount produces: released, then immediately
  //     re-suppressed and released again by the next surface's own effect.
  pet.setPetSuppressed(false);
  pet.setPetSuppressed(true);
  pet.setPetSuppressed(false);
  await run('released, re-suppressed and released again in one tick');

  /*
   * 11. His exact sequence: a chat that holds the pet in its interface, left
   *     for somewhere that has no in-chat pet at all.
   *
   * The pet is never carried out, so nothing activates anybody and nothing
   * places the window — the only thing that happens is that suppression goes on
   * and comes off. Written out as its own case anyway, because "the steps the
   * user typed" is the thing worth being able to point at.
   */
  pet.setPetSuppressed(true);      // open the chat: the in-chat pet takes over
  await wait(500);                 // ...and the user reads for a moment
  pet.setPetSuppressed(false);     // then leaves for the marketplace
  await run('left a chat whose pet was standing in the interface');

  /*
   * 12. Knocked out of the topmost band, as another always-on-top window can
   *     do. The pet must climb back without anybody showing him again.
   */
  win.setAlwaysOnTop(false);
  await run('recovered after losing always-on-top');

  // 13. And marked immovable behind the shell's back, which makes the OS
  //     ignore the drag region entirely.
  win.setMovable(false);
  await run('recovered after being made immovable');

  /*
   * 14. Un-hidden while suppression is still set.
   *
   * The reported case: the pill's X hides him, and afterwards the marketplace's
   * own switch appears to do nothing. Two flags keep him off screen and the
   * switch only ever cleared one, so the way back was a differently named
   * button — which is the tell that the switch was not finishing its job.
   */
  pet.setPetSuppressed(true);
  pet.setPetHidden(true);
  await wait(200);
  pet.setPetHidden(false);
  await run('un-hidden while a stale suppression was still set');

  /*
   * 15. Hidden with the pill's X, then handed out of a chat.
   *
   * The reported bug, and the reason it was invisible from inside the handoff:
   * `hidden` and `suppressed` are separate vetoes, and carrying a pet past the
   * edge of the chat only ever released the second one. So after the X had been
   * pressed, a pet dragged out was activated, placed and carried on a window
   * that was never shown -- the hand opened over the desktop and there was
   * nothing there. The handoff says `hide(false)` now, which is the whole job
   * rather than half of it; this is the assertion that it is.
   */
  pet.setPetSuppressed(true);      // he is standing in the chat
  pet.setPetHidden(true);          // ...and the pill's X was pressed earlier
  await wait(200);
  pet.setPetHidden(false);         // the handoff: carried out past the edge
  await run('handed out of a chat after the pill had hidden him');

  /*
   * 16. The page's belief about the pointer, left out of step with the shell's.
   *
   * The two sides hold "is the pointer on him" in two places and nothing
   * reconciled them. In the direction tested here -- the page believing the
   * pointer is already on the pet while the shell has the window click-through
   * -- every route out was closed: no mousemove could report a change, because
   * as far as the page was concerned nothing had changed, and the shell's poll
   * went through the same dedupe and returned silently. Visible, animating and
   * impossible to press, for the rest of the session.
   *
   * The poll answers authoritatively now. This drives the page into the stale
   * state directly rather than through a route, because the route that produces
   * it in the wild has not been identified -- which is the whole reason this
   * file checks the property instead.
   */
  const stale = await win.webContents.executeJavaScript(`(() => {
    const r = document.getElementById('pet').getBoundingClientRect();
    const spot = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height * 0.62) };
    /*
      The precondition, established rather than assumed, and reached through the
      page's own test seam.

      Two earlier versions of this were wrong in instructive ways. The first set
      the belief and sent the probe without putting the shell back to
      click-through, so the healing report arrived at a shell that already
      agreed and was deduped on that side. The second assigned to 'pointerOver'
      from here -- but the page's script is a module, so that created a
      same-named global and touched nothing, which looks exactly like a pass.
      A test whose subject is a disagreement between two places has to put both
      halves where it claims they are, and has to be able to prove it did.
    */
    petBridge.reportPointerOverPet(false);
    window.__petTest.believePointerOver(true);
    return {
      spot,
      // And the point has to actually be on him, or a "no" proves nothing.
      onHim: window.__petTest.isOverPet(spot.x, spot.y),
      state: window.__petTest.read(),
    };
  })()`);

  await wait(80);
  mouse.length = 0;
  win.webContents.send('pet:probe', stale.spot);
  await wait(150);
  const staged = stale.onHim && stale.state.pointerOver === true;
  const healed = staged && mouse.includes('INTERACTIVE');
  console.log(`${healed ? 'ok  ' : 'FAIL'}  a stale "the pointer is on him" heals on the next poll`
    + (staged ? '' : ` (not staged: onHim=${stale.onHim} pointerOver=${stale.state.pointerOver}, so this proved nothing)`));
  allPassed = healed && allPassed;
  await run('and he is usable after the page had been out of step');

  console.log(allPassed ? '\nINVARIANT HOLDS on every path' : '\nINVARIANT BROKEN');
  pet.destroyPetWindow(); server.close(); app.exit(allPassed ? 0 : 1);
});
