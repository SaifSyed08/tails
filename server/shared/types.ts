//----------------- CHAT MESSAGE MODEL ------------

/**
 * Every kind of event that can reach the client.
 *
 * One union covering both agent output and gateway/transport events is the
 * keystone of this design: the client has exactly one switch, and there is no
 * second protocol to keep in sync. Adding a capability means adding a `kind`,
 * not a parallel channel.
 */
export type MessageKind =
  // Agent output
  | 'text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'stream_delta'
  | 'stream_end'
  // Run lifecycle
  | 'status'
  | 'complete'
  | 'error'
  // Interaction
  | 'permission_request'
  | 'permission_cancelled'
  | 'question_request'
  | 'plan_request'
  | 'prompt_suggestion'
  // Gateway
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
  /** The preview pane should show a URL, or close. Payload is JSON in `content`. */
  | 'preview_changed'
  | 'protocol_error';

/**
 * An attachment as the transcript remembers it.
 *
 * The bytes are deliberately optional: a chip needs a name and a type, and
 * only an image small enough to be worth inlining carries `previewUrl`. That
 * keeps a history load of a conversation with a 12MB screenshot from becoming
 * a 12MB JSON response.
 */
export type MessageAttachment = {
  name: string;
  mediaType: string;
  /** `data:` URL, images only and only under the inline cap. */
  previewUrl?: string;
};

/**
 * The single envelope every event travels in.
 *
 * Deliberately flat and permissive rather than a discriminated union of
 * twenty shapes: the client narrows on `kind` and reads the fields that kind
 * populates. `seq` is assigned by the run registry on live events only —
 * history rows have no sequence because they are already ordered.
 */
export type NormalizedMessage = {
  id: string;
  sessionId: string;
  timestamp: string;
  kind: MessageKind;
  seq?: number;

  role?: 'user' | 'assistant';
  content?: string;
  /** `text` (user) only — the files that were sent with this message. */
  attachments?: MessageAttachment[];

  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: { content?: string; isError?: boolean };

  /** Correlation id for any prompt awaiting the user, echoed back in the response. */
  requestId?: string;
  /** `question_request` payload — the questions the model is asking. */
  questions?: AskUserQuestion[];
  /** `plan_request` payload — the plan awaiting approval, as markdown. */
  plan?: string;
  /** Human-readable prompt text supplied by the SDK for a permission ask. */
  permissionTitle?: string;
  permissionDescription?: string;

  /** `complete` only. Non-zero means the run failed. */
  exitCode?: number;
  /** `status` only — a short machine-readable label plus optional detail. */
  statusCode?: string;
  /** `chat_subscribed` only — the mode this conversation is really running in. */
  permissionMode?: string;
  /** `chat_subscribed` only — the model and effort actually in force. */
  turnSettings?: { model?: string; effort?: string };

  /** `appearance_changed` payload; see AppearanceBroadcast. */
  appearance?: unknown;

  /** `error` / `protocol_error` detail. */
  errorCode?: string;
};

// ---------------------------
//----------------- SESSION PERSISTENCE ------------

/**
 * One conversation as the app knows it.
 *
 * The two-id model is load-bearing. `id` is minted by this app before the
 * first send and never changes, so every client reference is stable.
 * `providerSessionId` is Claude Code's own UUID, learned from the first
 * streamed event, and is the only thing ever passed to `options.resume`.
 * Keeping the provider id server-side removes the entire class of
 * session-handoff bugs.
 */
export type ChatSession = {
  id: string;
  providerSessionId: string | null;
  title: string;
  cwd: string;
  createdAt: string;
  /** Last message, not last viewed. Only a run may move it. */
  updatedAt: string;
  pinnedAt: string | null;
  archivedAt: string | null;
  /**
   * The companion assigned to this conversation, by pet id.
   *
   * Null means "no pet of its own". Whether that falls back to the globally
   * active pet is the pets module's decision, not this table's.
   */
  petId: string | null;
  /**
   * True once the user has named this chat themselves.
   *
   * Claude Code generates its own title for every transcript and we adopt it,
   * so this is what stops that from overwriting a deliberate name.
   */
  titlePinned: boolean;
};

/** A row in the sidebar's conversation list. */
export type SessionListItem = {
  id: string;
  title: string;
  cwd: string;
  /** Last message, not last viewed — the sidebar's sort key. */
  updatedAt: string;
  /** True when this came from Claude Code's own history rather than our DB. */
  external: boolean;
  pinned: boolean;
  archived: boolean;
  /**
   * The companion assigned to this conversation, if it has one of its own.
   *
   * Always null for external conversations: the assignment lives in this app's
   * table, and a chat Claude Code owns has no row here to carry it.
   */
  petId: string | null;
};

// ---------------------------
//----------------- WIRE PROTOCOL ------------

/**
 * The complete set of client-to-server messages. Four, deliberately.
 *
 * Anything that looks like a fifth is usually a REST call in disguise; keeping
 * this set small is what makes the reconnect story tractable.
 */
export type ClientMessage =
  | {
    type: 'chat.send';
    sessionId: string;
    content: string;
    cwd?: string;
    /** 'default' | 'acceptEdits' | 'plan'; validated by the runtime. */
    permissionMode?: string;
    /** Model wire id from the composer's picker; validated against the catalogue. */
    model?: string;
    /** 'low' | 'medium' | 'high' | 'xhigh' | 'max'; validated by the runtime. */
    effort?: string;
    /** Files and images attached to this message. */
    attachments?: { name: string; mediaType: string; data: string }[];
    /**
     * The user spoke this rather than typing it.
     *
     * Changes how the model is asked to answer — see `spoken-turn.ts` — and
     * nothing else. It never reaches the transcript, because the user did not
     * say the thing it adds.
     */
    spoken?: boolean;
  }
  | { type: 'chat.abort'; sessionId: string }
  | { type: 'chat.subscribe'; sessions: { sessionId: string; lastSeq?: number }[] }
  | {
    type: 'chat.permission-response';
    requestId: string;
    allow: boolean;
    message?: string;
    remember?: boolean;
  }
  | {
    type: 'chat.question-response';
    requestId: string;
    answers: Record<string, string>;
    response?: string;
  }
  | {
    type: 'chat.plan-response';
    requestId: string;
    approve: boolean;
    /** Feedback when rejecting; the model keeps planning with it in hand. */
    message?: string;
    /** Approving with auto-accept leaves plan mode straight into acceptEdits. */
    autoAcceptEdits?: boolean;
  };

// ---------------------------
//----------------- PERMISSIONS ------------

/**
 * A tool call parked waiting on the user.
 *
 * Re-delivered in the `chat_subscribed` acknowledgement so a page refresh
 * mid-run does not strand the agent waiting on a prompt nobody can see.
 */
export type PendingPermission = {
  requestId: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  title?: string;
  description?: string;
  receivedAt: string;
};

/** The user's answer to a permission request. */
export type PermissionDecision = {
  allow: boolean;
  message?: string;
  /** Adds the tool to the run's allow-list for the remainder of the session. */
  remember?: boolean;
  /**
   * Answers to an `AskUserQuestion`, keyed by the question's exact text and
   * valued by the chosen option's label.
   *
   * This shape is not ours to choose — it is what the tool reads back out of
   * `PermissionResult.updatedInput`. Returning the input unchanged instead
   * makes the tool report "The user did not answer the questions."
   */
  answers?: Record<string, string>;
  /** Free-text the user typed instead of picking one of the offered options. */
  response?: string;
  /** Approving a plan also leaves plan mode; this carries the mode to switch to. */
  planMode?: 'acceptEdits' | 'default';
};

// ---------------------------
//----------------- INTERACTIVE TOOL PAYLOADS ------------

/**
 * One question from the `AskUserQuestion` tool.
 *
 * Mirrors the tool's own input schema: 1-4 questions, each with 2-4 options,
 * a short `header` used as a chip label, and a `multiSelect` flag.
 */
export type AskUserQuestion = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string; preview?: string }[];
};
