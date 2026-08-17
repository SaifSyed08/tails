import { Pencil, Star, Wand2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import { prefersReducedMotion } from '@/theme/motion';

import { petsApi, usePetLibraryVersion, type InstalledPet } from './marketplace-api';
import { usePetCarry, type PetCarryRelease } from './pet-carry';
import { isUntried, orderForCarousel } from './pet-filters';
import { PetThumbnail } from './PetThumbnail';
import { glideStep, nextStripScroll, readItemPitch } from './strip-scroll';

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
 * Dragging an icon onto a conversation publishes the same drag record as the
 * marketplace cards, so the sidebar rows that already accept a pet accept these
 * without knowing where they came from. The *gesture* is not the same one: a
 * pet leaving the tray is picked up and carried (`pet-carry.ts`), because he is
 * supposed to hang from the cursor and swing, and an HTML5 drag image is a
 * bitmap that cannot do either.
 */

export type PetCarouselProps = {
  /** Bumped by the owner when the library changes elsewhere. */
  refreshToken?: number;
  /** Opens this pet in the marketplace. */
  /**
   * Opens that pet's settings.
   *
   * It used to open the marketplace and drop the pet on the floor — the
   * argument was there and the caller ignored it, so "Edit" on a specific
   * animal took you to a page about all of them. The panel this opens is the
   * same one his own pill opens, which is the point: a pet has one settings
   * screen, not one per surface that can reach him.
   */
  onEdit: (pet: InstalledPet) => void;
  /**
   * Where a carried pet was let go — including over nothing at all.
   *
   * Omitted, the pets can still be picked up and the affordances still appear;
   * they simply have nowhere to go. The carousel deliberately does not know how
   * a chat gets a pet, or what letting go over nothing should mean; that is the
   * sidebar's business.
   */
  onCarryRelease?: (release: PetCarryRelease) => void;
  className?: string;
};

type MenuState = { pet: InstalledPet; x: number; y: number } | null;

export function PetCarousel({ refreshToken = 0, onEdit, onCarryRelease, className }: PetCarouselProps) {
  const [pets, setPets] = useState<InstalledPet[]>([]);
  const [menu, setMenu] = useState<MenuState>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const { carryingId, getCarryProps } = usePetCarry({ onRelease: onCarryRelease });
  // Any write to the library anywhere in the window, including the marketplace
  // two panes over installing something. Without it a pet the user has just
  // downloaded is missing from the strip until the app is reloaded.
  const libraryVersion = usePetLibraryVersion();

  const load = useCallback(() => petsApi.listPets()
    .then((library) => setPets(orderForCarousel(library.pets)))
    .catch(() => {
      // An empty strip is a perfectly good answer; the marketplace explains why.
    }), []);

  useEffect(() => {
    void load();
  }, [load, refreshToken, libraryVersion]);

  /**
   * The wheel, turned sideways and eased.
   *
   * `nextStripScroll` decides where to go; this gets there. The destination is
   * held here rather than handed to `scrollBy({ behavior: 'smooth' })`, which
   * looks like the obvious answer and is the wrong one: each new smooth scroll
   * measures its delta from wherever the last animation had reached, so two
   * notches in quick succession travel less than two notches. Keeping the
   * target ourselves means they add up, and it is also what lets the
   * end-of-strip check be asked of the destination.
   *
   * Registered by hand rather than as `onWheel` because React attaches wheel
   * listeners passively at the root, where `preventDefault` does nothing at
   * all — which would leave the strip scrolling twice, once from us and once
   * from the browser.
   */
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return undefined;

    let target: number | null = null;
    let frame: number | undefined;

    const glide = () => {
      frame = undefined;
      if (target === null) return;

      const { at, arrived } = glideStep(strip.scrollLeft, target);
      strip.scrollLeft = at;

      if (arrived) target = null;
      else frame = requestAnimationFrame(glide);
    };

    const onWheel = (event: WheelEvent) => {
      const next = nextStripScroll(event, {
        from: target ?? strip.scrollLeft,
        scrollWidth: strip.scrollWidth,
        clientWidth: strip.clientWidth,
        itemPitch: readItemPitch(strip),
      });
      if (next === null) return;

      event.preventDefault();
      target = next;

      // Reduced motion means no animation, not no scrolling: it arrives, it
      // just does not travel.
      if (prefersReducedMotion()) {
        strip.scrollLeft = next;
        target = null;
        return;
      }

      if (frame === undefined) frame = requestAnimationFrame(glide);
    };

    strip.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      strip.removeEventListener('wheel', onWheel);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
    // The strip is only in the document once there are pets to put in it.
  }, [pets.length]);

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
        ref={stripRef}
        className="flex gap-1 overflow-x-auto pb-0.5"
        // A horizontal strip that scrolls: the sidebar is narrow and a library
        // of twenty pets should not wrap into five rows of chrome.
        style={{ scrollbarWidth: 'none' }}
        role="list"
        aria-label="Your pets"
      >
        {pets.map((pet) => {
          const untried = isUntried(pet);
          const carrying = carryingId === pet.definition.id;

          return (
            <button
              key={pet.definition.id}
              type="button"
              role="listitem"
              {...getCarryProps(pet)}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setMenu({ pet, x: rect.left, y: rect.top - 8 });
              }}
              /*
                The same panel, from either button.

                Right-click did nothing here, which is worse than it sounds: the
                pet's own pill removed right-click deliberately and taught the
                gesture is not how you reach a pet — so a right-click that opens
                the operating system's menu over a pet is the app contradicting
                its own rule. Anchored to the slot rather than the pointer so
                the menu appears in the same place both ways.
              */
              onContextMenu={(event) => {
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                setMenu({ pet, x: rect.left, y: rect.top - 8 });
              }}
              title={`${pet.definition.displayName}${pet.active ? ' — on screen' : ''}`}
              aria-label={pet.definition.displayName}
              className={cn(
                'relative grid size-9 shrink-0 cursor-grab place-items-center rounded-md active:cursor-grabbing',
                'transition-[background-color,opacity] duration-quick hover:bg-accent',
                pet.active && 'bg-primary/15 outline outline-1 -outline-offset-1 outline-primary',
                busyId === pet.definition.id && 'opacity-50',
                // He is out of the tray. The slot he came from stays where it
                // is — the strip must not reflow around a gap while the user is
                // still deciding where to put him — but it stops pretending he
                // is in it.
                carrying && 'opacity-30',
              )}
            >
              {/* Clipped, because a pet whose grid the server could not work out
                  is stored as one enormous cell: a 5472x104 filmstrip becomes a
                  1368px-wide box in a 36px slot. On screen the strip's own
                  scroller hid that; a drag image rasterises the node's real
                  bounds, which is how the ghost ended up an invisible sliver. */}
              <span className="pointer-events-none flex size-full items-center justify-center overflow-hidden">
                <PetThumbnail pet={pet} size={26} />
              </span>

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
            <Pencil className="size-3.5" aria-hidden="true" /> Settings
          </button>
        </div>
      ) : null}
    </div>
  );
}
