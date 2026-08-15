import { AlertTriangle, CornerDownLeft, Loader2, MoreHorizontal, Pin } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import {
  isPetDrag,
  PetThumbnail,
  readPetDrag,
  usePetDrag,
  type InstalledPet,
  type PetDragPayload,
} from '@/components/marketplace';
import type { SessionListItem } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Milliseconds of travel per pixel of overflow, so long names are not faster. */
const MARQUEE_MS_PER_PX = 26;
/** Beat before the title starts moving, so brushing past a row stays still. */
const MARQUEE_DELAY_MS = 350;

/**
 * A title that scrolls itself while the pointer is on its row.
 *
 * Driven by the Web Animations API rather than a CSS keyframe because the
 * distance to travel is the overflow, and that is only knowable once the text
 * has been laid out. A fixed `translateX(-100%)` either stops short of the end
 * or runs the name clean off the row, depending on how long it happens to be.
 */
function MarqueeTitle({ text, active }: { text: string; active: boolean }) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    const inner = textRef.current;
    if (!active || !viewport || !inner) return undefined;

    const overflow = inner.scrollWidth - viewport.clientWidth;
    // Reduced motion leaves the name truncated. The global `prefers-reduced-
    // motion` rule in index.css collapses animation *duration* rather than
    // removing the animation, which for a marquee would snap the text straight
    // to its end position — so this has to opt out itself.
    if (overflow <= 0 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return undefined;
    }

    const animation = inner.animate(
      [{ transform: 'translateX(0)' }, { transform: `translateX(${-overflow}px)` }],
      {
        duration: Math.max(1200, overflow * MARQUEE_MS_PER_PX),
        delay: MARQUEE_DELAY_MS,
        direction: 'alternate',
        iterations: Infinity,
        easing: 'ease-in-out',
      },
    );

    return () => animation.cancel();
  }, [active, text]);

  return (
    <span ref={viewportRef} className="block min-w-0 flex-1 overflow-hidden whitespace-nowrap">
      <span
        ref={textRef}
        className={cn(
          'inline-block align-bottom will-change-transform',
          // Ellipsis only at rest: it would otherwise scroll along with the
          // text and hide the last few characters it exists to stand in for.
          !active && 'max-w-full truncate',
        )}
      >
        {text}
      </span>
    </span>
  );
}

type SessionRowProps = {
  session: SessionListItem;
  active: boolean;
  renaming: boolean;
  onOpen: () => void;
  /** Both entry points to the menu land here, with viewport coordinates. */
  onOpenMenu: (x: number, y: number) => void;
  onHover: (anchor: HTMLElement | null) => void;
  onCommitRename: (title: string) => void;
  onCancelRename: () => void;
  /** The pet assigned to this chat, once its sprite is known. */
  pet?: InstalledPet | null;
  /** Set while a pet is being installed for this row, or while one failed to. */
  dropStatus?: { state: 'installing' | 'failed'; message: string } | null;
  onAssignPet?: (payload: PetDragPayload) => void;
};

export function SessionRow({
  session, active, renaming, onOpen, onOpenMenu, onHover, onCommitRename, onCancelRename,
  pet = null, dropStatus = null, onAssignPet,
}: SessionRowProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // What is being dragged right now, so the row can name it before the drop.
  const dragging = usePetDrag();
  const droppable = Boolean(onAssignPet) && dragging !== null;

  if (renaming) {
    return (
      <div className="px-0.5 py-px">
        <input
          autoFocus
          defaultValue={session.title}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onCommitRename(event.currentTarget.value);
            if (event.key === 'Escape') onCancelRename();
          }}
          // Committing on blur rather than discarding: clicking away from a
          // name you have just typed reads as "done", not "cancel".
          onBlur={(event) => onCommitRename(event.currentTarget.value)}
          aria-label="Rename conversation"
          className="h-8 w-full rounded-sm bg-background px-2 text-sm outline-none ring-1 ring-ring"
        />
      </div>
    );
  }

  return (
    <div
      ref={rowRef}
      className="group/row relative"
      onMouseEnter={() => {
        setHovered(true);
        onHover(rowRef.current);
      }}
      onMouseLeave={() => {
        setHovered(false);
        onHover(null);
      }}
      onDragOver={(event) => {
        if (!onAssignPet || !isPetDrag(event)) return;
        // Both required, and both on every move: without `preventDefault` the
        // browser refuses the drop, and without it on `dragover` specifically
        // the cursor keeps showing "no entry" the whole way down the list.
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDragOver(true);
      }}
      onDragLeave={(event) => {
        // Ignore the leave events fired while crossing this row's own children.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragOver(false);
      }}
      onDrop={(event) => {
        if (!onAssignPet || !isPetDrag(event)) return;
        event.preventDefault();
        setDragOver(false);
        const payload = readPetDrag(event);
        if (payload) onAssignPet(payload);
      }}
    >
      <button
        type="button"
        onClick={onOpen}
        onContextMenu={(event) => {
          event.preventDefault();
          onOpenMenu(event.clientX, event.clientY);
        }}
        className={cn(
          // One line, fixed height. The folder and the timestamp used to live
          // on a second line inside the row, which made every pill twice as
          // tall as the name it was showing; they are in the hover card now.
          'flex h-8 w-full items-center gap-1.5 rounded-sm pl-2.5 pr-7 text-left text-sm',
          'transition-colors duration-quick',
          active
            ? 'bg-accent text-accent-foreground'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
          // A pet is in flight: every row it could land on says so quietly, and
          // the one under the pointer says so loudly.
          droppable && 'outline-dashed outline-1 outline-offset-[-1px] outline-border',
          dragOver && 'bg-primary/10 text-foreground outline outline-2 outline-offset-[-2px] outline-primary',
        )}
      >
        {session.pinned ? (
          <Pin className="size-3 shrink-0 rotate-45 opacity-70" aria-hidden="true" />
        ) : null}

        {/* Kept inside the fixed-height row: the thumbnail is the cell's own
            aspect at 18px, which fits an h-8 row without changing it. */}
        {pet ? <PetThumbnail pet={pet} size={18} className="-my-1" /> : null}

        <MarqueeTitle text={session.title} active={hovered && !dragOver} />
      </button>

      {/* The promise, made before the drop. The user asked to know what will
          happen before letting go, so this replaces the row's contents rather
          than sitting beside them where it could be missed. */}
      {dragOver && dragging ? (
        <div className="pointer-events-none absolute inset-0 flex items-center gap-1.5 rounded-sm bg-primary/15 px-2.5 text-xs font-medium text-primary">
          <CornerDownLeft className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">
            Assign {dragging.displayName} to this chat
          </span>
        </div>
      ) : null}

      {dropStatus ? (
        <div
          className={cn(
            'pointer-events-none absolute inset-0 flex items-center gap-1.5 rounded-sm px-2.5 text-xs',
            dropStatus.state === 'installing'
              ? 'bg-background/90 text-muted-foreground'
              : 'bg-destructive/15 text-destructive',
          )}
        >
          {dropStatus.state === 'installing'
            ? <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />
            : <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />}
          <span className="truncate">{dropStatus.message}</span>
        </div>
      ) : null}

      {/* A sibling rather than a child: a button cannot be nested in a button,
          and this has to be reachable by keyboard in its own right. */}
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          onOpenMenu(rect.right, rect.bottom + 4);
        }}
        aria-label={`Options for ${session.title}`}
        title="Options"
        className={cn(
          'absolute right-1 top-1/2 -translate-y-1/2 rounded-sm p-1 text-muted-foreground',
          'opacity-0 transition-opacity duration-quick hover:bg-accent hover:text-foreground',
          'focus-visible:opacity-100 group-hover/row:opacity-100',
        )}
      >
        <MoreHorizontal className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
