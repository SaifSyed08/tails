import type { NormalizedMessage } from '@/types/chat';

export type SessionListItem = {
  id: string;
  title: string;
  cwd: string;
  /** Last message, not last viewed — the sidebar's sort key. */
  updatedAt: string;
  external: boolean;
  pinned: boolean;
  archived: boolean;
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
