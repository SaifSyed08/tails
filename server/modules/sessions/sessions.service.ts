import { getSessionMessages, listSessions } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sessionsRepository } from '@/db/sessions.repository.js';
import { normalizeSdkMessage } from '@/modules/chat/normalize.js';
import { publishSessionsChanged } from '@/shared/broadcast.js';
import type { ChatSession, NormalizedMessage, SessionListItem } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * Turns the first line of a prompt into a conversation title.
 *
 * Short and boring on purpose — the SDK generates a better summary once the
 * transcript exists, and this is only what the sidebar shows in the meantime.
 */
function deriveTitle(prompt: string): string {
  const firstLine = prompt.split('\n').find((line) => line.trim()) ?? 'New chat';
  const trimmed = firstLine.trim();
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
}

/**
 * Conversations, as the app sees them.
 *
 * Two sources are merged. Sessions this app created live in SQLite with a
 * stable app id. Sessions Claude Code created elsewhere — the CLI, another
 * tool — are discovered through the SDK. Both appear in the sidebar; only the
 * former can be resumed under an app id, and the latter are adopted into the
 * DB the first time they are opened.
 */
export const sessionsService = {
  /**
   * Mints a conversation without writing a row.
   *
   * A chat with nothing in it is not a conversation, so nothing is persisted
   * until the first send — `ensureSession` creates the row then. This returns
   * the id and default folder the client needs in order to have somewhere to
   * type, and is the reason the sidebar no longer accumulates a "New chat"
   * every time the app is opened.
   */
  draftSession(): ChatSession {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      providerSessionId: null,
      title: 'New chat',
      cwd: os.homedir(),
      createdAt: now,
      updatedAt: now,
      pinnedAt: null,
      archivedAt: null,
    };
  },

  /** Creates a conversation. The id is minted here, before the first send. */
  createSession(input: { cwd?: string; title?: string } = {}): ChatSession {
    return sessionsRepository.createSession({
      id: randomUUID(),
      title: input.title ? deriveTitle(input.title) : 'New chat',
      cwd: input.cwd || os.homedir(),
    });
  },

  /**
   * Returns the session for an id, creating it if the client minted one first.
   *
   * The client allocates the id so it can navigate to the conversation URL
   * before the first send completes. The row appearing late is normal, not an
   * error.
   */
  ensureSession(sessionId: string, input: { cwd?: string; title?: string } = {}): ChatSession {
    const existing = sessionsRepository.getSession(sessionId);
    if (existing) {
      // A row can exist before the first send when the user retargeted the
      // folder or renamed the draft. Such a row still carries the placeholder
      // title, and this is the only moment a real prompt is available to
      // replace it with.
      if (input.title && existing.title === 'New chat' && !existing.providerSessionId) {
        sessionsRepository.renameSession(sessionId, deriveTitle(input.title));
        return this.getSession(sessionId);
      }
      return existing;
    }

    return sessionsRepository.createSession({
      id: sessionId,
      title: input.title ? deriveTitle(input.title) : 'New chat',
      cwd: input.cwd || os.homedir(),
    });
  },

  /** The session, or null when the id belongs to a draft that has no row yet. */
  findSession(sessionId: string): ChatSession | null {
    return sessionsRepository.getSession(sessionId);
  },

  getSession(sessionId: string): ChatSession {
    const session = sessionsRepository.getSession(sessionId);
    if (!session) {
      throw new AppError('Conversation not found.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
    }
    return session;
  },

  /**
   * The sidebar list.
   *
   * App-owned sessions come first and win on identity: if a Claude Code
   * session is already mapped to one of ours, it is not listed twice. The
   * suppression set is built from *every* owned row, not just the ones being
   * returned, so archiving or deleting a conversation cannot resurrect it
   * through its external twin.
   *
   * Ordering is pinned-first, then by last message. It is computed on epoch
   * milliseconds rather than by comparing the strings: the two sources format
   * their timestamps differently, and a lexical compare silently interleaved
   * them wrongly.
   */
  async listConversations(
    limit = 50,
    options: { archived?: boolean } = {},
  ): Promise<SessionListItem[]> {
    const archived = options.archived === true;
    const owned = sessionsRepository.listSessions({ limit, archived });
    const suppressed = new Set([
      ...sessionsRepository.listOwnedProviderSessionIds(),
      ...sessionsRepository.listHiddenProviderSessionIds(),
    ]);

    const items: SessionListItem[] = owned.map((session) => ({
      id: session.id,
      title: session.title,
      cwd: session.cwd,
      updatedAt: session.updatedAt,
      external: false,
      pinned: session.pinnedAt !== null,
      archived: session.archivedAt !== null,
    }));

    // Claude Code's own history has no notion of our archive, so the archived
    // view is app-owned rows only.
    if (!archived) {
      try {
        const external = await listSessions({ limit });
        for (const info of external) {
          if (suppressed.has(info.sessionId)) continue;
          items.push({
            id: info.sessionId,
            title: info.customTitle || info.summary || info.firstPrompt || 'Untitled',
            cwd: info.cwd ?? '',
            updatedAt: new Date(info.lastModified).toISOString(),
            external: true,
            pinned: false,
            archived: false,
          });
        }
      } catch {
        // No Claude Code history yet, or an unreadable transcript directory.
        // The app's own sessions are still perfectly listable.
      }
    }

    return items
      .sort((left, right) => {
        if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
        return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      })
      .slice(0, limit);
  },

  /**
   * Removes every conversation that never produced a transcript.
   *
   * Called once at boot. Earlier builds wrote a row the moment the app opened
   * and again for every "New chat" click, so an existing install has a pile of
   * empty ones to clear; the draft-until-first-send lifecycle stops new ones
   * accumulating.
   */
  sweepEmptySessions(): number {
    const removed = sessionsRepository.deleteEmptySessions();
    if (removed > 0) publishSessionsChanged();
    return removed;
  },

  /**
   * Loads a conversation's transcript.
   *
   * Reads through the SDK rather than parsing JSONL: the SDK owns that format
   * and reimplementing the parse is how the reference implementation ended up
   * with 900 lines of scraping to maintain.
   */
  async getMessages(
    sessionId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<NormalizedMessage[]> {
    const owned = sessionsRepository.getSession(sessionId);
    // An app session that has never run has no provider transcript yet; that
    // is an empty history, not a missing one.
    const providerSessionId = owned ? owned.providerSessionId : sessionId;
    if (!providerSessionId) return [];

    let raw;
    try {
      raw = await getSessionMessages(providerSessionId, {
        ...(owned?.cwd ? { dir: owned.cwd } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.offset !== undefined ? { offset: options.offset } : {}),
      });
    } catch (error) {
      // A client-minted id with no row is a draft the user has not sent in
      // yet, so there is no transcript on disk to find. For a session we do
      // own, an unreadable transcript is a real failure and must surface.
      if (owned) throw error;
      return [];
    }

    // The same normalizer as the live path, so history and streaming can never
    // render differently.
    return raw.flatMap((message) => normalizeSdkMessage(message, sessionId));
  },

  /**
   * Adopts a Claude Code session discovered on disk into an app session.
   *
   * Called when the user opens an external conversation. The provider id
   * doubles as the app id here, which is safe because it is already unique and
   * means the transcript stays reachable under the same URL.
   */
  adoptExternalSession(
    providerSessionId: string,
    cwd: string,
    title: string,
    lastActivityAt?: string,
  ): ChatSession {
    const existing = sessionsRepository.findByProviderSessionId(providerSessionId)
      ?? sessionsRepository.getSession(providerSessionId);
    if (existing) return existing;

    const adopted = sessionsRepository.createSession({
      id: providerSessionId,
      providerSessionId,
      title: deriveTitle(title),
      cwd,
      // Carry the transcript's real last-activity time across. Stamping "now"
      // here is what made merely opening an old chat jump it to the top of the
      // sidebar — the list orders by last message, not last viewed.
      lastActivityAt,
    });
    publishSessionsChanged(adopted.id);
    return adopted;
  },

  /**
   * Retitles a conversation.
   *
   * `ensureSession` rather than `getSession`: a draft can be renamed before
   * anything has been sent in it, and 404-ing there would make the header's
   * title field mysteriously fail on a brand-new chat. The row it creates has
   * no transcript, so it stays out of the sidebar either way.
   */
  renameSession(sessionId: string, title: string): ChatSession {
    this.ensureSession(sessionId, { title });
    sessionsRepository.renameSession(sessionId, deriveTitle(title));
    const renamed = this.getSession(sessionId);
    publishSessionsChanged(sessionId);
    return renamed;
  },

  /** Pinned conversations sort above everything else in the sidebar. */
  setPinned(sessionId: string, pinned: boolean): ChatSession {
    this.getSession(sessionId);
    sessionsRepository.setPinned(sessionId, pinned);
    const updated = this.getSession(sessionId);
    publishSessionsChanged(sessionId);
    return updated;
  },

  /** Archiving takes a conversation out of the main list without deleting it. */
  setArchived(sessionId: string, archived: boolean): ChatSession {
    this.getSession(sessionId);
    sessionsRepository.setArchived(sessionId, archived);
    const updated = this.getSession(sessionId);
    publishSessionsChanged(sessionId);
    return updated;
  },

  /**
   * Changes the folder a conversation runs in.
   *
   * Validated here rather than in the route because a non-existent path would
   * otherwise surface much later, as an opaque spawn failure from the agent
   * subprocess.
   */
  setWorkingDirectory(sessionId: string, cwd: string): ChatSession {
    const resolved = path.resolve(cwd);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new AppError('That folder does not exist.', {
        code: 'CWD_NOT_FOUND',
        statusCode: 400,
      });
    }

    // Same reasoning as `renameSession`: retargeting the folder is one of the
    // things people do before typing the first message.
    this.ensureSession(sessionId, { cwd: resolved });
    sessionsRepository.setCwd(sessionId, resolved);
    return this.getSession(sessionId);
  },

  /** The folder a brand-new conversation should start in. */
  defaultWorkingDirectory(): string {
    return os.homedir();
  },

  /**
   * Removes a conversation from the app.
   *
   * The row goes; the Claude Code transcript it points at does not, because
   * `~/.claude` belongs to the CLI and this app only reads it. A tombstone
   * keeps that transcript from reappearing in the list as an "external"
   * conversation the next time the SDK enumerates history.
   */
  deleteSession(sessionId: string): { id: string } {
    const existing = sessionsRepository.getSession(sessionId);
    if (!existing) {
      throw new AppError('Conversation not found.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
    }

    sessionsRepository.deleteSession(sessionId);
    if (existing.providerSessionId) {
      sessionsRepository.hideProviderSession(existing.providerSessionId);
    }
    publishSessionsChanged(sessionId);
    return { id: sessionId };
  },
};
