import { MoreHorizontal, Pin } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

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
};

export function SessionRow({
  session, active, renaming, onOpen, onOpenMenu, onHover, onCommitRename, onCancelRename,
}: SessionRowProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);

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
        )}
      >
        {session.pinned ? (
          <Pin className="size-3 shrink-0 rotate-45 opacity-70" aria-hidden="true" />
        ) : null}
        <MarqueeTitle text={session.title} active={hovered} />
      </button>

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
