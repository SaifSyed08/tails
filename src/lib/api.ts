import type { NormalizedMessage } from '@/types/chat';

export type SessionListItem = {
  id: string;
  title: string;
  cwd: string;
  updatedAt: string;
  external: boolean;
};

export type ChatSession = {
  id: string;
  providerSessionId: string | null;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
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
  listSessions: (limit = 50) => request<SessionListItem[]>(`/sessions?limit=${limit}`),

  createSession: (input: { cwd?: string; title?: string } = {}) =>
    request<ChatSession>('/sessions', { method: 'POST', body: JSON.stringify(input) }),

  getMessages: (sessionId: string) =>
    request<NormalizedMessage[]>(`/sessions/${encodeURIComponent(sessionId)}/messages`),

  adoptSession: (sessionId: string, input: { cwd: string; title: string }) =>
    request<ChatSession>(`/sessions/${encodeURIComponent(sessionId)}/adopt`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  deleteSession: (sessionId: string) =>
    request<{ id: string }>(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),

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
