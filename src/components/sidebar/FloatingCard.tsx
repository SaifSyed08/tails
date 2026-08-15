import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';

type FloatingCardProps = {
  /** Viewport coordinates of the card's top-left corner, before clamping. */
  x: number;
  y: number;
  className?: string;
  /** Omit to make the card inert — a hover hint wants no dismiss behaviour. */
  onDismiss?: () => void;
  children: ReactNode;
};

/** Distance kept between the card and the window edge when it is clamped. */
const EDGE_MARGIN = 8;

/**
 * A panel pinned to viewport coordinates, rendered outside the sidebar.
 *
 * Positioning lives on the outer element and `data-tails-part` on the inner
 * one. The surface contract only needs the part to be a positioned ancestor
 * for its `::before` paint layer, and separating the two means no future
 * specificity change in the contract can reach through and move a menu.
 *
 * It also portals into `document.body`. A theme that emits a real
 * `--t-backdrop` makes the sidebar a containing block for fixed descendants,
 * which would displace a menu anchored to viewport coordinates. Escaping the
 * subtree removes the dependency on what the theme did.
 *
 * Clamping is written straight onto the node rather than held in state: the
 * value is a measurement of the element itself, so feeding it back through a
 * render is a loop waiting to happen, and a layout effect lands it before the
 * browser paints either way.
 */
export function FloatingCard({ x, y, className, onDismiss, children }: FloatingCardProps) {
  const nodeRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (!node) return;

    const { width, height } = node.getBoundingClientRect();
    const left = Math.max(EDGE_MARGIN, Math.min(x, window.innerWidth - width - EDGE_MARGIN));
    const top = Math.max(EDGE_MARGIN, Math.min(y, window.innerHeight - height - EDGE_MARGIN));
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  }, [x, y]);

  useEffect(() => {
    if (!onDismiss) return undefined;

    const onPointerDown = (event: PointerEvent) => {
      if (nodeRef.current?.contains(event.target as Node)) return;
      onDismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };

    // `pointerdown` rather than `click`, in the capture phase: a right-click
    // produces `auxclick`, never `click`, so a menu opened from one could only
    // ever be closed by some later left-click.
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    // A card anchored to a row that has scrolled away is pointing at nothing.
    window.addEventListener('scroll', onDismiss, true);
    window.addEventListener('resize', onDismiss);

    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onDismiss, true);
      window.removeEventListener('resize', onDismiss);
    };
  }, [onDismiss]);

  return createPortal(
    <div
      ref={nodeRef}
      className={cn('fixed z-50', !onDismiss && 'pointer-events-none')}
      style={{ left: x, top: y }}
    >
      <div
        data-tails-part="popover"
        className={cn('animate-scale-in overflow-hidden', className)}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
