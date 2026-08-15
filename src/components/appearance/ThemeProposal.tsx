import { X } from 'lucide-react';

import { ThemeMiniature } from '@/components/appearance/ThemeMiniature';

/**
 * Two or three candidate looks, side by side, before anything is applied.
 *
 * Deliberately display-only. The user's request was to be *asked* which he
 * wanted when a request is ambiguous — "one more drastic, one less invasive,
 * and ask what it would prefer before executing" — and the app already has a
 * good affordance for asking, in the chat, with `AskUserQuestion`. Putting
 * "Use this" buttons here as well would create a second answer channel the
 * model cannot see the result of: the user clicks, the theme changes, and the
 * agent is still waiting on a question nobody answered.
 *
 * So this is the picture and the chat is the choice. It floats over the top of
 * the transcript rather than covering it, has no scrim, and closes itself when
 * a theme finally lands.
 */

export type ProposalVariant = {
  label: string;
  note: string;
  /** The class the server scoped this variant's tokens to. */
  className: string;
  name: string;
  summary: string;
  css: string;
};

type ThemeProposalProps = {
  variants: ProposalVariant[];
  onDismiss: () => void;
};

export function ThemeProposal({ variants, onDismiss }: ThemeProposalProps) {
  if (variants.length === 0) return null;

  return (
    <div
      data-tails-part="popover"
      className="animate-rise-in fixed left-1/2 top-16 z-30 w-[min(44rem,calc(100vw-8rem))] -translate-x-1/2 rounded-xl border border-border p-3 shadow-2xl"
    >
      {/* Each variant's stylesheet, scoped by the server to its own class. This
          is derived output, not author bytes — the freeform validator is not in
          this path because nothing here came from a stylesheet anyone wrote. */}
      {variants.map((variant) => (
        <style key={variant.className}>{variant.css}</style>
      ))}

      <div className="relative z-[1] mb-2 flex items-center gap-2">
        <p className="flex-1 text-xs font-medium">Two ways to read that — which one?</p>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss the proposed looks"
          className="rounded p-1 transition-colors duration-quick hover:bg-muted/50"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="relative z-[1] grid gap-3" style={{ gridTemplateColumns: `repeat(${variants.length}, minmax(0, 1fr))` }}>
        {variants.map((variant) => (
          <div key={variant.className} className="min-w-0 space-y-1.5">
            <ThemeMiniature className={variant.className} />
            <p className="truncate text-xs font-medium">{variant.label}</p>
            <p className="ink-muted text-[0.6875rem] leading-snug">
              {variant.note || variant.summary}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
