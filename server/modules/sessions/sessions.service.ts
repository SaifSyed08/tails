import { getSessionMessages, listSessions } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sessionsRepository } from '@/db/sessions.repository.js';
import { normalizeSdkMessage } from '@/modules/chat/normalize.js';
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
    if (existing) return existing;

    return sessionsRepository.createSession({
      id: sessionId,
      title: input.title ? deriveTitle(input.title) : 'New chat',
      cwd: input.cwd || os.homedir(),
    });
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
   * session is already mapped to one of ours, it is not listed twice.
   */
  async listConversations(limit = 50): Promise<SessionListItem[]> {
    const owned = sessionsRepository.listSessions(limit);
    const ownedProviderIds = new Set(
      owned.map((session) => session.providerSessionId).filter((id): id is string => id !== null),
    );

    const items: SessionListItem[] = owned.map((session) => ({
      id: session.id,
      title: session.title,
      cwd: session.cwd,
      updatedAt: session.updatedAt,
      external: false,
    }));

    try {
      const external = await listSessions({ limit });
      for (const info of external) {
        if (ownedProviderIds.has(info.sessionId)) continue;
        items.push({
          id: info.sessionId,
          title: info.customTitle || info.summary || info.firstPrompt || 'Untitled',
          cwd: info.cwd ?? '',
          updatedAt: new Date(info.lastModified).toISOString(),
          external: true,
        });
      }
    } catch {
      // No Claude Code history yet, or an unreadable transcript directory.
      // The app's own sessions are still perfectly listable.
    }

    return items
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
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

    const raw = await getSessionMessages(providerSessionId, {
      ...(owned?.cwd ? { dir: owned.cwd } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.offset !== undefined ? { offset: options.offset } : {}),
    });

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

    return sessionsRepository.createSession({
      id: providerSessionId,
      providerSessionId,
      title: deriveTitle(title),
      cwd,
      // Carry the transcript's real last-activity time across. Stamping "now"
      // here is what made merely opening an old chat jump it to the top of the
      // sidebar — the list orders by last message, not last viewed.
      lastActivityAt,
    });
  },

  renameSession(sessionId: string, title: string): ChatSession {
    this.getSession(sessionId);
    sessionsRepository.renameSession(sessionId, deriveTitle(title));
    return this.getSession(sessionId);
  },

  /**
   * Changes the folder a conversation runs in.
   *
   * Validated here rather than in the route because a non-existent path would
   * otherwise surface much later, as an opaque spawn failure from the agent
   * subprocess.
   */
  setWorkingDirectory(sessionId: string, cwd: string): ChatSession {
    this.getSession(sessionId);

    const resolved = path.resolve(cwd);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new AppError('That folder does not exist.', {
        code: 'CWD_NOT_FOUND',
        statusCode: 400,
      });
    }

    sessionsRepository.setCwd(sessionId, resolved);
    return this.getSession(sessionId);
  },

  /** The folder a brand-new conversation should start in. */
  defaultWorkingDirectory(): string {
    return os.homedir();
  },

  deleteSession(sessionId: string): { id: string } {
    if (!sessionsRepository.deleteSession(sessionId)) {
      throw new AppError('Conversation not found.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
    }
    return { id: sessionId };
  },
};
