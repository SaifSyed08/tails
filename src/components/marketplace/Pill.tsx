import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The one-word label on a pet.
 *
 * A component rather than a repeated class string because the same handful of
 * facts — where a pet came from, what kind it is, whether it is on screen —
 * appear on the card, in the spotlight and in the detail sheet, and they have
 * to read as the same object in all three.
 *
 * Tones are token roles, not colours, so a re-theme moves them.
 */
const TONE_CLASS = {
  neutral: 'bg-muted text-muted-foreground',
  accent: 'bg-primary/15 text-primary',
  warning: 'bg-warning/15 text-warning',
  positive: 'bg-positive/15 text-positive',
} as const;

export type PillTone = keyof typeof TONE_CLASS;

type PillProps = {
  children: ReactNode;
  tone?: PillTone;
  title?: string;
  className?: string;
};

export function Pill({ children, tone = 'neutral', title, className }: PillProps) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        TONE_CLASS[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
