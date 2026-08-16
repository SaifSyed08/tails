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

/**
 * How fast each animation plays, relative to the rate its sheet was drawn at.
 *
 * Mirrored from `sprite-rate.ts`, which this page cannot import — see the
 * reasoning there. In short: moments (running, jumping, waving) are brisk
 * because you are watching them; resting states are what is on screen all day
 * beside someone who is trying to read, and a fast idle reads as agitated.
 */
const ACTIVE_RATE = 1.35;
const RESTING_RATES: Record<string, number> = { idle: 0.85, waiting: 1 };

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

  /*
   * The pet is the handle.
   *
   * The whole sprite is the OS drag region. It used to be a band across the top
   * of him, with the rest marked no-drag so that right-clicking the body could
   * reach the page — and that split never reliably worked: a narrow strip
   * placed from a measured alpha bounding box, sitting over a no-drag element,
   * recomputed on hover and after every resize. Dropping right-click from the
   * pet removed the only reason for the split, so there is no strip to place,
   * nothing to be topmost over, and the target is the animal himself.
   *
   * The pill is the way to his options now, and it is marked no-drag below.
   */
  #pet {
    background-repeat: no-repeat;
    image-rendering: pixelated;
    -webkit-app-region: drag;
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

  #stage, #pill { -webkit-app-region: no-drag; }

  /*
   * The pill: a way into the pet's menu that you can see.
   *
   * Right-clicking was the only way to reach it, and a right-click is invisible
   * — nothing on screen said the menu existed. This is the visible half of the
   * same door: a dark sliver under his feet that grows into one button when you
   * point at him. Right-click still works.
   *
   * It has to live inside the alpha hit-test's idea of "on the pet", or the
   * window stays click-through underneath it and the button can never be
   * pressed. See isOverPet.
   */
  #pill {
    position: absolute;
    display: none;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    border-radius: 999px;
    background: rgba(16, 16, 18, 0.82);
    color: rgba(255, 255, 255, 0.92);
    transition: height 120ms ease-out, width 120ms ease-out, opacity 120ms ease-out;
    overflow: hidden;
  }

  #pill button {
    height: 100%;
    flex: 1 1 0;
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    cursor: pointer;
    opacity: 0;
    /* Unreachable until the pill has actually opened, so a collapsed sliver
       cannot swallow a click meant for the desktop behind it. */
    pointer-events: none;
    transition: opacity 120ms ease-out;
  }

  #pill.open button { opacity: 1; pointer-events: auto; }
  #pill button:hover { background: rgba(255, 255, 255, 0.16); }
  #pill button svg { display: block; }

  @media (prefers-reduced-motion: reduce) {
    #pill, #pill button { transition: none; }
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
<div id="stage"><div id="pet" role="img" aria-label="Desktop pet"></div><div id="pill"><button id="pill-settings" type="button" aria-label="Pet details" title="Pet details"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9h-.2a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.4-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1A1.7 1.7 0 0 0 10 3.1V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"></path></svg></button><button id="pill-hide" type="button" aria-label="Hide pet" title="Hide pet"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg></button></div></div>
<script type="module" nonce="${nonce}">
const POLL_MS = ${POLL_MS};
const PET_HEIGHT = ${PET_HEIGHT};
const PADDING = ${PADDING};
const HIT_TOLERANCE = ${HIT_TOLERANCE};
const ACTIVE_RATE = ${ACTIVE_RATE};
const RESTING_RATES = ${JSON.stringify(RESTING_RATES)};

const bridge = window.petBridge ?? {
  reportVisibility() {}, reportSize() {}, reportPointerOverPet() {},
  openDetails() {}, hidePet() {},
  onFacing() {}, onRefresh() {}, onCarry() {}, onResync() {},
};

const stage = document.getElementById('stage');
const pet = document.getElementById('pet');
const pill = document.getElementById('pill');
const pillSettings = document.getElementById('pill-settings');
const pillHide = document.getElementById('pill-hide');

/** The pill's two sizes, in CSS pixels: a sliver, and two buttons. */
const PILL_CLOSED_H = 5;
const PILL_OPEN_H = 22;
const PILL_OPEN_W = 56;

let current = null;      // the pet payload currently rendered
let box = null;          // its cell geometry
let mask = null;         // union alpha mask of the played frames, at cell resolution
let dragging = false;
let pointerOver = false;
let playing = null;      // the state name currently animating
let petRect = null;      // cached sprite box; invalidated on resize and re-render
let facing = 'right';
let scale = 1;           // the user's own size for this pet

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

function applyAnimation(grid, range, stateName) {
  const start = range.start;
  const end = range.end;
  const frameCount = end - start + 1;
  const startColumn = start % grid.columns;
  const startRow = Math.floor(start / grid.columns);
  const rowSpan = Math.floor(end / grid.columns) - startRow + 1;
  const framesPerSweep = rowSpan === 1 ? frameCount : grid.columns;
  const fps = (range.fps ?? grid.fps ?? 8) * (RESTING_RATES[stateName] ?? ACTIVE_RATE);

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
  applyAnimation(current.definition.frame, resolved.range, resolved.name);
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

  // His size is the user's, set from the pill's panel. Clamped here as well as
  // on the server: it decides how big a window we ask for, and this page is the
  // one thing standing between a stored number and the whole screen.
  const wanted = Number(next.stage && next.stage.scale);
  const nextScale = Number.isFinite(wanted) ? Math.min(2, Math.max(0.6, wanted)) : 1;
  const scaleChanged = Math.abs(nextScale - scale) > 0.001;
  scale = nextScale;

  current = next;
  box = resolveCellBox(grid, PET_HEIGHT * scale);
  pet.style.display = 'block';

  if (changed || scaleChanged) {
    pet.style.backgroundImage = 'url(' + next.spriteUrl + ')';
    bridge.reportSize(
      Math.ceil(box.cellWidth) + PADDING * 2,
      Math.ceil(box.cellHeight) + PADDING * 2,
    );
    bridge.reportVisibility(true);
  }

  if ((changed || statesChanged || scaleChanged) && !dragging && !pointerOver) {
    playing = null;
    playState('idle');
  }

  if (scaleChanged) petRect = null;

  if (!changed && mask) {
    placeFurniture();
    return;
  }

  petRect = null;

  // The mask is what makes the window clickable in the right places, so a
  // failure here is not cosmetic: fall back to the sprite's whole box rather
  // than leaving the pet ungrabbable.
  try {
    const image = await loadImage(next.spriteUrl);
    mask = buildHitMask(image, grid, idle);
    placeFurniture();
  } catch {
    mask = null;
  }
}

/**
 * Finds the artwork inside the cell, and hangs the pill off it.
 *
 * The bounding box of the opaque pixels, from the same mask the hit-test uses,
 * so what you can see, what you can grab and what the pill is centred on cannot
 * disagree. The cell has transparent margins — a pill centred on the *cell*
 * sits off to one side of the animal.
 */
function placeFurniture() {
  if (!mask || !box) {
    pill.style.display = 'none';
    return;
  }

  let minX = mask.width;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if (!mask.bytes[y * mask.width + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) {
    pill.style.display = 'none';
    return;
  }

  placePill(pet.getBoundingClientRect(), stage.getBoundingClientRect(), minX, maxX, maxY);
}

/**
 * Puts the pill under the pet's feet.
 *
 * Centred on the artwork rather than on the cell, because the cell has
 * transparent margins and a pill centred on those would sit off to one side of
 * him. Clamped inside the stage: the window is only the sprite plus a little
 * padding, and anything past the edge is clipped away rather than overflowing
 * onto the desktop, so the open pill overlaps his feet a little instead of
 * being cut in half.
 */
function placePill(rect, stageRect, minX, maxX, maxY) {
  const open = pill.classList.contains('open');
  const height = open ? PILL_OPEN_H : PILL_CLOSED_H;
  const artworkWidth = (maxX - minX + 1) * box.scale;
  const width = open ? PILL_OPEN_W : Math.max(18, artworkWidth * 0.45);

  const centre = rect.left - stageRect.left + (minX * box.scale) + artworkWidth / 2;
  const feet = rect.top - stageRect.top + (maxY + 1) * box.scale;

  pill.style.display = 'flex';
  pill.style.width = width + 'px';
  pill.style.height = height + 'px';
  pill.style.left = Math.round(centre - width / 2) + 'px';
  pill.style.top = Math.round(
    Math.min(feet + 2, stageRect.height - height),
  ) + 'px';
  pill.style.opacity = open ? '1' : '0.55';
}

/** Where the pill is on screen, or null when it is not shown. */
function pillRect() {
  if (!pill.style.display || pill.style.display === 'none') return null;
  return pill.getBoundingClientRect();
}

/**
 * The shell says when the pet is being carried.
 *
 * There is no mousedown to react to any more — the OS runs the move, and the
 * only signal is the window changing position. The running animation and the
 * facing both hang off that.
 */
let carryFloor = null;

bridge.onCarry((isCarrying) => {
  dragging = isCarrying;

  /*
   * A carry that is never called off.
   *
   * While this page believes it is being carried it stops looking at the
   * pointer entirely, so a lost or delayed end-of-carry is not a cosmetic
   * problem: it is a pet who can never be picked up again. The shell always
   * sends the end — but "always" is exactly the assumption that has cost this
   * feature the most, so there is a floor under it.
   */
  if (carryFloor) clearTimeout(carryFloor);
  carryFloor = isCarrying
    ? setTimeout(() => {
      carryFloor = null;
      dragging = false;
      pointerOver = false;
      pet.classList.remove('dragging');
      playState('idle');
    }, 4000)
    : null;

  // Nothing to press while he is in the air, and a button sliding around the
  // desktop under a moving window is just debris.
  pill.classList.toggle('open', !isCarrying && pointerOver);
  if (mask) placeFurniture();

  if (isCarrying) {
    pet.classList.add('dragging');
    playState(facing === 'left' ? 'running-left' : 'running-right');
    return;
  }
  pet.classList.remove('dragging');
  playState(pointerOver ? 'waving' : 'idle');
});

/** Whether a point inside the window sits on the pet's own pixels. */
function isOverPet(clientX, clientY) {
  if (!box) return false;

  // The open pill counts as part of him. It sits below his feet, over
  // transparent pixels, so without this the window is click-through exactly
  // where the button is and the button can never be pressed. Only when open:
  // a closed sliver is decoration, and making it grabbable would have the pet
  // notice you from a few pixels below his feet.
  if (pill.classList.contains('open')) {
    const box2 = pillRect();
    if (box2 && clientX >= box2.left && clientX <= box2.right
      && clientY >= box2.top && clientY <= box2.bottom) {
      return true;
    }
  }

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

  pill.classList.toggle('open', next && !dragging);
  placeFurniture();
}

document.addEventListener('mousemove', (event) => {
  if (dragging) return;
  setPointerOver(isOverPet(event.clientX, event.clientY));
});

/*
 * The pointer left the window in one movement.
 *
 * Fast enough and the last move we see is still on the pet, so without this the
 * page goes on believing the pointer is there — and because it only reports
 * *changes*, it would never report the next arrival either. The shell has a
 * watchdog behind this, and now tells us when it fires; this is the cheap half.
 */
/*
 * The window changed size, so everything measured from it is now wrong.
 *
 * Two things are cached against the old layout: the sprite's box, which the
 * hit-test consults on every forwarded mouse move, and the drag handle's
 * position. Neither is re-derived anywhere else — the poll re-places the handle
 * but never invalidates the box — so a resize that lands after the first render
 * leaves the pet permanently ungrabbable: the pointer is over him, and the
 * rectangle being consulted says it is not.
 *
 * The one resize that always happens is the first one, when the page tells the
 * shell how big it needs to be.
 */
window.addEventListener('resize', () => {
  petRect = null;
  if (mask) placeFurniture();
});

document.addEventListener('mouseleave', () => {
  if (dragging) return;
  setPointerOver(false);
});

/*
 * No right-click on the pet, deliberately.
 *
 * It was the only reason the sprite could not simply *be* the drag region, and
 * that split — a narrow drag strip over a no-drag body — is what has never
 * worked reliably. A page-level handler on a drag region is also a way to
 * swallow the gesture the OS was about to take. The pill is the way in now, and
 * it is a visible one, which the right-click never was.
 */
document.addEventListener('contextmenu', (event) => event.preventDefault());

/*
 * The pill's two buttons.
 *
 * Details opens the pet's panel in the app, which is where anything worth
 * saying about a pet already lives; the X puts him away. Two, because those are
 * the two things you want from a companion standing on your desktop, and a menu
 * of one item to reach either of them was the "lame list of options".
 */
pillSettings.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (current) bridge.openDetails(current.definition.id);
});

pillHide.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  bridge.hidePet();
});

bridge.onFacing((next) => {
  facing = next;
  // A real row per direction, so this is a state change and not a flip.
  if (dragging) playState(next === 'left' ? 'running-left' : 'running-right');
});
bridge.onRefresh(() => void poll());

/**
 * Forget everything about the pointer.
 *
 * Sent when the window is shown after being hidden. Both of these beliefs are
 * unfalsifiable from in here once they are wrong: a stale "the pointer is on
 * the pet" means the arrival is never re-reported, so the shell never makes the
 * window clickable, and a stale "he is being carried" means this page stops
 * tracking the pointer at all. Either one is a pet nobody can pick up.
 */
bridge.onResync(() => {
  dragging = false;
  pointerOver = false;
  petRect = null;
  pet.classList.remove('dragging');
  pill.classList.remove('open');
  bridge.reportPointerOverPet(false);
  if (mask) placeFurniture();
  playState('idle');
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
