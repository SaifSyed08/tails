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
};
