import { useCallback, useEffect, useState } from 'react';

/**
 * What you have typed and not sent yet.
 *
 * ## Why this is a module and not component state
 *
 * The drafts already belonged to conversations rather than to the composer —
 * keying them by session is what stopped an unsent sentence following you into
 * every other chat. But they were held in `useState`, which survives exactly as
 * long as the composer is mounted, and the composer is not mounted while you are
 * in the marketplace, or in settings, or anywhere else that replaces the chat.
 *
 * So the leak was fixed and the loss was not: open a new chat, write three
 * paragraphs, go and look at a pet, come back to an empty box. Worse in a new
 * chat than anywhere else, because there is no transcript to remind you what you
 * were saying.
 *
 * Lifting the store out of the component is the whole fix. The same arrangement
 * `unread.ts` uses, and for the same reason stated there: the dot's job is to
 * survive not being looked at, and so is a draft's.
 *
 * ## Why it persists to disk
 *
 * A reload is not a decision to throw work away. Neither is a crash, and neither
 * is the desktop app restarting to apply an update. If the box is going to keep
 * text across a trip to the marketplace, keeping it across a reload is the same
 * promise — and breaking it there is worse, because a reload is exactly when
 * someone assumes their unsent message is gone and retypes it.
 */

const KEY = 'tails.drafts';

/**
 * The key a conversation that does not exist yet writes under.
 *
 * A new chat has no id until its first message creates one, and that message is
 * the thing being typed. Without a slot of its own the one draft nobody can
 * recover from a transcript is the one that gets dropped.
 */
export const NEW_CHAT_DRAFT = '__unsaved';

/**
 * How many conversations keep a draft.
 *
 * Old ones fall off the end rather than accumulating for the life of the
 * install. Fifty is far more than anyone has half-written at once, and the cap
 * exists so a long-lived app cannot grow this without bound — the same reason
 * `unread.ts` caps its own set.
 */
export const MAX_DRAFTS = 50;

/**
 * The longest draft kept.
 *
 * A pasted file can be megabytes, and writing that to `localStorage` on every
 * keystroke is how typing starts to stutter. Past this the draft still works in
 * the box for as long as the composer is mounted; it simply stops being one of
 * the things that survives a reload.
 */
export const MAX_LENGTH = 20_000;

type Drafts = Record<string, string>;

let drafts: Drafts = load();
/** Insertion order is recency order, which is what the cap trims by. */
let order: string[] = Object.keys(drafts);
const listeners = new Set<() => void>();

function load(): Drafts {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const entries = Object.entries(parsed as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '');

    return Object.fromEntries(entries);
  } catch {
    // A corrupt or blocked store costs the drafts, not the composer.
    return {};
  }
}

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(drafts));
  } catch {
    // Full or blocked. The draft still lives in memory for this session, which
    // is what it did before this module existed.
  }
}

function announce(): void {
  persist();
  for (const listener of listeners) listener();
}

export function readDraft(key: string): string {
  return drafts[key] ?? '';
}

export function writeDraft(key: string, value: string): void {
  if ((drafts[key] ?? '') === value) return;

  const next = { ...drafts };
  if (value === '') {
    // An emptied draft is deleted rather than stored blank, so the cap counts
    // conversations someone is actually mid-sentence in.
    delete next[key];
    order = order.filter((entry) => entry !== key);
  } else {
    next[key] = value.slice(0, MAX_LENGTH);
    order = [key, ...order.filter((entry) => entry !== key)];

    for (const stale of order.slice(MAX_DRAFTS)) delete next[stale];
    order = order.slice(0, MAX_DRAFTS);
  }

  drafts = next;
  announce();
}

/** Every draft goes. Offered for a "clear everything" control, not used on send. */
export function clearDrafts(): void {
  drafts = {};
  order = [];
  announce();
}

/**
 * One conversation's draft, and the setter that keeps every window in step.
 *
 * Returns the same shape `useState` does, so the composer reads as though the
 * draft were local — which is how it should read. Where it is kept is this
 * module's business.
 */
export function useDraft(key: string): [string, (next: string | ((current: string) => string)) => void] {
  const [value, setValue] = useState(() => readDraft(key));

  useEffect(() => {
    const listener = () => setValue(readDraft(key));
    listeners.add(listener);
    // Re-read on subscribe, and on a change of key: the store may have moved
    // between this component rendering and its effect running, and the draft
    // for a newly-opened conversation is not the one currently in state.
    listener();
    return () => { listeners.delete(listener); };
  }, [key]);

  const write = useCallback((next: string | ((current: string) => string)) => {
    const resolved = typeof next === 'function' ? next(readDraft(key)) : next;
    writeDraft(key, resolved);
  }, [key]);

  return [value, write];
}
