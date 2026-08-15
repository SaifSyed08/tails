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

  #pet.dragging {
    cursor: grabbing;
    filter: drop-shadow(0 6px 10px rgba(0, 0, 0, 0.35));
  }

  #pet.mirrored { transform: scaleX(-1); }

  /* The carried-pet motion for sheets with no walk row. Transform only, so it
     never costs a layout, and spelled out twice rather than composed, because a
     second transform would replace the mirror instead of adding to it. */
  #pet.bobbing { animation-name: tails-sprite-x, tails-pet-bob; }
  #pet.bobbing.mirrored { animation-name: tails-sprite-x, tails-pet-bob-mirrored; }

  @keyframes tails-pet-bob {
    0%, 100% { transform: translateY(0) rotate(-2deg); }
    50% { transform: translateY(-6px) rotate(2deg); }
  }

  @keyframes tails-pet-bob-mirrored {
    0%, 100% { transform: scaleX(-1) translateY(0) rotate(-2deg); }
    50% { transform: scaleX(-1) translateY(-6px) rotate(2deg); }
  }

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
  startDrag() {}, endDrag() {}, openMenu() {},
  onFacing() {}, onRefresh() {},
};

const stage = document.getElementById('stage');
const pet = document.getElementById('pet');

let current = null;      // the pet payload currently rendered
let ranges = null;       // the idle/walk ranges the server decided
let box = null;          // its cell geometry
let mask = null;         // union alpha mask of the played frames, at cell resolution
let dragging = false;
let pointerOver = false;

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
 * Scans the sheet once: which cell pixels are opaque, per frame.
 *
 * Returns both the per-frame emptiness (for trimming a ragged row's blank tail)
 * and the union mask over the played range (for hit-testing). Same alpha
 * threshold and stride as the app, so both surfaces agree about where the pet
 * is.
 */
function scanSheet(image, grid) {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;

  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);

  const cellWidth = canvas.width / grid.columns;
  const cellHeight = canvas.height / grid.rows;
  const used = [];

  for (let index = 0; index < grid.columns * grid.rows; index += 1) {
    const originX = Math.round((index % grid.columns) * cellWidth);
    const originY = Math.round(Math.floor(index / grid.columns) * cellHeight);
    let filled = false;

    for (let y = 0; y < cellHeight && !filled; y += 4) {
      const row = (originY + y) * canvas.width * 4;
      for (let x = 0; x < cellWidth; x += 4) {
        if (data[row + (originX + x) * 4 + 3] > 8) { filled = true; break; }
      }
    }
    used.push(filled);
  }

  return { data, canvas, cellWidth, cellHeight, used };
}

/** The union of opaque pixels across a run of frames, in cell coordinates. */
function buildMask(scan, grid, start, end) {
  const width = Math.round(scan.cellWidth);
  const height = Math.round(scan.cellHeight);
  const bytes = new Uint8Array(width * height);

  for (let frame = start; frame <= end; frame += 1) {
    const originX = Math.round((frame % grid.columns) * scan.cellWidth);
    const originY = Math.round(Math.floor(frame / grid.columns) * scan.cellHeight);

    for (let y = 0; y < height; y += 1) {
      const row = (originY + y) * scan.canvas.width * 4;
      for (let x = 0; x < width; x += 1) {
        if (scan.data[row + (originX + x) * 4 + 3] > 8) bytes[y * width + x] = 1;
      }
    }
  }

  return { bytes, width, height };
}

/** One character per cell, the shape the server stores and trims against. */
function toUsageString(used) {
  return used.map(function (filled) { return filled ? '1' : '0'; }).join('');
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
 * What a pet does while it is being carried.
 *
 * A real walk cycle if the sheet has one. Most do not — Codex labels a single
 * state, so the walk range is the idle one — and a pet that keeps standing
 * perfectly still while being dragged across the screen looks frozen rather
 * than picked up. So the fallback is motion this page can honestly produce: the
 * idle loop played faster, and a small bob-and-tilt on the sprite itself.
 * Nothing invents frames that are not in the artwork.
 */
function startWalking() {
  if (!current || !ranges) return;

  const hasWalk = !sameRange(ranges.walk, ranges.idle);
  if (hasWalk) {
    applyAnimation(current.definition.frame, ranges.walk);
    return;
  }

  const fps = (ranges.idle.fps || current.definition.frame.fps || 8) * 1.6;
  applyAnimation(current.definition.frame, { ...ranges.idle, fps: fps });
  if (!reduced) pet.classList.add('bobbing');
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('sprite failed to load'));
    image.src = url;
  });
}

/** Renders a pet, or nothing. Reports both to the shell. */
/** The ranges to play, as decided by the server. This page trims nothing. */
function readRanges(payload) {
  const states = payload.definition.states;
  const playable = payload.playable || {};
  const idle = playable.idle || states.idle;
  // A pet with no walk row is the common case — most Codex sheets label only
  // one state — and an identical walk range is how the drag code knows to move the pet
  // itself instead of pretending a second animation exists.
  const walk = playable.walk || states.walk || idle;
  return { idle: idle, walk: walk };
}

const sameRange = (left, right) => Boolean(left) && Boolean(right)
  && left.start === right.start && left.end === right.end && left.fps === right.fps;

async function render(next) {
  if (!next) {
    current = null;
    ranges = null;
    mask = null;
    pet.style.display = 'none';
    bridge.reportVisibility(false);
    return;
  }

  const grid = next.definition.frame;
  const nextRanges = readRanges(next);
  const changed = !current || current.definition.id !== next.definition.id
    || current.spriteUrl !== next.spriteUrl;
  // Re-applying an animation restarts it, so a poll that changed nothing must
  // not touch it — that is what made the pet stutter every few seconds, and
  // what quietly put the untrimmed range back after the first scan.
  const rangesChanged = !ranges || !sameRange(ranges.idle, nextRanges.idle)
    || !sameRange(ranges.walk, nextRanges.walk);

  current = next;
  ranges = nextRanges;
  box = resolveCellBox(grid, PET_HEIGHT);

  pet.style.display = 'block';

  if (changed) {
    pet.style.backgroundImage = 'url(' + next.spriteUrl + ')';
    bridge.reportSize(
      Math.ceil(box.cellWidth) + PADDING * 2,
      Math.ceil(box.cellHeight) + PADDING * 2,
    );
  }

  if (changed || rangesChanged) {
    if (!dragging) applyAnimation(grid, nextRanges.idle);
  }

  bridge.reportVisibility(true);

  if (!changed && mask) return;

  // The scan is what makes the window clickable in the right places, so a
  // failure here is not cosmetic: fall back to the sprite's whole box rather
  // than leaving the pet ungrabbable.
  try {
    const image = await loadImage(next.spriteUrl);
    const scan = scanSheet(image, grid);
    if (!scan) throw new Error('no canvas');

    mask = buildMask(scan, grid, nextRanges.idle.start, nextRanges.idle.end);

    // This window is often the only thing on screen showing the pet, so it
    // reports the measurement too. The server then hands the trimmed ranges to
    // every surface, including the marketplace.
    if (!next.hasCellUsage) {
      fetch('/api/pets/' + encodeURIComponent(next.definition.id) + '/cell-usage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ usage: toUsageString(scan.used) }),
      }).then(function () { void poll(); }).catch(function () {});
    }
  } catch {
    mask = null;
  }
}

/** Whether a point inside the window sits on the pet's own pixels. */
function isOverPet(clientX, clientY) {
  if (!box) return false;

  const rect = pet.getBoundingClientRect();
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
}

document.addEventListener('mousemove', (event) => {
  if (dragging) return;
  setPointerOver(isOverPet(event.clientX, event.clientY));
});

// Belt and braces with the shell's watchdog: whichever notices first wins, and
// the cost of noticing late is a rectangle of desktop that ignores clicks.
document.addEventListener('mouseleave', () => setPointerOver(false));
window.addEventListener('blur', () => { if (!dragging) setPointerOver(false); });

pet.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || !isOverPet(event.clientX, event.clientY)) return;
  event.preventDefault();

  dragging = true;
  pet.classList.add('dragging');
  startWalking();

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
  pet.classList.remove('dragging');
  pet.classList.remove('bobbing');
  if (ranges) applyAnimation(current.definition.frame, ranges.idle);
  bridge.endDrag();
  setPointerOver(false);
});

document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  if (!current || !isOverPet(event.clientX, event.clientY)) return;
  bridge.openMenu(current.definition.id);
});

bridge.onFacing((facing) => pet.classList.toggle('mirrored', facing === 'left'));
bridge.onRefresh(() => void poll());

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
setInterval(() => void poll(), POLL_MS);
</script>
</body>
</html>`;
}
