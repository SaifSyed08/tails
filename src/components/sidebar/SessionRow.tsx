import { AlertTriangle, Loader2, MoreHorizontal, Pin } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import {
  clearPetDropTarget,
  isPetDrag,
  PetThumbnail,
  publishPetDragFrame,
  readPetDrag,
  setPetDropTarget,
  usePetDragState,
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
function MarqueeTitle(
  { text, active, emphasis = false }:
  { text: string; active: boolean; emphasis?: boolean },
) {
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
    <span ref={viewportRef} className={cn('block min-w-0 flex-1 overflow-hidden whitespace-nowrap', emphasis && 'font-medium text-foreground')}>
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
  /** A turn finished here while the user was reading something else. */
  unread?: boolean;
  /** Set while a pet is being installed for this row, or while one failed to. */
  dropStatus?: { state: 'installing' | 'failed'; message: string } | null;
  onAssignPet?: (payload: PetDragPayload) => void;
};

export function SessionRow({
  session, active, renaming, onOpen, onOpenMenu, onHover, onCommitRename, onCancelRename,
  pet = null, dropStatus = null, onAssignPet, unread = false,
}: SessionRowProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);

  /**
   * What is in flight, and what it is over.
   *
   * Both come from the drag record rather than from this row's own state,
   * because the pointer-driven carry has no `dragover` to listen to — it finds
   * its target by hit-testing the document for `data-pet-drop-session`. One
   * source of truth means the row highlights identically whichever gesture is
   * carrying the pet.
   */
  const { payload: dragging, target } = usePetDragState();
  const rowTarget = { kind: 'session', sessionId: session.id } as const;
  const droppable = Boolean(onAssignPet) && dragging !== null;
  const dragOver = droppable && target?.kind === 'session' && target.sessionId === session.id;

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
      // How a pointer-driven carry finds this row. It hit-tests the document on
      // release, so a row that cannot accept a pet must not answer to the name.
      data-pet-drop-session={onAssignPet ? session.id : undefined}
      className="group/row relative"
      onMouseEnter={() => {
        setHovered(true);
        // A pointer carry does not suppress mouse events the way an HTML5 drag
        // does, so without this the folder card would open under a pet being
        // carried past — on top of the label saying what the drop will do.
        onHover(dragging ? null : rowRef.current);
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
        setPetDropTarget(rowTarget);
        // The label beside the cursor is drawn by the drag layer, and an HTML5
        // drag is the one gesture that does not otherwise report where the
        // pointer is.
        publishPetDragFrame({ x: event.clientX, y: event.clientY, angle: 0 });
      }}
      onDragLeave={(event) => {
        // Ignore the leave events fired while crossing this row's own children.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        clearPetDropTarget(rowTarget);
      }}
      onDrop={(event) => {
        if (!onAssignPet || !isPetDrag(event)) return;
        event.preventDefault();
        clearPetDropTarget(rowTarget);
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
          'flex h-8 w-full items-center gap-1.5 rounded-sm pl-2.5 text-left text-sm',
          'transition-colors duration-quick',
          // Room at the right end for the options button, and for the pet
          // beside it when there is one. Reserved by the title rather than
          // taken from it, so a long name is truncated instead of running
          // underneath them.
          pet ? 'pr-14' : 'pr-7',
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

        {/*
          Before the name, not after it.

          The right end of this row is already spoken for — the options button
          and the pet live there — and a dot competing for that space would
          either be pushed off by a long title or push the title further in. At
          the head of the line it has a fixed cost and reads as a marker on the
          row rather than as another control.
        */}
        {unread ? (
          <span
            className="size-1.5 shrink-0 rounded-full bg-primary"
            /* Named, not decorative: the dot is the only thing saying this
               conversation has something new in it. */
            role="img"
            aria-label="Finished while you were away"
          />
        ) : null}

        <MarqueeTitle
          text={session.title}
          active={hovered && !dragging}
          /* Unread reads as emphasis, which is what a dot means everywhere
             else. Only when the row is not the active one — the chat you are
             looking at is never unread, so styling it would be a state that
             cannot happen. */
          emphasis={unread && !active}
        />
      </button>

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

      {/*
        The right-hand end of the row.

        Siblings of the title rather than children: a button cannot be nested in
        a button, and the options control has to be reachable by keyboard in its
        own right.

        The options button *collapses* rather than merely fading. Holding its
        width kept the pet from shifting on hover, which sounded like the calmer
        choice and was not: it parked the pet a button's width in from the edge
        and left a permanent gap at the right of every row — visible on every
        row all the time, to spare a motion visible on one row while the pointer
        is on it. So the pet lives at the edge, and hovering opens room beside
        it. The width is animated, so the shift reads as the button arriving
        rather than as the pet jumping.

        `focus-within` matters as much as hover here: reached by keyboard, the
        button has to have somewhere to be before it can show a focus ring.
      */}
      <div className="pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 items-center">
        <span
          className={cn(
            'flex overflow-hidden transition-[width] duration-quick ease-standard',
            'w-0 group-hover/row:w-[26px] group-focus-within/row:w-[26px]',
          )}
        >
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
              'pointer-events-auto mr-0.5 shrink-0 rounded-sm p-1 text-muted-foreground',
              'opacity-0 transition-opacity duration-quick hover:bg-accent hover:text-foreground',
              'focus-visible:opacity-100 group-hover/row:opacity-100',
            )}
          >
            <MoreHorizontal className="size-3.5" aria-hidden="true" />
          </button>
        </span>

        {pet ? (
          // Clipped for the same reason as the carousel icon: a pet with an
          // un-inferred grid is one very wide cell, and this row is 32px tall
          // and must stay that way. No tooltip, deliberately — the thumbnail
          // names itself to assistive tech, and making this hoverable would
          // put a dead 18px hole in the row's own click target.
          <span className="flex h-[18px] max-w-[22px] shrink-0 items-center justify-center overflow-hidden">
            <PetThumbnail pet={pet} size={18} />
          </span>
        ) : null}
      </div>
    </div>
  );
}
