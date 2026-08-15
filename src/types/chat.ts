/**
 * Client mirror of the server's message envelope.
 *
 * Declared separately rather than imported from `server/` so the browser
 * bundle never pulls in backend code. The two must be kept in step; the
 * `kind` union is the part that matters.
 */
export type MessageKind =
  | 'text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'stream_delta'
  | 'stream_end'
  | 'status'
  | 'complete'
  | 'error'
  | 'permission_request'
  | 'permission_cancelled'
  | 'chat_subscribed'
  | 'session_created'
  | 'appearance_changed'
  | 'protocol_error';

export type NormalizedMessage = {
  id: string;
  sessionId: string;
  timestamp: string;
  kind: MessageKind;
  seq?: number;
  role?: 'user' | 'assistant';
  content?: string;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: { content?: string; isError?: boolean };
  requestId?: string;
  permissionTitle?: string;
  permissionDescription?: string;
  exitCode?: number;
  statusCode?: string;
  appearance?: unknown;
  errorCode?: string;
};

export type PendingPermission = {
  requestId: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  title?: string;
  description?: string;
  receivedAt: string;
};

/**
 * A message as the chat view renders it.
 *
 * Distinct from `NormalizedMessage` because several transport kinds collapse
 * into one visual row — a `tool_use` and its later `tool_result` are one
 * bubble — and several kinds render nothing at all.
 */
export type ChatRow =
  | { type: 'user'; id: string; content: string }
  | { type: 'assistant'; id: string; content: string; streaming?: boolean }
  | { type: 'thinking'; id: string; content: string }
  | {
    type: 'tool';
    id: string;
    toolName: string;
    toolInput: unknown;
    result?: { content?: string; isError?: boolean };
  }
  | { type: 'error'; id: string; content: string }
  | { type: 'status'; id: string; content: string };
