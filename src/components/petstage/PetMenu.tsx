import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import type { InstalledPet } from '@/components/marketplace';

import { MAX_PET_SCALE, MIN_PET_SCALE, type PetStage } from './chat-pet-api';

/**
 * The in-chat pet's options.
 *
 * Two dials, because two things about a pet standing in your chat are matters
 * of taste rather than of design: how big he is, and whether he moves. Both are
 * per pet — a sprite drawn at 32px and one drawn at 96 do not want the same
 * size — and both are saved, so the answer survives the conversation.
 *
 * It opens from the right-click and from the pill's button, and it is the same
 * menu either way: one place decides what the pet's options are.
 *
 * Positioned at the pointer and nudged back inside the viewport, rather than
 * anchored to the pet: he is standing at the bottom of the window, so a menu
 * hung below him would open off the bottom edge every time.
 */

/** Rough size, used only to keep the menu on screen before it has laid out. */
const MENU_WIDTH = 232;
const MENU_HEIGHT = 148;
const EDGE_MARGIN = 8;

export type PetMenuProps = {
  pet: InstalledPet;
  stage: PetStage;
  /** Where it was asked for, in viewport coordinates. */
  x: number;
  y: number;
  onChange: (stage: PetStage) => void;
  onClose: () => void;
};

export function PetMenu({ pet, stage, x, y, onChange, onClose }: PetMenuProps) {
  const nodeRef = useRef<HTMLDivElement | null>(null);

  // Every ordinary way out of a menu. `pointerdown` rather than `click` so it
  // closes on the press that starts a drag elsewhere, not after it finishes.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!nodeRef.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const left = Math.max(EDGE_MARGIN, Math.min(x, window.innerWidth - MENU_WIDTH - EDGE_MARGIN));
  const top = Math.max(EDGE_MARGIN, Math.min(y, window.innerHeight - MENU_HEIGHT - EDGE_MARGIN));

  return createPortal(
    <div
      ref={nodeRef}
      data-tails-part="card"
      role="dialog"
      aria-label={`${pet.definition.displayName} options`}
      className="fixed z-50 w-[232px] space-y-3 p-3 text-sm shadow-lg"
      style={{ left: `${left}px`, top: `${top}px` }}
      // The menu is over the transcript; a stray click inside it must not reach
      // whatever is behind, and a drag started on the slider is not a pet drag.
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <p className="font-display text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {pet.definition.displayName}
      </p>

      <label className="block space-y-1">
        <span className="flex items-baseline justify-between">
          <span>Size</span>
          <span className="text-xs text-muted-foreground">{Math.round(stage.scale * 100)}%</span>
        </span>
        <input
          type="range"
          min={MIN_PET_SCALE}
          max={MAX_PET_SCALE}
          step={0.05}
          value={stage.scale}
          onChange={(event) => onChange({ ...stage, scale: Number(event.target.value) })}
          className="w-full accent-primary"
        />
      </label>

      <label className="flex items-center justify-between gap-3">
        <span>
          Wander
          <span className="block text-xs text-muted-foreground">
            He strolls about when nothing is happening.
          </span>
        </span>
        <input
          type="checkbox"
          checked={stage.walks}
          onChange={(event) => onChange({ ...stage, walks: event.target.checked })}
          className="size-4 accent-primary"
        />
      </label>
    </div>,
    document.body,
  );
}
