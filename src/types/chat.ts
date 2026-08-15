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
  | 'question_request'
  | 'plan_request'
  | 'prompt_suggestion'
  | 'chat_subscribed'
  | 'session_created'
  | 'sessions_changed'
  | 'appearance_changed'
  | 'protocol_error';

/**
 * The permission modes the UI can select, mirroring the server's
 * `SELECTABLE_PERMISSION_MODES`.
 *
 * `bypassPermissions` is deliberately absent: it resolves permissions before
 * the app's callback runs, which would silently stop questions and plans ever
 * reaching the user.
 */
export const PERMISSION_MODE_VALUES = ['default', 'acceptEdits', 'plan'] as const;
export type PermissionMode = typeof PERMISSION_MODE_VALUES[number];

/**
 * A file staged in the composer, on its way out.
 *
 * Carries the bytes; `MessageAttachment` is the same file once it is part of
 * the transcript, where the bytes are optional.
 */
export type AttachmentPayload = {
  name: string;
  mediaType: string;
  /** Base64 without the data-URL prefix, which is what the SDK expects. */
  data: string;
};

/** A file that travelled with a message, as the transcript remembers it. */
export type MessageAttachment = {
  name: string;
  mediaType: string;
  /** `data:` URL. Images only, and only when small enough to inline. */
  previewUrl?: string;
};

export type NormalizedMessage = {
  id: string;
  sessionId: string;
  timestamp: string;
  kind: MessageKind;
  seq?: number;
  role?: 'user' | 'assistant';
  content?: string;
  attachments?: MessageAttachment[];
  permissionMode?: string;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: { content?: string; isError?: boolean };
  requestId?: string;
  permissionTitle?: string;
  permissionDescription?: string;
  questions?: AskUserQuestion[];
  plan?: string;
  exitCode?: number;
  statusCode?: string;
  appearance?: unknown;
  errorCode?: string;
};

/** One question from the model's `AskUserQuestion` tool. */
export type AskUserQuestion = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string; preview?: string }[];
};

/** A question or plan currently waiting on the user. */
export type PendingPrompt =
  | { kind: 'question'; requestId: string; questions: AskUserQuestion[] }
  | { kind: 'plan'; requestId: string; plan: string };

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
  | { type: 'user'; id: string; content: string; attachments?: MessageAttachment[] }
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
