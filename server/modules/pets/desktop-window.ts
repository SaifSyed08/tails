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

/**
 * Room above the sprite for a speech bubble, in CSS pixels.
 *
 * Only claimed while he has something to say — an empty window twice the height
 * of the pet is a bigger click-through hole for no reason — so the window grows
 * upward when a chat finishes and shrinks back when it is dealt with. Growth is
 * anchored to his feet in the shell, so this appears above him without moving
 * him.
 */
const BUBBLE_BAND = 44;

/** The widest the bubble may be, in CSS pixels. Titles are ellipsised into it. */
const BUBBLE_MAX_WIDTH = 210;

/**
 * How often he jumps while a chat is waiting, and for how long, in ms.
 *
 * A repeated gesture with a pause between reads as "over here"; a continuous
 * one reads as broken. Roughly one hop every four seconds is about the cadence
 * of someone tapping you on the shoulder rather than shaking you.
 */
const ALERT_JUMP_EVERY_MS = 4200;
const ALERT_JUMP_MS = 1100;

/** How far outside an opaque pixel still counts as "on the pet", in cell pixels. */
const HIT_TOLERANCE = 6;

/**
 * How much of the artwork's edge stays out of the drag region, in cell pixels.
 *
 * This is the whole design, so it is worth stating plainly: **everything inside
 * this rim is draggable, and the rim itself is what makes that possible.**
 *
 * A drag region does not deliver mouse events to the page, and the page
 * reporting "the pointer is on the pet" is the only thing that makes this
 * window stop ignoring the mouse. So the pet needs a part of himself that still
 * *receives events* — not a part that lacks a menu, which is what an earlier
 * comment here claimed and was never the point. Approach him from any
 * direction and the pointer crosses ordinary, event-receiving pet before it
 * reaches the region that swallows them.
 *
 * 10 cell pixels is about 6 CSS pixels at his usual size, and the shell's
 * pointer poll is a second route in behind it — see `startWatchdog` — which is
 * what makes a rim this thin safe and lets the grabbable area be this large.
 */
const HANDLE_RIM = 10;

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
   * The pet's body is deliberately NOT a drag region. Read this before
   * "simplifying" it into one.
   *
   * This window ignores the mouse — setIgnoreMouseEvents(true, forward) — and
   * only becomes interactive when the *page* reports that the pointer has
   * arrived on his opaque pixels. The page learns that from a mousemove.
   *
   * An element with -webkit-app-region: drag does not deliver mouse events to
   * the page. So making the whole sprite draggable deadlocks: no moves over him,
   * therefore no arrival reported, therefore the window keeps ignoring the
   * mouse, therefore it is never hit-tested, therefore the drag region is never
   * reached. It cannot recover, and it looks exactly like a pet who cannot be
   * picked up at all — which is what it was.
   *
   * So the body reports, and a band at his scruff drags. The band works
   * *because* the rest of him does not.
   */
  #pet {
    background-repeat: no-repeat;
    image-rendering: pixelated;
    /* Grabbing is the only gesture, and the cursor is the only affordance a
       window with no chrome can offer. */
    cursor: grab;
    transition: filter 120ms ease-out;
  }

  /** The one place the OS may start a window move. See the note above. */
  #handle {
    position: absolute;
    -webkit-app-region: drag;
    cursor: grab;
  }

  /* No shadow while carried. The window is transparent and sits over whatever
     is behind it, so a drop shadow is a grey smudge following the pointer
     across the desktop rather than a sense of depth. */
  #pet.dragging { cursor: grabbing; }

  #pet.mirrored { transform: scaleX(-1); }

  #stage, #pet, #pill, #bubble { -webkit-app-region: no-drag; }

  /*
   * What he holds up when a conversation has finished.
   *
   * A real control, not an overlay: the text is a button that opens the chat,
   * because an alert whose only exit is "go and find the thing yourself" is a
   * bad neighbour. The X beside it is for when you know and do not care yet.
   *
   * It lives above him in room the window only claims while this is up — see
   * BUBBLE_BAND — and it is no-drag, so pressing it cannot start a window move.
   */
  #bubble {
    position: absolute;
    display: none;
    align-items: stretch;
    max-width: ${BUBBLE_MAX_WIDTH}px;
    box-sizing: border-box;
    border-radius: 10px;
    background: rgba(16, 16, 18, 0.96);
    box-shadow: inset 0 0 0 1px rgba(148, 148, 156, 0.5), 0 6px 16px rgba(0, 0, 0, 0.35);
    color: rgba(255, 255, 255, 0.96);
    font: 500 12px/1.25 system-ui, -apple-system, "Segoe UI", sans-serif;
    overflow: hidden;
    opacity: 0;
    transform: translateY(4px);
    transition: opacity 160ms cubic-bezier(0.2, 0, 0, 1),
                transform 160ms cubic-bezier(0.2, 0, 0, 1);
  }

  #bubble.up { opacity: 1; transform: translateY(0); }

  #bubble button {
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    padding: 7px 9px;
  }

  #bubble-open {
    flex: 1 1 auto;
    min-width: 0;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  #bubble-more {
    flex: 0 0 auto;
    align-self: center;
    margin-right: 2px;
    padding: 1px 6px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.16);
    font-size: 10px;
  }

  #bubble-close {
    flex: 0 0 auto;
    padding: 7px 8px 7px 4px;
    color: rgba(255, 255, 255, 0.6);
  }

  #bubble button:hover { background: rgba(255, 255, 255, 0.14); }
  #bubble-close:hover { color: rgba(255, 255, 255, 0.95); }

  @media (prefers-reduced-motion: reduce) {
    #bubble { transition: none; }
  }

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
    background: rgba(16, 16, 18, 0.94);
    color: rgba(255, 255, 255, 0.94);
    /*
     * One easing for every property that moves, including the ones set from
     * script. The pill's box is re-placed by placePill when it opens — width,
     * height *and* position all change at once — and animating only two of the
     * four made it jump sideways and then grow, which is the jank. An ease-out
     * over 120ms also lands hard; this is the standard soft stop.
     */
    transition: width 180ms cubic-bezier(0.2, 0, 0, 1),
                height 180ms cubic-bezier(0.2, 0, 0, 1),
                left 180ms cubic-bezier(0.2, 0, 0, 1),
                top 180ms cubic-bezier(0.2, 0, 0, 1),
                opacity 180ms cubic-bezier(0.2, 0, 0, 1),
                box-shadow 180ms cubic-bezier(0.2, 0, 0, 1);
    overflow: hidden;
  }

  /* A hairline so the open pill reads as a control rather than as a smudge.
     Inset, so it cannot change the box the transition is animating. */
  #pill.open { box-shadow: inset 0 0 0 1px rgba(148, 148, 156, 0.55); }

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
<div id="stage"><div id="pet" role="img" aria-label="Desktop pet"></div><div id="handle"></div><div id="bubble"><button id="bubble-open" type="button"></button><span id="bubble-more" hidden></span><button id="bubble-close" type="button" aria-label="Dismiss">×</button></div><div id="pill"><button id="pill-settings" type="button" aria-label="Pet details" title="Pet details"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9h-.2a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.4-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1A1.7 1.7 0 0 0 10 3.1V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"></path></svg></button><button id="pill-hide" type="button" aria-label="Hide pet" title="Hide pet"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg></button></div></div>
<script type="module" nonce="${nonce}">
const POLL_MS = ${POLL_MS};
const PET_HEIGHT = ${PET_HEIGHT};
const PADDING = ${PADDING};
const BUBBLE_BAND = ${BUBBLE_BAND};
const BUBBLE_MAX_WIDTH = ${BUBBLE_MAX_WIDTH};
const ALERT_JUMP_EVERY_MS = ${ALERT_JUMP_EVERY_MS};
const ALERT_JUMP_MS = ${ALERT_JUMP_MS};
const HIT_TOLERANCE = ${HIT_TOLERANCE};
const HANDLE_RIM = ${HANDLE_RIM};
const ACTIVE_RATE = ${ACTIVE_RATE};
const RESTING_RATES = ${JSON.stringify(RESTING_RATES)};

const bridge = window.petBridge ?? {
  reportVisibility() {}, reportSize() {}, reportPointerOverPet() {},
  openDetails() {}, hidePet() {},
  onFacing() {}, onRefresh() {}, onCarry() {}, onResync() {}, onProbe() {},
  onAlert() {}, openAlert() {}, dismissAlert() {},
};

/**
 * Everything this page believes, written onto the sprite as data attributes.
 *
 * Not for styling — for looking at. The page's state lives in module scope
 * where nothing outside can reach it, and "the window is visible but not
 * usable" has now been reached from four different directions, each time
 * needing a guess about which of these was wrong. Written down, they can be
 * asserted from a harness in one read, and the invariant they add up to can be
 * tested per entry path rather than per bug.
 *
 * The pet and the mask are stamped separately on purpose: the mask is what
 * decides where he
 * can be grabbed, and a mask built for a *different* pet is a grab region over
 * the wrong shape. Nothing used to compare them.
 */
function publishState() {
  pet.dataset.pet = current ? current.definition.id : '';
  pet.dataset.mask = mask ? maskFor : '';
  pet.dataset.carry = dragging ? '1' : '';
  pet.dataset.over = pointerOver ? '1' : '';
  pet.dataset.handle = handle.style.display === 'block' ? '1' : '';
}

const stage = document.getElementById('stage');
const pet = document.getElementById('pet');
const handle = document.getElementById('handle');
const pill = document.getElementById('pill');
const bubble = document.getElementById('bubble');
const bubbleOpen = document.getElementById('bubble-open');
const bubbleMore = document.getElementById('bubble-more');
const bubbleClose = document.getElementById('bubble-close');
const pillSettings = document.getElementById('pill-settings');
const pillHide = document.getElementById('pill-hide');

/** The pill's two sizes, in CSS pixels: a sliver, and two buttons. */
const PILL_CLOSED_H = 5;
const PILL_OPEN_H = 22;
const PILL_OPEN_W = 56;

let current = null;      // the pet payload currently rendered
let box = null;          // its cell geometry
let mask = null;         // union alpha mask of the played frames, at cell resolution
let maskFor = '';        // the pet that mask was built for, which must be the one on screen
let dragging = false;
let pointerOver = false;
let playing = null;      // the state name currently animating
let petRect = null;      // cached sprite box; invalidated on resize and re-render
let facing = 'right';
let scale = 1;           // the user's own size for this pet
let alert = null;        // the chat waiting to be read, or null
let alertJumpTimer = null;

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
    maskFor = '';
    petRect = null;
    pet.style.display = 'none';
    bridge.reportVisibility(false);
    publishState();
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
    reportSize();
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
  await rebuildMask(next);
}

/**
 * Builds the alpha map that decides where he can be grabbed.
 *
 * Separate from rendering because it is also what a resync asks for: the sheet
 * loads asynchronously, so a pet swapped mid-load can leave this page holding a
 * grab region shaped like the previous animal, and the fix for that is to be
 * able to say "build one for *this* pet" from outside the render.
 *
 * A failure here is not cosmetic — it is a pet with no grab region — so it
 * falls back to no mask at all, which the hit test reads as "his whole box",
 * rather than to a wrong one.
 */
async function rebuildMask(subject) {
  try {
    const image = await loadImage(subject.spriteUrl);
    mask = buildHitMask(image, subject.definition.frame, subject.definition.states.idle);
    // Stamped with whose mask it is, so the mismatch above is detectable at all.
    maskFor = subject.definition.id;
    placeFurniture();
  } catch {
    mask = null;
    maskFor = '';
  }
  publishState();
}

/**
 * Asks the shell for exactly as much window as he currently needs.
 *
 * Which is not a constant: the bubble is only up sometimes, and the room for it
 * is only worth having then. The shell grows the window from his feet, so this
 * changing does not move him.
 */
function reportSize() {
  if (!box) return;
  const width = Math.max(
    Math.ceil(box.cellWidth) + PADDING * 2,
    alert ? BUBBLE_MAX_WIDTH + PADDING * 2 : 0,
  );
  const height = Math.ceil(box.cellHeight) + PADDING * 2 + (alert ? BUBBLE_BAND : 0);
  bridge.reportSize(width, height);
}

/**
 * Finds the artwork inside the cell, and hangs the furniture off it.
 *
 * The bounding box of the opaque pixels, from the same mask the hit-test uses,
 * so what you can see, what you can grab and what the pill is centred on cannot
 * disagree. The cell has transparent margins — a band or a pill placed from the
 * *cell* sits beside the animal rather than on him.
 */
function placeFurniture() {
  if (!mask || !box) {
    handle.style.display = 'none';
    publishState();
    pill.style.display = 'none';
    // The bubble still goes up. A pet whose mask failed to build is a pet with
    // no grab region and no pill, which is bad enough — silently swallowing the
    // notification as well would mean a chat that finished and never said so.
    if (box) placeBubble(pet.getBoundingClientRect(), stage.getBoundingClientRect(), 0, box.cellWidth / box.scale - 1, 0);
    return;
  }

  let minX = mask.width;
  let maxX = -1;
  let minY = mask.height;
  let maxY = -1;

  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if (!mask.bytes[y * mask.width + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) {
    handle.style.display = 'none';
    pill.style.display = 'none';
    return;
  }

  const rect = pet.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  placeHandle(rect, stageRect, minX, maxX, minY, maxY);
  placePill(rect, stageRect, minX, maxX, maxY);
  placeBubble(rect, stageRect, minX, maxX, minY);
}

/**
 * Makes almost all of him draggable, inside a rim that is not.
 *
 * The grabbable area is his opaque bounding box less HANDLE_RIM on every side
 * — roughly three quarters of him by area, and the whole of his middle. It was
 * a shallow band across his shoulders, which worked but had to be aimed at.
 *
 * The rim is not decoration and must not be trimmed to nothing: see the note on
 * HANDLE_RIM, and the one above the sprite in the stylesheet.
 */
function placeHandle(rect, stageRect, minX, maxX, minY, maxY) {
  const left = rect.left - stageRect.left + (minX + HANDLE_RIM) * box.scale;
  const top = rect.top - stageRect.top + (minY + HANDLE_RIM) * box.scale;
  const width = (maxX - minX + 1 - HANDLE_RIM * 2) * box.scale;
  const height = (maxY - minY + 1 - HANDLE_RIM * 2) * box.scale;

  // A pet drawn too small for a rim and a region both is a pet with no handle
  // rather than a pet who is all handle: the deadlock the rim prevents is worse
  // than a grab that has to be aimed.
  if (width < 12 || height < 10) {
    handle.style.display = 'none';
    return;
  }

  handle.style.display = 'block';
  handle.style.left = left + 'px';
  handle.style.top = top + 'px';
  handle.style.width = width + 'px';
  handle.style.height = height + 'px';
  publishState();
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
  // Visible at rest rather than a ghost: it is the only thing on screen that
  // says he has controls at all.
  pill.style.opacity = open ? '1' : '0.85';
}

/**
 * Puts the bubble above his head, and keeps it inside the window.
 *
 * Centred on the artwork rather than on the cell for the same reason the pill
 * is, and clamped horizontally because a long chat name makes a bubble wider
 * than the pet is: at the edges it slides along rather than hanging off.
 */
function placeBubble(rect, stageRect, minX, maxX, minY) {
  if (!alert) {
    bubble.style.display = 'none';
    bubble.classList.remove('up');
    return;
  }

  bubble.style.display = 'flex';
  // Read after display, and before the position is set: the width depends on
  // the text, which is the thing that just changed.
  const width = bubble.getBoundingClientRect().width;
  const artworkWidth = (maxX - minX + 1) * box.scale;
  const centre = rect.left - stageRect.left + minX * box.scale + artworkWidth / 2;
  const head = rect.top - stageRect.top + minY * box.scale;

  bubble.style.left = Math.round(
    Math.max(2, Math.min(stageRect.width - width - 2, centre - width / 2)),
  ) + 'px';
  bubble.style.top = Math.round(Math.max(2, head - bubble.getBoundingClientRect().height - 6)) + 'px';

  // Raised on the frame after it is placed, so it fades in where it belongs
  // rather than sliding across from wherever it was last time.
  requestAnimationFrame(() => bubble.classList.add('up'));
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
  publishState();

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

  // And so does the bubble, for exactly the same reason: it is above his head,
  // over nothing, and a notification you cannot click is a worse notification
  // than none.
  if (alert) {
    const box3 = bubble.getBoundingClientRect();
    if (box3.width > 0 && clientX >= box3.left && clientX <= box3.right
      && clientY >= box3.top && clientY <= box3.bottom) {
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
  publishState();

  // Noticed. He stops hopping while you are pointing at him, and picks it up
  // again if you wander off without reading the chat.
  if (alert && !next) setAlertJumping();
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
 * A conversation has finished, or has been dealt with.
 *
 * The shell decides *whether* he should say anything — it is the only side that
 * knows if the window is in front of the user — so this is only the saying: put
 * the bubble up, ask for the room to put it in, and start the jumping.
 */
bridge.onAlert((next) => {
  const had = Boolean(alert);
  alert = next && next.sessionId ? next : null;

  if (alert) {
    bubbleOpen.textContent = alert.text;
    bubbleOpen.title = alert.text;
    bubbleMore.hidden = alert.others < 1;
    bubbleMore.textContent = alert.others > 0 ? '+' + alert.others : '';
  } else {
    bubble.classList.remove('up');
  }

  // The window has to change height for the bubble to have anywhere to be, and
  // the furniture is placed against the *new* box — so the order is: ask, let
  // the resize land, then place.
  if (had !== Boolean(alert)) reportSize();
  requestAnimationFrame(() => placeFurniture());
  setAlertJumping();
});

/**
 * Jumping, with pauses.
 *
 * The pauses are the whole difference between "over here" and "something is
 * wrong with the pet". Suspended while he is being carried or pointed at,
 * because both mean the user has already noticed him, and skipped entirely
 * under reduced motion — the bubble says the same thing without moving.
 */
function setAlertJumping() {
  if (alertJumpTimer) {
    clearInterval(alertJumpTimer);
    alertJumpTimer = null;
  }
  if (!alert || reduced) return;

  const hop = () => {
    if (dragging || pointerOver) return;
    playState('jumping');
    setTimeout(() => {
      if (!dragging && !pointerOver) playState('idle');
    }, ALERT_JUMP_MS);
  };

  hop();
  alertJumpTimer = setInterval(hop, ALERT_JUMP_EVERY_MS);
}

bubbleOpen.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (alert) bridge.openAlert(alert.sessionId);
});

bubbleClose.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (alert) bridge.dismissAlert(alert.sessionId);
});

/*
 * The shell asking, instead of the pointer telling.
 *
 * Same test, same reporting path, different trigger — see the note on the drag
 * band in the stylesheet for why a mousemove cannot be relied on to arrive.
 * This is a poll, so it is the slower of the two: the mousemove path answers
 * immediately and this one catches what it misses.
 */
bridge.onProbe((point) => {
  if (dragging || !point) return;
  setPointerOver(isOverPet(point.x, point.y));
});

/**
 * Forget everything about the pointer.
 *
 * Sent when the window is shown after being hidden. Both of these beliefs are
 * unfalsifiable from in here once they are wrong: a stale "the pointer is on
 * the pet" means the arrival is never re-reported, so the shell never makes the
 * window clickable, and a stale "he is being carried" means this page stops
 * tracking the pointer at all. Either one is a pet nobody can pick up.
 */
bridge.onResync((state) => {
  /*
   * Re-derive everything about input from what is actually true now.
   *
   * The shell sends this whenever it shows him and whenever it takes
   * click-through back by itself, and it says whether a carry is live — that is
   * its fact, not this page's. Believing it, rather than the shell skipping the
   * message to protect a carry, is what stops this page going on believing it
   * is being carried long after the hand let go. A page that believes that
   * ignores every mouse move, which is half of an unusable pet.
   */
  dragging = Boolean(state && state.carrying);
  pointerOver = false;
  petRect = null;
  pet.classList.toggle('dragging', dragging);
  pill.classList.remove('open');
  bridge.reportPointerOverPet(false);

  /*
   * And re-derive the geometry if it belongs to somebody else.
   *
   * The mask decides where he can be grabbed, and it is built from an image
   * that loads asynchronously — so a pet swapped while the previous sheet was
   * still loading can leave this page holding a grab region shaped like the
   * wrong animal. Nothing used to check that; now every show does.
   */
  if (current && (!mask || maskFor !== current.definition.id)) void rebuildMask(current);
  else placeFurniture();

  if (!dragging) playState('idle');
  publishState();
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
