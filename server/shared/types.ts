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
  // Gateway
  | 'chat_subscribed'
  | 'session_created'
  | 'appearance_changed'
  | 'protocol_error';

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
  updatedAt: string;
};

/** A row in the sidebar's conversation list. */
export type SessionListItem = {
  id: string;
  title: string;
  cwd: string;
  updatedAt: string;
  /** True when this came from Claude Code's own history rather than our DB. */
  external: boolean;
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
    /** Files and images attached to this message. */
    attachments?: { name: string; mediaType: string; data: string }[];
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
