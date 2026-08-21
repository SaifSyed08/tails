/**
 * Which pets the user has decided live on the desktop.
 *
 * ## Why this is not a ref
 *
 * A pet assigned to a conversation is kept *off* the desktop even after you
 * navigate away from that conversation — otherwise opening a different chat
 * makes the pet you were just looking at appear floating over everything, as a
 * side effect of a click. The escape hatch from that rule is the user carrying
 * him out of the chat by hand, which is a decision rather than a side effect.
 *
 * That decision was remembered in a `useRef`, which meant it was remembered for
 * exactly as long as the component stayed mounted — and the component unmounts
 * on the very navigation the rule is about. So the measured sequence was: carry
 * him out to the desktop, open the conversation he belongs to (he steps aside,
 * correctly), leave for a conversation with no pet — and he never comes back,
 * because the memory of having put him there went with the remount. The rule
 * then held forever and there was nothing left that could clear it.
 *
 * So the claim outlives the component, and the storage is per-machine rather
 * than per-session because the choice is about where a companion lives.
 *
 * ## And why it can be revoked
 *
 * A claim that is only ever added to is a rule that eventually applies to
 * everybody. He is standing in a chat again is the natural end of it: it is the
 * same gesture in the other direction, and it is what the release path already
 * says happens — the assignment is never touched by carrying him out, so
 * coming back to that conversation brings him in.
 */

const KEY = 'tails.pets.desktopClaim';

function read(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
  } catch {
    // Blocked or corrupt storage costs the escape hatch, not the feature.
    return new Set();
  }
}

function write(claims: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...claims]));
  } catch {
    // As above.
  }
}

/** Whether this pet is on the desktop because the user put him there. */
export function claimsDesktop(petId: string | null): boolean {
  if (!petId) return false;
  return read().has(petId);
}

/** He was carried out of a chat and left there. */
export function claimDesktop(petId: string): void {
  const claims = read();
  if (claims.has(petId)) return;
  claims.add(petId);
  write(claims);
}

/** He is standing in a conversation again, so the desktop is not where he lives. */
export function releaseDesktopClaim(petId: string): void {
  const claims = read();
  if (!claims.delete(petId)) return;
  write(claims);
}
