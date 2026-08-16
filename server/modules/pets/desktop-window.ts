import { randomBytes } from 'node:crypto';

/**
 * The desktop pet's page.
 *
 * Served by our own server rather than built as a second renderer entry point,
 * for two reasons that both come down to it being a *different* document: it
 * has no theme, no React, no app shell, and it must load identically whether
 * the app is running from Vite or from a packaged build. A URL the shell can
 * point a window at satisfies both, and adds no build configuration.
 *
 * ## What it duplicates, and what it must not
 *
 * The animation technique here is the same one `SpritePreview` uses — one cell,
 * the sheet as a background, `steps(n, jump-none)` — because there is no
 * bundler in this document to import the component into. Mirrored *mechanism*
 * is survivable; mirrored *decisions* were not. When this page decided for
 * itself which frames to play, it drifted from the app within one release and
 * the pet blinked here and not there.
 *
 * So every decision now arrives in the payload: `playable` says which frames to
 * play, `preview` says which frame represents the pet. The one thing this page
 * still works out for itself is the opaque-pixel mask, because that is not a
 * decision — it is a measurement of where the pointer may grab, and it is
 * posted back so the server can trim for everyone else too.
 */

/** How often the page re-reads which pet is active. */
const POLL_MS = 2500;

/** The pet's on-screen height in CSS pixels. */
const PET_HEIGHT = 128;

/** Transparent room around the sprite, in CSS pixels. Mirrored in `pet-window.js`. */
const PADDING = 12;

/** How far outside an opaque pixel still counts as "on the pet", in cell pixels. */
const HIT_TOLERANCE = 6;

export function renderDesktopWindowHtml(): string {
  // A fresh nonce per render, so the page can keep its inline style and script
  // without opening the door to any others. It is a window floating over the
  // whole desktop; "default-src 'none'" is the right starting point, and the
  // only things it may reach are our own origin and its own two blocks.
  const nonce = randomBytes(16).toString('base64');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; connect-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>T.A.I.L.S. pet</title>
<style nonce="${nonce}">
  html, body {
    margin: 0;
    height: 100%;
    background: transparent;
    overflow: hidden;
    /* The window is transparent and click-through; a selection highlight or a
       drag ghost here would be a visible artefact floating over the desktop. */
    user-select: none;
    -webkit-user-select: none;
    cursor: default;
  }

  #stage {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding: ${PADDING}px;
    box-sizing: border-box;
  }

  #pet {
    background-repeat: no-repeat;
    image-rendering: pixelated;
    /* Grabbing is the only gesture, and the cursor is the only affordance a
       window with no chrome can offer. */
    cursor: grab;
    transition: filter 120ms ease-out;
  }

  /* No shadow while carried. The window is transparent and sits over whatever
     is behind it, so a drop shadow is a grey smudge following the pointer
     across the desktop rather than a sense of depth. */
  #pet.dragging { cursor: grabbing; }

  #pet.mirrored { transform: scaleX(-1); }

  @keyframes tails-sprite-x {
    from { background-position-x: var(--sprite-x-from); }
    to { background-position-x: var(--sprite-x-to); }
  }

  @keyframes tails-sprite-y {
    from { background-position-y: var(--sprite-y-from); }
    to { background-position-y: var(--sprite-y-to); }
  }

  @media (prefers-reduced-motion: reduce) {
    #pet { animation: none !important; }
  }
</style>
</head>
<body>
<div id="stage"><div id="pet" role="img" aria-label="Desktop pet"></div></div>
<script type="module" nonce="${nonce}">
const POLL_MS = ${POLL_MS};
const PET_HEIGHT = ${PET_HEIGHT};
const PADDING = ${PADDING};
const HIT_TOLERANCE = ${HIT_TOLERANCE};

const bridge = window.petBridge ?? {
  reportVisibility() {}, reportSize() {}, reportPointerOverPet() {},
  startDrag() {}, endDrag() {}, dragHeartbeat() {}, openMenu() {},
  onFacing() {}, onRefresh() {}, onDragMode() {},
};

const stage = document.getElementById('stage');
const pet = document.getElementById('pet');

let current = null;      // the pet payload currently rendered
let box = null;          // its cell geometry
let mask = null;         // union alpha mask of the played frames, at cell resolution
let dragging = false;
let dragHeartbeat = null;
let pointerOver = false;
let playing = null;      // the state name currently animating
let petRect = null;      // cached sprite box; invalidated on resize and re-render
let facing = 'right';

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** One cell, drawn at PET_HEIGHT. The same arithmetic as sprite-geometry.ts. */
function resolveCellBox(grid, displayHeight) {
  const cellSourceWidth = grid.width > 0 ? grid.width : 1;
  const cellSourceHeight = grid.height > 0 ? grid.height : 1;
  const columns = Math.max(1, Math.floor(grid.columns) || 1);
  const rows = Math.max(1, Math.floor(grid.rows) || 1);
  const scale = displayHeight / cellSourceHeight;

  return {
    cellWidth: cellSourceWidth * scale,
    cellHeight: cellSourceHeight * scale,
    sheetWidth: columns * cellSourceWidth * scale,
    sheetHeight: rows * cellSourceHeight * scale,
    columns,
    rows,
    scale,
  };
}

/**
 * The opaque pixels of the frames we draw, in cell coordinates.
 *
 * Used only to decide when the window may take a click. It reads one cell at a
 * time rather than pulling the whole sheet into memory: a v2 sheet is
 * 1536x2288, so the old whole-canvas "getImageData" allocated fourteen
 * megabytes and scanned three and a half million pixels to answer a question
 * about six of them.
 *
 * Frame counts come from the published layout now, so nothing here is
 * measuring what to play — only where the pet is.
 */
function buildHitMask(image, grid, range) {
  const canvas = document.createElement('canvas');
  const cellWidth = Math.round(image.naturalWidth / grid.columns);
  const cellHeight = Math.round(image.naturalHeight / grid.rows);
  canvas.width = cellWidth;
  canvas.height = cellHeight;

  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;

  const bytes = new Uint8Array(cellWidth * cellHeight);

  for (let frame = range.start; frame <= range.end; frame += 1) {
    const originX = (frame % grid.columns) * cellWidth;
    const originY = Math.floor(frame / grid.columns) * cellHeight;

    context.clearRect(0, 0, cellWidth, cellHeight);
    context.drawImage(image, originX, originY, cellWidth, cellHeight, 0, 0, cellWidth, cellHeight);
    const { data } = context.getImageData(0, 0, cellWidth, cellHeight);

    for (let index = 0; index < bytes.length; index += 1) {
      if (data[index * 4 + 3] > 8) bytes[index] = 1;
    }
  }

  return { bytes, width: cellWidth, height: cellHeight };
}

function applyAnimation(grid, range) {
  const start = range.start;
  const end = range.end;
  const frameCount = end - start + 1;
  const startColumn = start % grid.columns;
  const startRow = Math.floor(start / grid.columns);
  const rowSpan = Math.floor(end / grid.columns) - startRow + 1;
  const framesPerSweep = rowSpan === 1 ? frameCount : grid.columns;
  const fps = range.fps ?? grid.fps ?? 8;

  const originX = rowSpan === 1 ? -startColumn * box.cellWidth : 0;
  const still = reduced || frameCount < 2 || framesPerSweep < 2;

  pet.style.width = box.cellWidth + 'px';
  pet.style.height = box.cellHeight + 'px';
  pet.style.backgroundSize = box.sheetWidth + 'px ' + box.sheetHeight + 'px';
  pet.style.setProperty('--sprite-x-from', originX + 'px');
  pet.style.setProperty('--sprite-x-to', (originX - (framesPerSweep - 1) * box.cellWidth) + 'px');
  pet.style.setProperty('--sprite-y-from', (-startRow * box.cellHeight) + 'px');
  pet.style.setProperty('--sprite-y-to', (-(startRow + rowSpan - 1) * box.cellHeight) + 'px');

  if (still) {
    pet.style.animation = 'none';
    pet.style.backgroundPosition = (-startColumn * box.cellWidth) + 'px '
      + (-startRow * box.cellHeight) + 'px';
    return;
  }

  pet.style.backgroundPositionY = (-startRow * box.cellHeight) + 'px';
  pet.style.animation = [
    'tails-sprite-x ' + (framesPerSweep / Math.max(0.5, fps)) + 's steps('
      + framesPerSweep + ', jump-none) infinite',
    ...(rowSpan > 1
      ? ['tails-sprite-y ' + (frameCount / Math.max(0.5, fps)) + 's steps('
        + rowSpan + ', jump-none) infinite']
      : []),
  ].join(', ');
}

/**
 * Which animation to play, by name.
 *
 * Codex sheets carry nine or eleven labelled rows, so this is a lookup rather
 * than a trick: dragging plays the real "running-left" or "running-right" row —
 * drawn facing that way by the artist — and hovering plays "waving". The
 * previous version of this function mirrored the idle loop and added a bob,
 * which was an elaborate way of not knowing those rows existed.
 *
 * The fallbacks only matter for a sheet that is not a Codex sheet and has just
 * an idle row; mirroring is kept for that case alone, so a one-row pet still
 * turns around when carried.
 */
const STATE_FALLBACKS = {
  'running-left': ['running', 'running-right', 'idle'],
  'running-right': ['running', 'running-left', 'idle'],
  waving: ['review', 'look-right-side', 'idle'],
  idle: [],
};

function rangeFor(name) {
  if (!current) return null;
  const states = current.definition.states || {};
  if (states[name]) return { name: name, range: states[name] };

  const alternatives = STATE_FALLBACKS[name] || [];
  for (const candidate of alternatives) {
    if (states[candidate]) return { name: candidate, range: states[candidate] };
  }
  return states.idle ? { name: 'idle', range: states.idle } : null;
}

/**
 * Plays a state, and mirrors only when the sheet has no directional row of its
 * own to use instead.
 */
function playState(name) {
  const resolved = rangeFor(name);
  if (!resolved || !current) return;

  const wantedLeft = name === 'running-left';
  const gotDirectional = resolved.name === 'running-left' || resolved.name === 'running-right';
  const mirror = wantedLeft && !gotDirectional;

  pet.classList.toggle('mirrored', mirror);
  if (playing === resolved.name && !mirror) return;

  playing = resolved.name;
  applyAnimation(current.definition.frame, resolved.range);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('sprite failed to load'));
    image.src = url;
  });
}

const sameRange = (left, right) => Boolean(left) && Boolean(right)
  && left.start === right.start && left.end === right.end && left.fps === right.fps;

/** Renders a pet, or nothing. Reports both to the shell. */
async function render(next) {
  if (!next) {
    current = null;
    playing = null;
    mask = null;
    petRect = null;
    pet.style.display = 'none';
    bridge.reportVisibility(false);
    return;
  }

  const grid = next.definition.frame;
  const idle = next.definition.states.idle;
  const changed = !current || current.definition.id !== next.definition.id
    || current.spriteUrl !== next.spriteUrl;
  // Re-applying an animation restarts it, so a poll that changed nothing must
  // not touch it. That is what made the pet hitch every few seconds.
  const statesChanged = current && !sameRange(current.definition.states.idle, idle);

  current = next;
  box = resolveCellBox(grid, PET_HEIGHT);
  pet.style.display = 'block';

  if (changed) {
    pet.style.backgroundImage = 'url(' + next.spriteUrl + ')';
    bridge.reportSize(
      Math.ceil(box.cellWidth) + PADDING * 2,
      Math.ceil(box.cellHeight) + PADDING * 2,
    );
    bridge.reportVisibility(true);
  }

  if ((changed || statesChanged) && !dragging && !pointerOver) {
    playing = null;
    playState('idle');
  }

  if (!changed && mask) return;

  petRect = null;

  // The mask is what makes the window clickable in the right places, so a
  // failure here is not cosmetic: fall back to the sprite's whole box rather
  // than leaving the pet ungrabbable.
  try {
    const image = await loadImage(next.spriteUrl);
    mask = buildHitMask(image, grid, idle);
  } catch {
    mask = null;
  }
}

/** Whether a point inside the window sits on the pet's own pixels. */
function isOverPet(clientX, clientY) {
  if (!box) return false;

  // Cached: this runs on every forwarded mouse move, and the sprite only moves
  // when the window resizes or the pet changes. Reading layout per move is a
  // forced synchronous reflow sixty times a second for a number that did not
  // change.
  if (!petRect) petRect = pet.getBoundingClientRect();
  const rect = petRect;
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    return false;
  }
  if (!mask) return true;

  // Into cell pixels, undoing the mirror when the pet faces left.
  const localX = pet.classList.contains('mirrored')
    ? rect.right - clientX
    : clientX - rect.left;
  const x = Math.round((localX / box.scale));
  const y = Math.round((clientY - rect.top) / box.scale);

  for (let dy = -HIT_TOLERANCE; dy <= HIT_TOLERANCE; dy += HIT_TOLERANCE) {
    for (let dx = -HIT_TOLERANCE; dx <= HIT_TOLERANCE; dx += HIT_TOLERANCE) {
      const sampleX = x + dx;
      const sampleY = y + dy;
      if (sampleX < 0 || sampleY < 0 || sampleX >= mask.width || sampleY >= mask.height) continue;
      if (mask.bytes[sampleY * mask.width + sampleX]) return true;
    }
  }

  return false;
}

function setPointerOver(next) {
  if (pointerOver === next) return;
  pointerOver = next;
  bridge.reportPointerOverPet(next);

  // The pet notices you. "waving" is the row Codex sheets have for it, and a
  // sheet without one keeps its idle rather than inventing a gesture.
  if (!dragging) playState(next ? 'waving' : 'idle');
}

document.addEventListener('mousemove', (event) => {
  if (dragging) return;
  setPointerOver(isOverPet(event.clientX, event.clientY));
});

/**
 * Ends a drag the page can no longer see.
 *
 * A drag is released with a mouseup, and the page only receives one while the
 * pointer is over the window. Anything that separates the two — the pointer
 * outrunning the window, the window stopping at a screen edge, another app
 * taking the pointer — would otherwise leave the pet glued to the cursor with
 * no way to put it down.
 */
function abandonDrag() {
  if (!dragging) return;
  dragging = false;
  stopHeartbeat();
  pet.classList.remove('dragging');
  playState('idle');
  bridge.endDrag();
}

/**
 * A pulse that means "the button is still down".
 *
 * The shell cannot read the mouse button, so it used to infer a finished drag
 * from the pointer leaving the window — which is wrong whenever a fast gesture
 * outruns the window for a moment, and it froze the drag mid-carry. This page
 * *does* know: it has the mousedown, and it gets the mouseup, the mouseleave or
 * the blur. So it says so, and the shell only gives up when this goes quiet.
 */
function startHeartbeat() {
  stopHeartbeat();
  bridge.dragHeartbeat();
  dragHeartbeat = window.setInterval(() => bridge.dragHeartbeat(), 200);
}

function stopHeartbeat() {
  if (dragHeartbeat !== null) window.clearInterval(dragHeartbeat);
  dragHeartbeat = null;
}

// Belt and braces with the shell's watchdog: whichever notices first wins, and
// the cost of noticing late is a rectangle of desktop that ignores clicks — or
// a pet that cannot be let go of.
document.addEventListener('mouseleave', () => {
  abandonDrag();
  setPointerOver(false);
});
window.addEventListener('blur', () => {
  abandonDrag();
  setPointerOver(false);
});

pet.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || !isOverPet(event.clientX, event.clientY)) return;
  event.preventDefault();

  dragging = true;
  startHeartbeat();
  pet.classList.add('dragging');
  playState(facing === 'left' ? 'running-left' : 'running-right');

  // No coordinates: the shell works out the grab offset from the cursor and the
  // window position, both of which it can read in one coordinate system. The
  // renderer's screenX is not reliably in the same units as the window's
  // position, and the error grows with distance from the origin — which is
  // exactly the drift of a pet that falls behind the further you drag it.
  bridge.startDrag();
});

// On the document, not the sprite: the pointer routinely ends a fast drag
// outside the pet, and a mouseup missed there would leave the window stuck
// interactive and still following the cursor.
document.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  stopHeartbeat();
  pet.classList.remove('dragging');
  playState('idle');
  bridge.endDrag();
  setPointerOver(false);
});

document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  if (!current || !isOverPet(event.clientX, event.clientY)) return;
  bridge.openMenu(current.definition.id);
});

bridge.onFacing((next) => {
  facing = next;
  // A real row per direction, so this is a state change and not a flip.
  if (dragging) playState(next === 'left' ? 'running-left' : 'running-right');
});
bridge.onRefresh(() => void poll());

/**
 * A label naming the live drag mechanism, while three are being compared.
 *
 * Temporary scaffolding for a bug that has survived four fixes: without it,
 * switching modes is indistinguishable from nothing happening. Built in JS
 * rather than in the page's markup and CSS so that deleting this block is the
 * whole removal.
 */
bridge.onDragMode((mode) => {
  let label = document.getElementById('drag-mode');
  if (!label) {
    label = document.createElement('div');
    label.id = 'drag-mode';
    // Inline, because it outlives no one: this element is deleted with the
    // experiment and should not leave a rule behind in the stylesheet.
    label.style.cssText = [
      'position:fixed', 'left:50%', 'top:2px', 'transform:translateX(-50%)',
      'font:600 10px/1.4 ui-monospace,monospace', 'letter-spacing:.08em',
      'padding:2px 6px', 'border-radius:4px', 'white-space:nowrap',
      'background:rgba(0,0,0,.72)', 'color:#ffb454', 'pointer-events:none',
      'transition:opacity .3s', 'opacity:1',
    ].join(';');
    document.body.appendChild(label);
  }

  const index = ['tracked', 'os', 'closed'].indexOf(mode) + 1;
  label.textContent = index + '  ' + mode;
  label.style.opacity = '1';

  // Fades rather than persists: it is a confirmation of a keystroke, and a
  // permanent badge on a desktop companion would be its own annoyance.
  clearTimeout(label.dataset.timer);
  label.dataset.timer = String(setTimeout(() => { label.style.opacity = '0'; }, 1600));
});

/**
 * Asks the server which pet belongs on screen.
 *
 * The endpoint is the same resolver the app uses, so the desktop pet and
 * the app can never disagree about who is active. A failed poll leaves the
 * current pet alone rather than blanking it: the server restarting should not
 * make the companion vanish.
 */
async function poll() {
  try {
    const response = await fetch('/api/pets/display', { headers: { accept: 'application/json' } });
    if (!response.ok) return;
    const payload = await response.json();
    await render(payload.pet ?? null);
  } catch {
    // Offline, or the server is restarting. Keep drawing whatever we have.
  }
}

void poll();
setInterval(() => {
  // Never mid-drag: a poll that lands during a gesture can only cost frames.
  if (!dragging) void poll();
}, POLL_MS);
</script>
</body>
</html>`;
}
