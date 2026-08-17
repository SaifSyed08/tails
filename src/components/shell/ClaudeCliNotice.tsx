import { useEffect, useState } from 'react';
import { TriangleAlert, X } from 'lucide-react';

import { api } from '@/lib/api';

/**
 * "There is no Claude Code on this machine."
 *
 * Asked once, when the app opens, because this is the one missing piece that
 * makes every other part of the app look broken rather than incomplete. The
 * failure without it used to be a red row in the transcript *after* the user
 * had composed and sent a message — the worst possible moment to learn that the
 * agent was never there.
 *
 * Renders nothing in the normal case, and nothing while the answer is still in
 * flight: a warning that flashes on every launch before being retracted is a
 * warning people stop reading.
 *
 * ## Why it can be dismissed but not silenced
 *
 * Dismissal is per launch and deliberately not persisted. The app genuinely
 * cannot do its job in this state, so a "don't show again" would be a switch
 * for hiding the reason the app is not working — but the user still needs to be
 * able to push it aside to reach Settings, read the transcript, or use the
 * terminal, all of which work fine without the CLI.
 */
export function ClaudeCliNotice() {
  const [notice, setNotice] = useState<{ reason: string; installUrl?: string } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let live = true;

    void api.getClaudeCli()
      .then((status) => {
        if (!live || status.found || !status.reason) return;
        setNotice({ reason: status.reason, ...(status.installUrl ? { installUrl: status.installUrl } : {}) });
      })
      // A server that cannot answer this is a different problem with its own
      // symptoms, and guessing "missing" from a failed request would put this
      // banner in front of people whose install is fine.
      .catch(() => {});

    return () => { live = false; };
  }, []);

  if (!notice || dismissed) return null;

  return (
    /*
      Positioning and stacking on the outer element, the entrance on the inner
      one — the same shape as `RestylingChip`, and not a style preference. An
      element that is running a transform animation becomes its own stacking
      context, so a `z-50` *inside* one is only z-50 among its siblings: wrapped
      the other way round, the chat's own empty state painted straight over this
      notice, button and all.
    */
    <div className="fixed left-1/2 top-16 z-50 w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2">
      {/*
        Critical, for the same reason `PermissionBanner` is: a generated theme
        must not be able to hide the notice that explains why the app cannot
        answer. The freeform CSS validator refuses any selector naming this
        attribute.
      */}
      <div
        data-tails-critical
        role="alert"
        className="animate-rise-in rounded-xl border border-warning/50 bg-card p-3 shadow-lg"
      >
        <div className="flex items-start gap-2">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Claude Code is not installed</p>
            <p className="mt-0.5 text-sm text-muted-foreground">{notice.reason}</p>

            {notice.installUrl ? (
              <a
                href={notice.installUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-block rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-transform duration-instant ease-emphasis active:scale-95"
              >
                How to install it
              </a>
            ) : null}
          </div>

          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label="Dismiss"
            className="rounded-md p-1 text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
