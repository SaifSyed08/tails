import { RotateCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useWebSocket } from '@/contexts/WebSocketContext';
import {
  closePreview,
  openPreview,
  subscribePreview,
  type PreviewTarget,
} from '@/components/preview/preview-store';

/**
 * A browser for the thing the agent just built, beside the conversation.
 *
 * Opened by `preview_open` — see `server/modules/preview/preview.tools.ts` —
 * and closable by the user at any time, which matters more than it sounds: a
 * pane the model can open and only the model can close is a pane that ends up
 * stuck. So this owns the close, and the tool's own close exists for the case
 * where the thing being previewed is genuinely gone.
 *
 * ## Why an iframe and not a `<webview>`
 *
 * `webview` needs `webviewTag: true` on the window, which is off, and turning
 * it on grants the renderer the ability to embed *anything* — a much larger
 * surface than this feature needs. An iframe is already permitted and already
 * sandboxed by the browser's own rules. The one thing it cannot do is navigate
 * with back/forward buttons, which a preview of a local dev server does not
 * need: reload is the gesture that matters, and that is the button provided.
 *
 * ## What it does not do
 *
 * No address bar, and deliberately none. A field would invite typing a URL into
 * a frame with none of a browser's protections and no visible origin. The
 * address is chosen by a tool that only accepts loopback, and the label states
 * plainly which host and port is showing so it can never be mistaken for a
 * page from the internet.
 */

export function PreviewPane() {
  const { subscribe } = useWebSocket();
  const [target, setTarget] = useState<PreviewTarget | null>(null);
  /*
    Bumped to force the iframe to remount, which is how a reload happens.

    Reaching into `contentWindow.location.reload()` would be blocked the moment
    the previewed page is a different origin from the app — which it always is,
    since it is a different port. Remounting is origin-agnostic and is what a
    re-run of `preview_open` should look like too.
  */
  const [reloadKey, setReloadKey] = useState(0);

  // The store is the single source of what is showing, so the header's reopen
  // button and the agent's tool cannot disagree about it.
  useEffect(() => subscribePreview((state) => {
    setTarget(state.current);
    // A repeat of the same URL is the agent saying "look again", so it has to
    // reload rather than no-op on an unchanged `src`.
    setReloadKey((current) => current + 1);
  }), []);

  useEffect(() => subscribe((message) => {
    if (message.kind !== 'preview_changed') return;
    try {
      const next = JSON.parse(message.content ?? 'null') as PreviewTarget | null;
      if (next) openPreview(next);
      else closePreview();
    } catch {
      closePreview();
    }
  }), [subscribe]);

  if (!target) return null;

  return (
    <aside
      data-tails-part="panel"
      className="flex h-full w-[42%] min-w-[320px] max-w-[720px] shrink-0 flex-col border-l border-border"
      aria-label={`Preview: ${target.title}`}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2.5">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {target.title}
          {/* The real origin, always shown. The pane has no address bar, so this
              is the only thing standing between "a local dev server" and "some
              page". It is not decoration. */}
          <span className="ml-1.5 font-mono opacity-60">{target.url}</span>
        </span>

        <button
          type="button"
          onClick={() => setReloadKey((current) => current + 1)}
          aria-label="Reload preview"
          title="Reload"
          className="rounded p-1 text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
        >
          <RotateCw className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={closePreview}
          aria-label="Close preview"
          title="Close preview"
          className="rounded p-1 text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </header>

      <iframe
        key={reloadKey}
        src={target.url}
        title={target.title}
        className="min-h-0 flex-1 border-0 bg-white"
        /*
          Scripts are the point — this is a web app, not a document — but the
          frame is kept out of the app's own origin so it cannot reach into the
          page hosting it. `allow-same-origin` is deliberately absent for that
          reason, and a dev server on another port is a different origin anyway.
        */
        sandbox="allow-scripts allow-forms allow-popups allow-modals"
      />
    </aside>
  );
}
