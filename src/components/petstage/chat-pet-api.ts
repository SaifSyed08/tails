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
