import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/shared/ui/Motion';

/**
 * The two commands that get a look of their own.
 *
 * Presentation lives here rather than travelling with the command list: the
 * server decides what a command *does*, and a styled token has to render in
 * places that never fetched that list — a message read back out of the
 * transcript, for instance.
 *
 * Both gradients are built from theme tokens, so a re-theme moves them, and
 * both loop on a colour they also start on, so the sweep has no seam.
 */
export const COMMAND_STYLES = {
  personalize: {
    /** Every hue the theme actually owns, in order, closing on the one it opened with. */
    gradient: [
      'linear-gradient(90deg,',
      'hsl(var(--destructive)),',
      'hsl(var(--warning)),',
      'hsl(var(--positive)),',
      'hsl(var(--primary)),',
      'hsl(var(--destructive)))',
    ].join(' '),
    glow: null as string | null,
  },
  ultracode: {
    /*
      Violet is the point of this one, so the hue is named rather than taken
      from `--primary` — a theme with an orange primary would otherwise erase
      the thing being asked for. It is mixed *with* the primary so it still
      shifts with the theme instead of sitting on top of it as a foreign
      colour, and mixed in oklab so the midpoint does not go grey.
    */
    gradient: [
      'linear-gradient(90deg,',
      'color-mix(in oklab, hsl(var(--primary)) 30%, hsl(276 90% 60%)),',
      'color-mix(in oklab, hsl(var(--primary)) 20%, hsl(305 95% 66%)),',
      'color-mix(in oklab, hsl(var(--primary)) 30%, hsl(276 90% 60%)))',
    ].join(' '),
    glow: '0 0 14px color-mix(in oklab, transparent 55%, hsl(288 90% 62%))',
  },
} as const;

export type StyledCommandName = keyof typeof COMMAND_STYLES;

const COMMAND_PATTERN = /^\/([\w-]+)/;

/**
 * Reads the styled command a piece of text opens with, if it opens with one.
 *
 * Anchored at the start because that is the only position where a slash is a
 * command — a path like `src/a.ts` mid-sentence is not one, and neither is a
 * message that merely mentions `/ultracode`.
 */
export function readStyledCommand(text: string): StyledCommandName | null {
  const match = COMMAND_PATTERN.exec(text.trimStart());
  const name = match?.[1]?.toLowerCase();
  return name && name in COMMAND_STYLES ? (name as StyledCommandName) : null;
}

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
