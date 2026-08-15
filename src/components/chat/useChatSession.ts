import { useCallback, useEffect, useRef, useState } from 'react';

import { mergeTranscript, unaccountedFor } from '@/components/chat/transcript';
import { useWebSocket } from '@/contexts/WebSocketContext';
import { api } from '@/lib/api';
import { PERMISSION_MODE_VALUES, type PermissionMode } from '@/types/chat';
import type {
  AttachmentPayload,
  ChatRow,
  NormalizedMessage,
  PendingPermission,
  PendingPrompt,
} from '@/types/chat';

/**
 * Narrows a mode the server reported.
 *
 * A mode this build does not know about is ignored rather than displayed, so
 * a newer server can never put the indicator into a state with no label.
 */
function readPermissionMode(value: unknown): PermissionMode | null {
  return PERMISSION_MODE_VALUES.find((entry) => entry === value) ?? null;
}

/**
 * How often accumulated stream deltas are flushed to React state.
 *
 * Tokens arrive far faster than a useful frame rate. Batching turns hundreds
 * of renders per second into about ten, with no visible difference.
 */
const STREAM_FLUSH_MS = 100;

/**
 * Collapses transport events into renderable rows.
 *
 * Two things happen here that are easier server-adjacent than in a component:
 * a `tool_result` is folded onto the `tool_use` it answers, and consecutive
 * assistant text is merged so one reply is one bubble rather than one per
 * content block.
 */
export function buildChatRows(messages: NormalizedMessage[]): ChatRow[] {
  const rows: ChatRow[] = [];
  const toolRowsById = new Map<string, Extract<ChatRow, { type: 'tool' }>>();

  for (const message of messages) {
    switch (message.kind) {
      case 'text': {
        if (message.role === 'user') {
          // A message with nothing but a screenshot on it still has to draw.
          if (!message.content && !message.attachments?.length) break;
          rows.push({
            type: 'user',
            id: message.id,
            content: message.content ?? '',
            ...(message.attachments?.length ? { attachments: message.attachments } : {}),
          });
          break;
        }
        if (!message.content) break;

        const previous = rows[rows.length - 1];
        if (previous?.type === 'assistant' && !previous.streaming) {
          previous.content += message.content;
        } else {
          rows.push({ type: 'assistant', id: message.id, content: message.content });
        }
        break;
      }

      case 'thinking':
        if (message.content) {
          rows.push({ type: 'thinking', id: message.id, content: message.content });
        }
        break;

      case 'tool_use': {
        const row: Extract<ChatRow, { type: 'tool' }> = {
          type: 'tool',
          id: message.id,
          toolName: message.toolName ?? 'unknown',
          toolInput: message.toolInput,
        };
        rows.push(row);
        if (message.toolId) toolRowsById.set(message.toolId, row);
        break;
      }

      case 'tool_result': {
        const target = message.toolId ? toolRowsById.get(message.toolId) : undefined;
        // A result whose call we never saw (history truncation, a subagent's
        // internal call) is dropped rather than rendered as an orphan.
        if (target) target.result = message.toolResult;
        break;
      }

      case 'error':
        rows.push({ type: 'error', id: message.id, content: message.content ?? 'Something went wrong.' });
        break;

      case 'status':
        if (message.content) {
          rows.push({ type: 'status', id: message.id, content: message.content });
        }
        break;

      default:
        // Control kinds render nothing.
        break;
    }
  }

  return rows;
}

type ChatSessionState = {
  rows: ChatRow[];
  busy: boolean;
  pendingPermissions: PendingPermission[];
  /** Questions and plans awaiting an answer, rendered as their own cards. */
  pendingPrompts: PendingPrompt[];
  error: string | null;
};

/**
 * Drives one conversation: history, live events, and the send/abort controls.
 */
export function useChatSession(sessionId: string | null) {
  const { send, subscribe, connected } = useWebSocket();

  const [history, setHistory] = useState<NormalizedMessage[]>([]);
  const [realtime, setRealtime] = useState<NormalizedMessage[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [state, setState] = useState<ChatSessionState>({
    rows: [], busy: false, pendingPermissions: [], pendingPrompts: [], error: null,
  });

  /**
   * The permission mode this conversation is in.
   *
   * Owned here rather than by the view because it is a property of the
   * conversation, not of the screen: keeping it in a component that stays
   * mounted across conversation switches is what left the composer showing
   * "Auto-accept edits" on a brand-new chat that was really running in the
   * default mode.
   */
  const [mode, setMode] = useState<PermissionMode>('default');

  /**
   * The model's guess at what the user would say next, if it offered one.
   *
   * Arrives after the turn's `complete`, belongs to exactly one turn, and is
   * never rendered as a message — the composer shows it as ghost text and
   * throws it away the moment the user does anything else.
   */
  const [suggestion, setSuggestion] = useState<string | null>(null);

  // Deltas land here and are flushed on a timer; writing them to state per
  // token is the single easiest way to make a chat UI feel slow.
  const streamBufferRef = useRef('');
  const flushTimerRef = useRef<number | undefined>(undefined);
  const lastSeqRef = useRef(0);
  const modeRef = useRef<PermissionMode>('default');
  // The server's mode is authoritative only until the user picks one: a
  // reconnect mid-conversation must not undo a selection they just made.
  const modeAdoptedRef = useRef(false);

  const changeMode = useCallback((next: PermissionMode) => {
    modeAdoptedRef.current = true;
    modeRef.current = next;
    setMode(next);
  }, []);

  const resetStream = useCallback(() => {
    if (flushTimerRef.current) window.clearTimeout(flushTimerRef.current);
    flushTimerRef.current = undefined;
    streamBufferRef.current = '';
    setStreamingText('');
  }, []);

  /**
   * Reloads the transcript, returning what it read.
   *
   * The return value matters: a failed read used to be indistinguishable from
   * an empty one at the call site, and the caller went on to clear the live
   * messages either way.
   */
  const loadHistory = useCallback(async (id: string): Promise<NormalizedMessage[] | null> => {
    try {
      const messages = await api.getMessages(id);
      setHistory(messages);
      setState((current) => ({ ...current, error: null }));
      return messages;
    } catch (error) {
      setState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : 'Could not load this conversation.',
      }));
      return null;
    }
  }, []);

  useEffect(() => {
    lastSeqRef.current = 0;
    setHistory([]);
    setRealtime([]);
    resetStream();
    setState({ rows: [], busy: false, pendingPermissions: [], pendingPrompts: [], error: null });
    // A new conversation starts in the default mode until the server says
    // otherwise, which it does in the subscribe acknowledgement.
    modeAdoptedRef.current = false;
    modeRef.current = 'default';
    setMode('default');
    // A suggestion is about one turn of one conversation; it must never
    // follow the user into another.
    setSuggestion(null);

    if (sessionId) void loadHistory(sessionId);
  }, [sessionId, loadHistory, resetStream]);

  // Re-subscribe on every reconnect, telling the server how far we got so it
  // can replay only what we missed.
  useEffect(() => {
    if (!sessionId || !connected) return;
    send({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: lastSeqRef.current }] });
  }, [sessionId, connected, send]);

  useEffect(() => {
    if (!sessionId) return undefined;

    return subscribe((message) => {
      if (message.sessionId !== sessionId) return;
      if (typeof message.seq === 'number') lastSeqRef.current = message.seq;

      switch (message.kind) {
        case 'stream_delta': {
          streamBufferRef.current += message.content ?? '';
          if (flushTimerRef.current === undefined) {
            flushTimerRef.current = window.setTimeout(() => {
              flushTimerRef.current = undefined;
              setStreamingText(streamBufferRef.current);
            }, STREAM_FLUSH_MS);
          }
          return;
        }

        case 'stream_end':
          // The finished text arrives as a normal `text` event straight after,
          // so the partial is dropped rather than committed twice.
          resetStream();
          return;

        case 'chat_subscribed': {
          const payload = message.appearance as { pendingPermissions?: PendingPermission[] } | undefined;
          const reported = readPermissionMode(message.permissionMode);
          if (reported && !modeAdoptedRef.current) {
            modeRef.current = reported;
            setMode(reported);
          }
          setState((current) => ({
            ...current,
            busy: message.statusCode === 'running',
            pendingPermissions: payload?.pendingPermissions ?? [],
          }));
          return;
        }

        case 'permission_request':
          setState((current) => ({
            ...current,
            pendingPermissions: [...current.pendingPermissions, {
              requestId: message.requestId ?? '',
              sessionId: message.sessionId,
              toolName: message.toolName ?? 'unknown',
              input: message.toolInput,
              title: message.permissionTitle,
              description: message.permissionDescription,
              receivedAt: message.timestamp,
            }],
          }));
          return;

        case 'question_request':
          setState((current) => ({
            ...current,
            pendingPrompts: [...current.pendingPrompts, {
              kind: 'question',
              requestId: message.requestId ?? '',
              questions: message.questions ?? [],
            }],
          }));
          return;

        case 'plan_request':
          setState((current) => ({
            ...current,
            pendingPrompts: [...current.pendingPrompts, {
              kind: 'plan',
              requestId: message.requestId ?? '',
              plan: message.plan ?? '',
            }],
          }));
          return;

        case 'prompt_suggestion':
          // Deliberately not added to `realtime`: this is not part of the
          // transcript and must never become a row.
          setSuggestion(message.content?.trim() || null);
          return;

        case 'permission_cancelled':
          setState((current) => ({
            ...current,
            pendingPermissions: current.pendingPermissions.filter(
              (permission) => permission.requestId !== message.requestId,
            ),
            pendingPrompts: current.pendingPrompts.filter(
              (prompt) => prompt.requestId !== message.requestId,
            ),
          }));
          return;

        case 'complete':
          resetStream();
          setState((current) => ({
            ...current, busy: false, pendingPermissions: [], pendingPrompts: [],
          }));
          // Re-read from the transcript so what's on screen matches what was
          // actually persisted, then drop only the live messages that read
          // actually accounts for. Dropping all of them assumed the transcript
          // was complete, and when it was not the turn disappeared.
          void loadHistory(sessionId).then((messages) => {
            if (!messages) return;
            setRealtime((current) => unaccountedFor(messages, current));
          });
          return;

        case 'session_created':
          return;

        case 'protocol_error':
          setState((current) => ({ ...current, busy: false, error: message.content ?? 'Protocol error.' }));
          return;

        default:
          setRealtime((current) => [...current, message]);
      }
    });
  }, [sessionId, subscribe, loadHistory, resetStream]);

  // Rebuild rows whenever any input changes. Cheap relative to the render it
  // feeds, and keeps the merge logic in exactly one place.
  useEffect(() => {
    // Merged rather than concatenated: between the reload landing and the
    // prune running, both copies of the same message exist, and the user
    // should not watch the last answer flash twice.
    const rows = buildChatRows(mergeTranscript(history, realtime));
    if (streamingText) {
      rows.push({ type: 'assistant', id: '__streaming', content: streamingText, streaming: true });
    }
    setState((current) => ({ ...current, rows }));
  }, [history, realtime, streamingText]);

  const sendMessage = useCallback((
    content: string,
    options: { cwd?: string; attachments?: AttachmentPayload[] } = {},
  ) => {
    const attachments = options.attachments ?? [];
    if (!sessionId || (!content.trim() && attachments.length === 0)) return;
    setState((current) => ({ ...current, busy: true, error: null }));
    // Whatever the last turn predicted, this message is the real answer.
    setSuggestion(null);
    send({
      type: 'chat.send',
      sessionId,
      content,
      cwd: options.cwd,
      // Read from the ref rather than the closure so a mode changed between
      // renders cannot send a turn under the mode the composer used to show.
      permissionMode: modeRef.current,
      attachments,
    });
  }, [sessionId, send]);

  const abort = useCallback(() => {
    if (!sessionId) return;
    send({ type: 'chat.abort', sessionId });
  }, [sessionId, send]);

  const answerPermission = useCallback((requestId: string, allow: boolean, remember = false) => {
    setState((current) => ({
      ...current,
      pendingPermissions: current.pendingPermissions.filter(
        (permission) => permission.requestId !== requestId,
      ),
    }));
    send({ type: 'chat.permission-response', requestId, allow, remember });
  }, [send]);

  /**
   * Sends the answer to an `AskUserQuestion`.
   *
   * The prompt is cleared optimistically: the model has what it needs the
   * moment the frame leaves, and leaving the card on screen would invite a
   * second submission the tool would ignore.
   */
  const answerQuestion = useCallback((
    requestId: string,
    answers: Record<string, string>,
    response?: string,
  ) => {
    setState((current) => ({
      ...current,
      pendingPrompts: current.pendingPrompts.filter((prompt) => prompt.requestId !== requestId),
    }));
    send({ type: 'chat.question-response', requestId, answers, response });
  }, [send]);

  const answerPlan = useCallback((
    requestId: string,
    approve: boolean,
    options: { autoAcceptEdits?: boolean; message?: string } = {},
  ) => {
    setState((current) => ({
      ...current,
      pendingPrompts: current.pendingPrompts.filter((prompt) => prompt.requestId !== requestId),
    }));
    // Approving leaves plan mode server-side, so the indicator has to move
    // with it — this is the one place the mode changes without the user
    // touching the composer.
    if (approve) changeMode(options.autoAcceptEdits ? 'acceptEdits' : 'default');
    send({ type: 'chat.plan-response', requestId, approve, ...options });
  }, [send, changeMode]);

  const clearSuggestion = useCallback(() => setSuggestion(null), []);

  return {
    ...state,
    mode,
    changeMode,
    suggestion,
    clearSuggestion,
    sendMessage,
    abort,
    answerPermission,
    answerQuestion,
    answerPlan,
  };
}
