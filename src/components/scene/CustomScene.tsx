import { useMemo } from 'react';

/**
 * A page the agent wrote, running where it cannot reach anything.
 *
 * The one place in this app that executes model-authored code, and the reason
 * it is allowed here when the widget spec refuses markup outright: that content
 * would be *in* the app's document, and this is not. Everything below is what
 * makes that true, and each line is load-bearing.
 *
 * ## The frame
 *
 * `sandbox="allow-scripts"` and nothing else. The omissions matter more than
 * the inclusion:
 *
 * - **No `allow-same-origin`.** The frame gets a unique opaque origin, so it
 *   cannot read this document, cannot reach `window.parent`, and cannot touch
 *   the app's cookies or storage. Adding it back would undo every other line
 *   here at once — the two flags together are famously equivalent to no sandbox
 *   at all.
 * - **No `allow-forms`, `allow-popups`, `allow-modals`,
 *   `allow-top-navigation`.** It cannot submit anything, open a window, block
 *   the app behind an `alert`, or navigate the tab out from under the user.
 * - **No `allow-downloads`.** A scene cannot put a file on the machine.
 *
 * ## The network
 *
 * The sandbox does not stop a frame making requests, so the policy does. The
 * injected `Content-Security-Policy` is `default-src 'none'` with inline script
 * and style allowed and images limited to `data:` — so `fetch`, `XMLHttpRequest`,
 * WebSockets, remote images, remote fonts and `@import` all fail. A scene is a
 * closed box: whatever it draws, it draws from what it was given.
 *
 * It is injected as the *first* thing in the document, ahead of the agent's own
 * markup, because a meta policy only governs what follows it. Written this way
 * a scene cannot pre-empt it, and cannot relax it either — a second policy tag
 * can only ever narrow the first.
 *
 * ## Why it still cannot pretend to be the app
 *
 * Containment stops it reading anything; it does not stop it *drawing* a
 * convincing permission prompt. Two things do. In the corner it is a labelled,
 * bordered card that says what it is and who made it, at a size and position
 * nothing else in the app uses. Behind the interface it is `pointer-events:
 * none` and sits under everything, so a fake control there cannot be clicked
 * even if it is drawn perfectly.
 */

const POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'media-src data:',
  "font-src data:",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/**
 * Wraps the agent's markup in a document with the policy first.
 *
 * A full document rather than a fragment: the agent is told to write as though
 * for a blank page, and giving it half of one would mean its `<style>` landing
 * somewhere the browser has already decided the body began.
 */
function frameDocument(html: string): string {
  return [
    '<!doctype html><html><head>',
    `<meta http-equiv="Content-Security-Policy" content="${POLICY}">`,
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    // A transparent body, so a scene that draws nothing shows the app's own
    // background rather than a white rectangle.
    '<style>html,body{margin:0;height:100%;background:transparent;overflow:hidden;}</style>',
    '</head><body>',
    html,
    '</body></html>',
  ].join('');
}

type Props = {
  title: string;
  html: string;
  /** Behind the interface it is scenery, and scenery is never clickable. */
  interactive: boolean;
};

export function CustomScene({ title, html, interactive }: Props) {
  // Rebuilt only when the markup changes. A new `srcDoc` string on every render
  // reloads the frame, which for a game means restarting it whenever anything
  // in the app re-renders.
  const srcDoc = useMemo(() => frameDocument(html), [html]);

  return (
    <iframe
      // Keyed on the content so a *new* scene is a fresh frame rather than the
      // previous one navigated: a game left running in a document being
      // replaced keeps its timers until the load completes.
      key={srcDoc.length}
      title={title}
      srcDoc={srcDoc}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      // Nothing. Not the camera, not the microphone, not the clipboard.
      allow=""
      className={`size-full border-0 bg-transparent ${interactive ? '' : 'pointer-events-none'}`}
    />
  );
}
