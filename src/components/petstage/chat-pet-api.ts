import type { InstalledPet } from '@/components/marketplace';

/**
 * Which pet belongs to a conversation.
 *
 * Its own call rather than a method on the marketplace's client, because that
 * client belongs to another surface and this needs one question answered: given
 * a chat, who lives in it? The server resolves the assignment — see
 * `resolveDisplayPet` — so nothing here has to know how pets are stored.
 *
 * `source` distinguishes a pet assigned to *this* chat from the globally active
 * one, which matters: the global pet lives on the desktop and is not a guest in
 * every conversation.
 */
export type SessionPet = {
  pet: InstalledPet | null;
  source: 'session' | 'global' | 'none';
};

/**
 * Whoever is on the desktop right now.
 *
 * The same resolver with no conversation attached, which is exactly what the
 * desktop window itself asks — so the panel opened from the pet's own pill is
 * guaranteed to be about the pet you clicked.
 */
export async function readDisplayPet(): Promise<SessionPet> {
  const response = await fetch('/api/pets/display', { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`The active pet could not be read (${response.status}).`);
  return response.json() as Promise<SessionPet>;
}

export async function readSessionPet(sessionId: string): Promise<SessionPet> {
  const response = await fetch(
    `/api/pets/display?sessionId=${encodeURIComponent(sessionId)}`,
    { headers: { accept: 'application/json' } },
  );
  if (!response.ok) throw new Error(`The pet for this chat could not be read (${response.status}).`);
  return response.json() as Promise<SessionPet>;
}

/**
 * How a pet is shown where he stands.
 *
 * Declared here rather than imported because the marketplace's `InstalledPet`
 * does not carry the field yet — the server sends it, and this is the surface
 * that reads and writes it. `readStage` is therefore a validation, not a cast:
 * a payload from an older server simply yields the defaults.
 */
export type PetStage = {
  /** Multiplier on his standing height. 1 is the designed size. */
  scale: number;
  /** Whether he wanders about on his own. */
  walks: boolean;
};

export const DEFAULT_STAGE: PetStage = { scale: 1, walks: true };

/** Matches the server's clamp. A slider that can ask for what is refused is a lie. */
export const MIN_PET_SCALE = 0.6;
export const MAX_PET_SCALE = 2;

export function readStage(pet: InstalledPet | null): PetStage {
  const stored = (pet as { stage?: Partial<PetStage> } | null)?.stage;
  const scale = typeof stored?.scale === 'number' && Number.isFinite(stored.scale)
    ? Math.min(MAX_PET_SCALE, Math.max(MIN_PET_SCALE, stored.scale))
    : DEFAULT_STAGE.scale;

  return {
    scale,
    walks: typeof stored?.walks === 'boolean' ? stored.walks : DEFAULT_STAGE.walks,
  };
}

/** Saves the stage settings. The server clamps too; this is not the only guard. */
export async function savePetStage(petId: string, stage: PetStage): Promise<void> {
  const response = await fetch(`/api/pets/${encodeURIComponent(petId)}/stage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(stage),
  });
  if (!response.ok) throw new Error(`That setting could not be saved (${response.status}).`);
}

/**
 * Makes this pet the desktop pet.
 *
 * Carrying him out of a chat is a decision about who lives on the desktop, and
 * the desktop window only ever shows the *active* pet. Without this, dragging a
 * pet out either produced nothing (no active pet) or produced somebody else —
 * whoever had last been activated in the marketplace — which is the pet
 * equivalent of picking up a cat and putting down a dog.
 */
export async function activatePet(petId: string): Promise<void> {
  const response = await fetch(`/api/pets/${encodeURIComponent(petId)}/activate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ active: true }),
  });
  if (!response.ok) throw new Error(`That pet could not be put on the desktop (${response.status}).`);
}

/**
 * Gives a pet to a conversation.
 *
 * The way back in. Taking him out of a chat is a gesture — carry him past the
 * edge — and until now the only way to reverse it was to find him in the
 * marketplace and drop him on the right conversation, which is a lot of
 * furniture to move to undo one flick of the wrist.
 *
 * Assignment belongs to the sessions module, so this posts there. The pets
 * module hears about it separately, which is why the caller also marks him
 * used: the carousel's ordering is built on that.
 */
export async function assignPetToSession(sessionId: string, petId: string): Promise<void> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ petId }),
  });
  if (!response.ok) throw new Error(`He could not be sent to this chat (${response.status}).`);

  // Best effort: a pet who is in a conversation has been tried, and the
  // carousel says so. A failure here costs a dot, not the assignment.
  void fetch(`/api/pets/${encodeURIComponent(petId)}/used`, { method: 'POST' }).catch(() => {});
}
