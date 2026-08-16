import { Settings, X } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * The pet's handle on himself.
 *
 * A small dark pill under his feet that grows into two buttons when you point
 * at him: his details, and away. It exists because the only way to reach any of
 * this was a right-click, which is invisible — nothing on screen said the
 * gesture existed, so the things behind it may as well not have.
 *
 * ## Why the right-click is gone rather than kept as well
 *
 * On the desktop pet, right-click was the *only* reason his body could not
 * simply be the window's drag region: a page handler over a drag region is a
 * way to swallow the gesture, so the body had to be `no-drag` with a narrow
 * draggable strip across the top. That split is what made him so hard to pick
 * up. Dropping right-click let the whole sprite become the handle, so this pill
 * is not an addition to the old way in — it replaced it, and it has to carry
 * everything the old menu did.
 */

type PetPillProps = {
  /** Grown and labelled when true, a bare pill when false. */
  open: boolean;
  /** Width of the pet above it, so the pill reads as his shadow rather than a tooltip. */
  width: number;
  onOpenDetails: () => void;
  onHide: () => void;
  className?: string;
};

const BUTTON_CLASS = 'grid h-full flex-1 place-items-center rounded-full transition-opacity duration-quick';

export function PetPill({ open, width, onOpenDetails, onHide, className }: PetPillProps) {
  return (
    <div
      className={cn(
        'pointer-events-auto absolute left-1/2 top-full flex -translate-x-1/2 items-center justify-center',
        'overflow-hidden rounded-full bg-foreground/80 text-background backdrop-blur-sm',
        'transition-all duration-quick ease-standard',
        className,
      )}
      style={{
        // Collapsed, it is a shadow the width of his stance. Open, it is only
        // as wide as the two controls it holds.
        width: open ? 56 : Math.max(18, width * 0.45),
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
          onOpenDetails();
        }}
        className={cn(BUTTON_CLASS, open ? 'opacity-100 hover:bg-background/20' : 'pointer-events-none opacity-0')}
        aria-label="Pet details"
        title="Pet details"
      >
        <Settings className="size-3" aria-hidden="true" />
      </button>

      <button
        type="button"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onHide();
        }}
        className={cn(BUTTON_CLASS, open ? 'opacity-100 hover:bg-background/20' : 'pointer-events-none opacity-0')}
        aria-label="Hide pet"
        title="Hide pet"
      >
        <X className="size-3" aria-hidden="true" />
      </button>
    </div>
  );
}
