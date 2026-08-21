/**
 * How long that took.
 *
 * Shown once, under the turn that just finished, and gone as soon as the next
 * one starts. It is the answer to a question people ask themselves constantly
 * while waiting and can otherwise only guess at — and it is the one number the
 * app has that the transcript does not.
 *
 * Deliberately quiet: small, muted, no border. It is a fact about the turn, not
 * a part of the answer, and anything louder would compete with the reply it sits
 * under.
 */

/**
 * A duration a person can read at a glance.
 *
 * Minutes and seconds rather than a decimal, because "1m 3s" is a length of time
 * and "63.4s" is a measurement. Sub-second turns are real — a cached refusal, a
 * one-word answer — and rounding those to "0s" reads as broken, so they get their
 * own shape.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms / 100) * 100 / 1000).toFixed(1)}s`;

  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;

  if (minutes === 0) return `${seconds}s`;
  // No "0s" tail: a turn that took exactly two minutes says so.
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export function TurnFooter({ ms }: { ms: number }) {
  return (
    <p className="px-1 text-[11px] text-muted-foreground/70">
      Cooked for {formatDuration(ms)}
    </p>
  );
}
