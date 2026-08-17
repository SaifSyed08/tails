import type { ModelChoice, NormalizedMessage } from '@/types/chat';

export type SessionListItem = {
  id: string;
  title: string;
  cwd: string;
  /** Last message, not last viewed — the sidebar's sort key. */
  updatedAt: string;
  external: boolean;
  pinned: boolean;
  archived: boolean;
  /** Null for external chats, which have no row here to carry an assignment. */
  petId: string | null;
};

export type ChatSession = {
  id: string;
  providerSessionId: string | null;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  pinnedAt: string | null;
  archivedAt: string | null;
  /** The companion assigned to this conversation, if it has one of its own. */
  petId: string | null;
  /** True once the user has named this chat; generated titles never override it. */
  titlePinned: boolean;
};

/**
 * Throws on a non-2xx, surfacing the server's error code when it sent one.
 *
 * Centralised so no caller has to remember that `fetch` resolves on a 500.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message = body?.error?.message ?? `Request failed with ${response.status}`;
    throw new Error(message);
  }

  return response.json() as Promise<T>;
}

export const api = {
  listSessions: (limit = 50, archived = false) =>
    request<SessionListItem[]>(`/sessions?limit=${limit}${archived ? '&archived=1' : ''}`),

  /**
   * Mints a conversation the server has not written down.
   *
   * A chat is persisted on its first message, not when it is opened, so this
   * returns only the id and folder the UI needs to have somewhere to type.
   */
  draftSession: () => request<ChatSession>('/sessions/draft'),

  createSession: (input: { cwd?: string; title?: string } = {}) =>
    request<ChatSession>('/sessions', { method: 'POST', body: JSON.stringify(input) }),

  getMessages: (sessionId: string) =>
    request<NormalizedMessage[]>(`/sessions/${encodeURIComponent(sessionId)}/messages`),

  adoptSession: (sessionId: string, input: { cwd: string; title: string; lastActivityAt?: string }) =>
    request<ChatSession>(`/sessions/${encodeURIComponent(sessionId)}/adopt`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  deleteSession: (sessionId: string) =>
    request<{ id: string }>(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),

  listCommands: (sessionId: string) =>
    request<SlashCommand[]>(`/sessions/${encodeURIComponent(sessionId)}/commands`),

  /**
   * The models this conversation can run on, and the one in force.
   *
   * `current` is null when the model genuinely cannot be read, which is what
   * makes the badge absent rather than approximate; `models` is empty when the
   * catalogue could not be read, which hides the picker rather than offering
   * an empty one.
   */
  getSessionModels: (sessionId: string) =>
    request<{ current: ModelChoice | null; models: ModelChoice[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/model`,
    ),

  renameSession: (sessionId: string, title: string) =>
    request<ChatSession>(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),

  setSessionCwd: (sessionId: string, cwd: string) =>
    request<ChatSession>(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ cwd }),
    }),

  setSessionPinned: (sessionId: string, pinned: boolean) =>
    request<ChatSession>(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ pinned }),
    }),

  setSessionArchived: (sessionId: string, archived: boolean) =>
    request<ChatSession>(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ archived }),
    }),

  getSession: (sessionId: string) =>
    request<ChatSession>(`/sessions/${encodeURIComponent(sessionId)}`),

  /** `null` clears the conversation's own pet and falls back to the global one. */
  setSessionPet: (sessionId: string, petId: string | null) =>
    request<ChatSession>(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ petId }),
    }),

  /**
   * The installed pets, read straight from the pets module's own endpoint.
   *
   * Typed to the handful of fields the picker shows rather than mirroring
   * `InstalledPet` — that shape belongs to the pets module and is still moving.
   */
  listPets: () => request<{
    pets: {
      /**
       * The pet's own manifest, which is `displayName` rather than `name` —
       * this type said `name`, so every read of it was `undefined` and the
       * thinking indicator silently fell back to no pet at all.
       */
      definition: {
        id: string;
        displayName: string;
      };
      /**
       * Lines this pet says while the agent is working, mixed into the thinking
       * indicator's rotation.
       *
       * A sibling of `definition`, not a field inside it, and the distinction is
       * not cosmetic: a Codex pet's manifest lives in a read-only directory, so
       * anything we author about a pet has to be stored beside what its author
       * wrote rather than merged into it.
       */
      thinkingPhrases?: string[];
      spriteUrl: string;
      active: boolean;
    }[];
    activePetId: string | null;
  }>('/pets'),

  /**
   * The user's standing conversation instructions, and the cap on them.
   *
   * Global, with no session in the path: this is how the user wants to be
   * talked to everywhere, not a setting for one chat. `maxLength` is the
   * server's own clamp, sent along so the field cannot offer room the save
   * would take back.
   */
  getConversationInstructions: () =>
    request<ConversationInstructions>('/chat/instructions'),

  /** Resolves to what was stored, which is the trimmed and clamped form. */
  setConversationInstructions: (instructions: string) =>
    request<ConversationInstructions>('/chat/instructions', {
      method: 'PUT',
      body: JSON.stringify({ instructions }),
    }),

  listThemes: () => request<ThemeSummary[]>('/appearance/themes'),

  /** Shows a look without saving or binding it. Reverted by re-resolving. */
  previewTheme: (spec: unknown, sessionId?: string) =>
    request<{ name: string; contrast: { minRatio: number; adjusted: string[] } }>(
      '/appearance/preview',
      { method: 'POST', body: JSON.stringify({ spec, sessionId }) },
    ),

  applyTheme: (input: { themeId?: string; spec?: unknown; scope: 'session' | 'global'; sessionId?: string }) =>
    request<{ themeId: string; name: string }>('/appearance/apply', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  unbindTheme: (scope: 'session' | 'global', sessionId?: string) =>
    request<{ ok: true }>('/appearance/unbind', {
      method: 'POST',
      body: JSON.stringify({ scope, sessionId }),
    }),

  renameTheme: (themeId: string, name: string) =>
    request<{ id: string; name: string }>(`/appearance/themes/${encodeURIComponent(themeId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  deleteTheme: (themeId: string) =>
    request<{ id: string }>(`/appearance/themes/${encodeURIComponent(themeId)}`, { method: 'DELETE' }),
};

export type ConversationInstructions = {
  /** Empty means the system prompt is left exactly as it ships. */
  instructions: string;
  maxLength: number;
};

export type SlashCommand = {
  name: string;
  description: string;
  argumentHint?: string;
  /** True for commands T.A.I.L.S. adds rather than Claude Code's own. */
  local: boolean;
};

export type ThemeSummary = {
  id: string;
  name: string;
  summary: string;
  builtIn: boolean;
  spec: {
    palette: { surfaceHue: number; accentHue: number; surfaceChroma: string; accentChroma: string };
    mode: 'adaptive' | 'light' | 'dark';
    [key: string]: unknown;
  };
};
