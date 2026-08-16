/**
 * Safety rails for throwaway Electron scripts.
 *
 * Required first, before `electron` is used for anything:
 *
 *     const { HIDDEN_WINDOW, armWatchdog } = require('./harness-guard.cjs');
 *
 * ## Why this is a committed file rather than a recipe
 *
 * Diagnosing the desktop pet means driving a real Electron window on the
 * developer's own machine, and a one-off script has two ways to make that
 * their problem: an uncaught exception in the main process opens a **native
 * modal error dialog** in front of whatever they are doing, and a window
 * created without care appears on their desktop and takes focus. Both have
 * happened. Neither should depend on the next person remembering the recipe,
 * so the recipe lives here.
 *
 * It is dev-only scaffolding. Nothing the app ships requires it, and it is safe
 * to delete once nobody is writing pet harnesses — but while they are, this is
 * the file to require rather than a paragraph in a report to re-implement.
 */
const { app, dialog } = require('electron');

/**
 * Turns Electron's modal crash dialog into a line on stdout.
 *
 * The dialog is the specific failure this guard exists for: it is modal, it is
 * on top, and on a machine someone is working on it is an interruption caused
 * by a debugging script they did not run.
 */
dialog.showErrorBox = (title, content) => {
  console.log('SUPPRESSED ERROR BOX:', title, '|', content);
};

const die = (label) => (error) => {
  console.log(`HARNESS ${label}:`, (error && error.stack) || error);
  try {
    app.exit(1);
  } catch {
    process.exit(1);
  }
};

process.on('uncaughtException', die('uncaughtException'));
process.on('unhandledRejection', die('unhandledRejection'));

/**
 * Window options every harness window should spread.
 *
 * Never shown, never focused, never in the taskbar — a measurement must not
 * steal a keystroke or flash a window. `paintWhenInitiallyHidden` keeps layout
 * and paint running so `getComputedStyle` and `capturePage` still work.
 *
 * One thing to know when reading results from a hidden window: **CSS
 * transitions do not advance in it**, so a transitioned property reads as its
 * start value forever. Measure the inline value, use a transition-free element,
 * or emulate `prefers-reduced-motion`.
 */
const HIDDEN_WINDOW = {
  show: false,
  paintWhenInitiallyHidden: true,
  focusable: false,
  skipTaskbar: true,
};

/**
 * Exits after `ms` no matter what.
 *
 * A harness that hangs holds an invisible Electron process open, which is worse
 * than one that fails: nobody can see it to close it.
 */
function armWatchdog(ms = 45000) {
  const timer = setTimeout(() => {
    console.log('HARNESS watchdog: forcing exit');
    app.exit(2);
  }, ms);
  timer.unref?.();
}

module.exports = { HIDDEN_WINDOW, armWatchdog };
