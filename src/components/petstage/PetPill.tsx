import { MoreHorizontal } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * The pet's handle on itself.
 *
 * A small dark pill under his feet that grows into a button when you point at
 * him. It exists because the only way to reach his menu was a right-click,
 * which is invisible: nothing on screen said the gesture existed, so the
 * features behind it — hiding him, editing him — may as well not have.
 *
 * ## Why one button and not two
 *
 * He asked for an edit button and a close button, then said "should just be one
 * button". One is right, and the menu is the one worth keeping: it already
 * holds both hiding and settings, so a single entry point reaches everything an
 * X would, plus everything it would not. An X alone would make the destructive
 * option the only visible one and leave settings behind the invisible gesture
 * again, which is the problem this is fixing.
 *
 * Right-click still works. This adds a way in; it does not close one.
 */

type PetPillProps = {
  /** Grown and labelled when true, a bare pill when false. */
  open: boolean;
  /** Width of the pet above it, so the pill reads as his shadow rather than a tooltip. */
  width: number;
  onOpenMenu: (x: number, y: number) => void;
  className?: string;
};

export function PetPill({ open, width, onOpenMenu, className }: PetPillProps) {
  return (
    <div
      className={cn(
        'pointer-events-auto absolute left-1/2 top-full flex -translate-x-1/2 items-center justify-center',
        'rounded-full bg-foreground/80 text-background backdrop-blur-sm',
        'transition-all duration-quick ease-standard',
        className,
      )}
      style={{
        // Collapsed, it is a shadow the width of his stance. Open, it is only
        // as wide as the control it holds.
        width: open ? 30 : Math.max(18, width * 0.45),
        height: open ? 22 : 5,
        marginTop: open ? 2 : -2,
      }}
    >
      <button
        type="button"
        // The press must not reach the pet behind it: a press on the pet is the
        // start of picking him up, and pressing a button is not picking him up.
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          onOpenMenu(rect.left, rect.bottom);
        }}
        // Pointer events off while collapsed, so the pill cannot eat a click
        // aimed at whatever is behind the pet.
        className={cn(
          'grid size-full place-items-center rounded-full transition-opacity duration-quick',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        aria-label="Pet options"
        title="Pet options"
      >
        <MoreHorizontal className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
