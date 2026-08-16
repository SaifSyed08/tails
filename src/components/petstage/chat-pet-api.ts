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
