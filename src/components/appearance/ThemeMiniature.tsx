/**
 * A scaled-down mock of the app, painted in a candidate theme.
 *
 * The user asked to see a proposed look before the app commits to it, with the
 * real layout as the frame — sidebar left, chat right — and framed the request
 * as "generate an image". This is deliberately not an image.
 *
 * An image would be an *approximation* of a look the appearance engine can
 * already render exactly, it would have to be fetched or synthesised from
 * somewhere (and nothing in this system may name a URL), and it would go stale
 * the moment the spec was tweaked. What this renders instead is the candidate's
 * real derived stylesheet, scoped by `serializeScoped` to a single class, so
 * every token in it applies inside this box and nowhere else. It is the look
 * itself, at 1/6 scale, not a picture of it.
 *
 * The content is bars rather than text on purpose. At this size real words are
 * unreadable and invite the eye to try; grey blocks read as "layout" and let
 * the comparison be about what it is actually about — colour, weight,
 * separation, corner geometry, depth.
 */

type ThemeMiniatureProps = {
  /** The class `serializeScoped` scoped this theme's tokens to. */
  className: string;
};

/** One line of pretend text. Width is a fraction, so rows look written rather than generated. */
function Bar({ width, tone = 'ink' }: { width: string; tone?: 'ink' | 'muted' }) {
  return (
    <span
      aria-hidden
      className={`block h-1 rounded-full ${tone === 'ink' ? 'bg-foreground/45' : 'bg-foreground/20'}`}
      style={{ width }}
    />
  );
}

export function ThemeMiniature({ className }: ThemeMiniatureProps) {
  return (
    <div
      // `bg-background` resolves through the scoped `--background`, so the
      // frame is the candidate's page colour rather than the running app's.
      className={`${className} pointer-events-none flex h-32 w-full overflow-hidden rounded-md border border-border bg-background`}
      aria-hidden
    >
      <div data-tails-part="sidebar" className="flex w-1/4 flex-col gap-1.5 p-1.5">
        <Bar width="70%" />
        <div data-tails-surface="raised" className="rounded-sm p-1">
          <Bar width="80%" />
        </div>
        <Bar width="60%" tone="muted" />
        <Bar width="75%" tone="muted" />
        <Bar width="50%" tone="muted" />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div data-tails-part="header" className="flex items-center gap-1 px-2 py-1.5">
          <Bar width="40%" />
        </div>

        <div className="flex min-h-0 flex-1 flex-col justify-end gap-1.5 p-2">
          <div data-tails-part="bubbleAssistant" className="space-y-1 p-1.5">
            <Bar width="92%" tone="muted" />
            <Bar width="78%" tone="muted" />
          </div>

          <div data-tails-part="card" className="ml-auto w-3/5 space-y-1 p-1.5">
            <Bar width="70%" tone="muted" />
          </div>

          {/* A user turn: the one place most themes commit to the accent. */}
          <div data-tails-part="bubbleUser" className="ml-auto w-1/2 space-y-1 p-1.5">
            <Bar width="80%" />
          </div>

          <div data-tails-part="input" className="mt-0.5 p-2">
            <Bar width="35%" tone="muted" />
          </div>
        </div>
      </div>
    </div>
  );
}
