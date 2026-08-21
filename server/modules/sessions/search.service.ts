import { sessionsService } from '@/modules/sessions/sessions.service.js';

/**
 * Searching what was actually said, not just what the chat is called.
 *
 * The sidebar filter matched titles and folders, which answers "which chat is
 * this" and not "where did we talk about the wake word". Titles are generated
 * from the first message, so a conversation that went somewhere else is
 * unfindable by the thing you remember about it — which is the normal case for
 * anything more than a day old.
 *
 * ## Why it scans rather than indexes
 *
 * Message bodies are not in this app's database. They live in the CLI's own
 * transcripts and are read back through the SDK, so there is nothing to add a
 * column to. The honest options were an index this app maintains — a second
 * copy of every conversation, kept in step with files another program owns — or
 * a bounded scan. The scan wins on the thing that matters: it cannot go stale,
 * and being wrong about search results is worse than being slow.
 *
 * ## Why it is bounded, and says so
 *
 * A scan over every transcript ever written is unbounded work triggered by a
 * keystroke. So it looks at the most recent conversations, stops at a match
 * ceiling, and **reports what it did not read** — `scanned` and `truncated` are
 * part of the result. A search that silently examines half your history and
 * presents the answer as complete is the failure this shape has to avoid.
 */

/** Conversations examined per search, newest first. */
const MAX_SESSIONS = 80;

/** Matching conversations returned. Beyond this the query is too broad to help. */
const MAX_RESULTS = 40;

/** Messages read per conversation. Long transcripts are read from the end. */
const MAX_MESSAGES = 400;

/** Characters of context kept around a hit. */
const SNIPPET_RADIUS = 90;

/** Transcripts read at once. */
const CONCURRENCY = 6;

export type SearchHit = {
  sessionId: string;
  title: string;
  cwd: string;
  updatedAt: string;
  /** Where the match was: the user's words or the assistant's. */
  role: 'user' | 'assistant' | 'other';
  /** The matching text with a little either side, and the match marked. */
  snippet: string;
  /** Matches in this conversation, which may exceed the one snippet shown. */
  count: number;
};

export type SearchResult = {
  query: string;
  hits: SearchHit[];
  /** Conversations actually read. */
  scanned: number;
  /**
   * True when the search stopped early.
   *
   * Surfaced rather than hidden: the user has to be able to tell "nothing
   * matches" from "I stopped looking", because those call for opposite next
   * actions.
   */
  truncated: boolean;
};

/** One line of context around the first hit, with the match wrapped in «». */
function snippetFor(text: string, needle: string): string {
  const at = text.toLowerCase().indexOf(needle);
  if (at < 0) return '';

  const from = Math.max(0, at - SNIPPET_RADIUS);
  const to = Math.min(text.length, at + needle.length + SNIPPET_RADIUS);

  const before = text.slice(from, at).replace(/\s+/g, ' ');
  const hit = text.slice(at, at + needle.length);
  const after = text.slice(at + needle.length, to).replace(/\s+/g, ' ');

  return `${from > 0 ? '…' : ''}${before}«${hit}»${after}${to < text.length ? '…' : ''}`;
}

async function searchOne(
  session: { id: string; title: string; cwd: string; updatedAt: string },
  needle: string,
): Promise<SearchHit | null> {
  let messages;
  try {
    messages = await sessionsService.getMessages(session.id, { limit: MAX_MESSAGES });
  } catch {
    // A transcript that cannot be read is not a match and not an error worth
    // failing the whole search over — one unreadable conversation must not make
    // the others unfindable.
    return null;
  }

  let count = 0;
  let first: SearchHit | null = null;

  for (const message of messages) {
    const text = message.content ?? '';
    if (!text || !text.toLowerCase().includes(needle)) continue;

    count += 1;
    if (first) continue;

    first = {
      sessionId: session.id,
      title: session.title,
      cwd: session.cwd,
      updatedAt: session.updatedAt,
      role: message.role === 'user' || message.role === 'assistant' ? message.role : 'other',
      snippet: snippetFor(text, needle),
      count: 0,
    };
  }

  if (!first) return null;
  return { ...first, count };
}

export async function searchConversations(rawQuery: string): Promise<SearchResult> {
  const needle = rawQuery.trim().toLowerCase();

  // Two characters matches most of the language and is not a search. The floor
  // is here rather than in the UI so the endpoint cannot be made expensive by a
  // caller that forgets it.
  if (needle.length < 3) {
    return { query: rawQuery, hits: [], scanned: 0, truncated: false };
  }

  /*
    Through the service rather than the repository, so the list is the same one
    the sidebar shows — owned conversations *and* the CLI's own, with the
    suppressed ones already removed. Searching a different set from the one on
    screen would return hits the user cannot open.
  */
  const candidates = (await sessionsService.listConversations(MAX_SESSIONS))
    .slice(0, MAX_SESSIONS);

  const hits: SearchHit[] = [];
  let scanned = 0;
  let stopped = false;

  /*
    A small pool rather than all at once. Each task reads a transcript off disk
    through the SDK, and eighty of those in parallel is eighty file handles and
    a stalled event loop — for a result the user is watching a spinner for.
  */
  for (let index = 0; index < candidates.length && !stopped; index += CONCURRENCY) {
    const batch = candidates.slice(index, index + CONCURRENCY);
    const found = await Promise.all(batch.map((session) => searchOne(session, needle)));

    scanned += batch.length;
    for (const hit of found) {
      if (hit) hits.push(hit);
    }

    if (hits.length >= MAX_RESULTS) stopped = true;
  }

  return {
    query: rawQuery,
    hits: hits.slice(0, MAX_RESULTS),
    scanned,
    // Either the result set filled up, or the conversation list was long
    // enough that older ones went unread.
    truncated: stopped || candidates.length >= MAX_SESSIONS,
  };
}
