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
  | 'pets_changed'
  | 'appearance_changed'
  /**
   * The on-screen pet has something to say. Plain text in `content`.
   *
   * Produced by a tool call rather than by the reply, so it never reaches the
   * transcript — see `pet-voice.tools.ts`. A client that does not know this kind
   * ignores it, which is the whole reason capabilities arrive as kinds.
   */
  | 'pet_remark'
  /** The preview pane should show a URL, or close. JSON payload in `content`. */
  | 'preview_changed'
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
 * How hard the model works on a turn — the SDK's own word, and the user's.
 *
 * Weakest first, which is the order the picker shows them in. Which of these a
 * given model accepts comes from the catalogue, not from this list.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = typeof EFFORT_LEVELS[number];

/** One model the account may choose, as the composer needs it. */
export type ModelChoice = {
  id: string;
  displayName: string;
  description?: string;
  /** Empty means this model has no effort control, not that it accepts all. */
  effortLevels: EffortLevel[];
};

/** What a conversation is set to run with; empty fields mean "the default". */
export type TurnSettings = {
  model?: string;
  effort?: EffortLevel;
};

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
  turnSettings?: { model?: string; effort?: string };
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
  /**
   * How long the turn took, on `complete` only.
   *
   * Measured by the server from the moment the prompt was accepted rather than
   * taken from the SDK's own figure: what the user waited for includes the CLI
   * spawning, and that is the number the footer is claiming.
   */
  durationMs?: number;
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
  | {
    type: 'user';
    id: string;
    content: string;
    attachments?: MessageAttachment[];
    /** When it was sent. Shown on hover; absent for a row without one. */
    at?: string;
  }
  | {
    type: 'assistant';
    id: string;
    content: string;
    streaming?: boolean;
    /** How long the turn took, in ms. Only on the last message of a turn. */
    tookMs?: number;
  }
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
