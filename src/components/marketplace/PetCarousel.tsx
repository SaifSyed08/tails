import { Pencil, Star, Wand2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

import { petsApi, type InstalledPet } from './marketplace-api';
import { isUntried, orderForCarousel } from './pet-filters';
import { endPetDrag, startPetDrag } from './pet-drag';
import { PetThumbnail } from './PetThumbnail';

/**
 * The pet strip.
 *
 * A row of everything installed, sitting where the user's hand already is —
 * just above Settings — so putting a different companion on screen is one click
 * rather than a trip to the marketplace. It is the marketplace's shortcut, not
 * a second copy of it: anything that needs explaining lives there, and this
 * shows a face, a state, and three verbs.
 *
 * Order is starred, then most recently used, then the rest; the two marks are
 * the only chrome. A star means the user pinned it. A dot means nobody has ever
 * put this pet on screen, which is the one fact a row of faces cannot otherwise
 * convey — a pet you imported and forgot looks exactly like your favourite.
 *
 * Dragging an icon onto a conversation uses the same drag contract as the
 * marketplace cards, so the sidebar rows that already accept a pet accept these
 * without knowing where they came from.
 */

export type PetCarouselProps = {
  /** Bumped by the owner when the library changes elsewhere. */
  refreshToken?: number;
  /** Opens this pet in the marketplace. */
  onEdit: (pet: InstalledPet) => void;
  className?: string;
};

type MenuState = { pet: InstalledPet; x: number; y: number } | null;

export function PetCarousel({ refreshToken = 0, onEdit, className }: PetCarouselProps) {
  const [pets, setPets] = useState<InstalledPet[]>([]);
  const [menu, setMenu] = useState<MenuState>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => petsApi.listPets()
    .then((library) => setPets(orderForCarousel(library.pets)))
    .catch(() => {
      // An empty strip is a perfectly good answer; the marketplace explains why.
    }), []);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  // Dismissed by anything that is not the menu itself, the way the sidebar's
  // other popovers behave.
  useEffect(() => {
    if (!menu) return undefined;

    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null);
    };

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [menu]);

  const run = async (pet: InstalledPet, action: () => Promise<unknown>) => {
    setBusyId(pet.definition.id);
    try {
      await action();
      await load();
    } catch {
      // The marketplace is where failures get explained; a strip of icons has
      // nowhere to put a message, and reloading shows the truth either way.
      await load();
    } finally {
      setBusyId(null);
      setMenu(null);
    }
  };

  if (pets.length === 0) return null;

  return (
    <div className={cn('border-t border-border px-2 py-1.5', className)}>
      <div
        className="flex gap-1 overflow-x-auto pb-0.5"
        // A horizontal strip that scrolls: the sidebar is narrow and a library
        // of twenty pets should not wrap into five rows of chrome.
        style={{ scrollbarWidth: 'none' }}
        role="list"
        aria-label="Your pets"
      >
        {pets.map((pet) => {
          const untried = isUntried(pet);

          return (
            <button
              key={pet.definition.id}
              type="button"
              role="listitem"
              draggable
              onDragStart={(event) => startPetDrag(event, {
                kind: 'installed',
                id: pet.definition.id,
                displayName: pet.definition.displayName,
              })}
              onDragEnd={endPetDrag}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setMenu({ pet, x: rect.left, y: rect.top - 8 });
              }}
              title={`${pet.definition.displayName}${pet.active ? ' — on screen' : ''}`}
              aria-label={pet.definition.displayName}
              className={cn(
                'relative grid size-9 shrink-0 cursor-grab place-items-center rounded-md active:cursor-grabbing',
                'transition-colors duration-quick hover:bg-accent',
                pet.active && 'bg-primary/15 outline outline-1 -outline-offset-1 outline-primary',
                busyId === pet.definition.id && 'opacity-50',
              )}
            >
              <PetThumbnail pet={pet} size={26} />

              {pet.starred ? (
                <Star
                  className="absolute -right-0.5 -top-0.5 size-2.5 fill-primary text-primary"
                  aria-label="Starred"
                />
              ) : untried ? (
                <span
                  className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-primary"
                  aria-label="Not tried yet"
                />
              ) : null}
            </button>
          );
        })}
      </div>

      {menu ? (
        <div
          ref={menuRef}
          data-tails-part="popover"
          className="fixed z-50 w-40 -translate-y-full py-1 shadow-lg"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
        >
          <p className="truncate px-3 pb-1 text-[11px] text-muted-foreground">
            {menu.pet.definition.displayName}
          </p>

          <button
            type="button"
            role="menuitem"
            onClick={() => void run(menu.pet, () => petsApi.setActive(
              menu.pet.definition.id,
              !menu.pet.active,
            ))}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors duration-quick hover:bg-accent"
          >
            <Wand2 className="size-3.5" aria-hidden="true" />
            {menu.pet.active ? 'Take off screen' : 'Apply'}
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => void run(menu.pet, () => petsApi.setStarred(
              menu.pet.definition.id,
              !menu.pet.starred,
            ))}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors duration-quick hover:bg-accent"
          >
            <Star className={cn('size-3.5', menu.pet.starred && 'fill-primary text-primary')} aria-hidden="true" />
            {menu.pet.starred ? 'Unstar' : 'Star'}
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onEdit(menu.pet);
              setMenu(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors duration-quick hover:bg-accent"
          >
            <Pencil className="size-3.5" aria-hidden="true" /> Edit
          </button>
        </div>
      ) : null}
    </div>
  );
}
