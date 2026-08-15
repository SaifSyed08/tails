import { useEffect, useState } from 'react';

import { useReducedMotion } from '@/shared/ui/Motion';

/**
 * The rotating status words shown while the agent works.
 *
 * In the spirit of Claude Code's own playful indicator rather than a copy of
 * its exact list — the point is that a long pause feels alive instead of hung.
 */
const WORDS = [
  'Thinking', 'Pondering', 'Noodling', 'Ruminating', 'Percolating',
  'Cogitating', 'Musing', 'Deliberating', 'Puzzling', 'Simmering',
  'Brewing', 'Marinating', 'Mulling', 'Conjuring', 'Untangling',
  'Wrangling', 'Scheming', 'Tinkering', 'Divining', 'Whirring',
];

/** How long each word stays up. Long enough to read, short enough to notice. */
const WORD_INTERVAL_MS = 2600;

type ThinkingIndicatorProps = {
  /** Optional detail from a status event, e.g. "Compacting context". */
  detail?: string | null;
};

/**
 * The "it is working" affordance.
 *
 * Shows elapsed seconds alongside the word, because the single most useful
 * thing during a long tool run is knowing how long it has actually been —
 * that is the difference between patience and reaching for the stop button.
 */
export function ThinkingIndicator({ detail }: ThinkingIndicatorProps) {
  const reduced = useReducedMotion();
  const [wordIndex, setWordIndex] = useState(() => Math.floor(Math.random() * WORDS.length));
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const tick = window.setInterval(() => setSeconds((current) => current + 1), 1000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    if (reduced) return undefined;
    const rotate = window.setInterval(
      () => setWordIndex((current) => (current + 1) % WORDS.length),
      WORD_INTERVAL_MS,
    );
    return () => window.clearInterval(rotate);
  }, [reduced]);

  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
      <span className="relative flex size-2">
        {!reduced ? (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60" />
        ) : null}
        <span className="relative inline-flex size-2 rounded-full bg-primary" />
      </span>
      <span
        key={wordIndex}
        className={!reduced ? 'animate-fade-in' : undefined}
      >
        {detail || `${WORDS[wordIndex]}…`}
      </span>
      {seconds >= 3 ? (
        <span className="tabular-nums text-xs opacity-60">{seconds}s</span>
      ) : null}
    </div>
  );
}
