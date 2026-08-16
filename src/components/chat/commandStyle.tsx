import type { StyledCommandName } from '@/components/chat/commandNames';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/shared/ui/Motion';

/**
 * Pulls a colour toward the ink of whichever mode is showing.
 *
 * Two jobs at once, which is why every stop below goes through it. It adapts a
 * fixed hue per mode without a `dark:` variant — `--foreground` is already
 * near-black on light and near-white on dark — and it buys contrast, because
 * moving a colour toward the ink moves it away from the background by
 * definition. Saturated mid-lightness hues are exactly the ones that fail on
 * both grounds: raw magenta measures 2.75:1 on a white popover, and raw violet
 * 4.10:1 on a dark one, both under the 4.5:1 these labels need.
 *
 * `keep` is how much of the original survives; the remainder is ink.
 */
const towardInk = (color: string, keep: number) =>
  `color-mix(in oklab, ${color} ${keep}%, hsl(var(--foreground)))`;

/**
 * The two commands that get a look of their own.
 *
 * Presentation lives here rather than travelling with the command list: the
 * server decides what a command *does*, and a styled token has to render in
 * places that never fetched that list — a message read back out of the
 * transcript, for instance.
 *
 * Both gradients loop on the colour they open with, so the sweep has no seam.
 */
export const COMMAND_STYLES: Record<StyledCommandName, {
  gradient: string;
  glow: string | null;
}> = {
  personalize: {
    /*
      Every hue the theme owns, ordered by hue rather than by token name.
      Listed as destructive → warning → positive → primary the sweep ran
      27° → 88° → 153° → 47° and doubled back on itself at the end, which
      reads as a bounce; in this order it climbs 27° → 47° → 88° → 153° and
      wraps once, which is what a rainbow is supposed to do. The accent moving
      to orange is what exposed it — it used to be blue and sat at the far end.

      Only `--destructive` is corrected, and only a little. Pulling every stop
      toward the ink cleared the numbers comfortably and looked visibly worse —
      pastel in dark, murky olive in light — so the tokens are otherwise used
      raw. Dark `--destructive` is the one that needs it: on its own it
      measures 4.50:1, exactly the AA threshold and one nudge from failing, and
      reordering makes the green-to-red interpolation dip to 4.39:1. At 92% the
      whole sweep clears in both ramps — 4.93:1 light, 4.97:1 dark — for 8% of
      one stop's chroma, which does not read.

      Measured across the interpolation rather than at the stops, because what
      is on screen at any instant is a blend of two of them.
    */
    gradient: [
      'linear-gradient(90deg,',
      `${towardInk('hsl(var(--destructive))', 92)},`,
      'hsl(var(--primary)),',
      'hsl(var(--warning)),',
      'hsl(var(--positive)),',
      `${towardInk('hsl(var(--destructive))', 92)})`,
    ].join(' '),
    glow: null,
  },
  ultracode: {
    /*
      Violet is the point of this one, so the hue is named rather than derived
      from `--primary` — a theme whose accent is orange would otherwise erase
      the thing being asked for.

      It used to mix 30% of the accent in, so the token would shift with the
      theme. That worked while the accent was blue and stopped working the day
      it became amber: amber and violet are near-complementary, so the oklab
      midpoint runs through grey — measured, that mix lost 31% of the violet's
      chroma and dragged its hue 307° → 322°, which is muddy rather than
      flashy. The accent is gone from the text for that reason. What keeps this
      theme-responsive is `towardInk`, which is the part that actually differed
      between light and dark anyway.
    */
    /*
      Asymmetric on purpose: the violet is the identity and keeps more of
      itself, while the magenta — which is the stop that actually fails, at
      2.75:1 raw on a white popover — takes the larger correction. Worst point
      across the sweep is 4.92:1 light, 5.68:1 dark.
    */
    gradient: [
      'linear-gradient(90deg,',
      `${towardInk('hsl(276 90% 60%)', 80)},`,
      `${towardInk('hsl(305 95% 66%)', 70)},`,
      `${towardInk('hsl(276 90% 60%)', 80)})`,
    ].join(' '),
    // The glow is the one place the raw anchor still shows: it is a diffuse
    // halo behind the glyphs rather than something anyone reads, so it carries
    // the full-strength violet the text cannot.
    glow: '0 0 14px color-mix(in oklab, transparent 55%, hsl(288 90% 62%))',
  },
};

export { readStyledCommand, STYLED_COMMANDS, type StyledCommandName } from '@/components/chat/commandNames';

type CommandTokenProps = {
  name: StyledCommandName;
  /** What to draw. Defaults to the command as typed. */
  children?: React.ReactNode;
  className?: string;
};

/**
 * The command itself, wearing its look.
 *
 * The sweep is the shimmer already in the motion system rather than a new
 * keyframe, so these move on the same rhythm as everything else that shimmers.
 * With motion reduced the gradient stays and only the travel stops — the
 * colour is identity here, not decoration, and removing it would remove the
 * feature rather than calm it.
 */
export function CommandToken({ name, children, className }: CommandTokenProps) {
  const reduced = useReducedMotion();
  const style = COMMAND_STYLES[name];

  return (
    <span
      className={cn(
        'bg-clip-text font-medium text-transparent',
        !reduced && 'animate-shimmer',
        className,
      )}
      style={{
        backgroundImage: style.gradient,
        // Two tiles per cycle; see the note in EmptyState — any other tile
        // size makes the shimmer's 400% travel wrap mid-pattern and jump.
        backgroundSize: '200% 100%',
        ...(style.glow ? { filter: `drop-shadow(${style.glow})` } : {}),
      }}
    >
      {children ?? `/${name}`}
    </span>
  );
}
