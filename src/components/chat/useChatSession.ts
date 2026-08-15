import { useCallback, useEffect, useRef, useState } from 'react';

import { useWebSocket } from '@/contexts/WebSocketContext';
import { api } from '@/lib/api';
import type { ChatRow, NormalizedMessage, PendingPermission, PendingPrompt } from '@/types/chat';

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
        if (!message.content) break;
        if (message.role === 'user') {
          rows.push({ type: 'user', id: message.id, content: message.content });
          break;
        }

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

  // Deltas land here and are flushed on a timer; writing them to state per
  // token is the single easiest way to make a chat UI feel slow.
  const streamBufferRef = useRef('');
  const flushTimerRef = useRef<number | undefined>(undefined);
  const lastSeqRef = useRef(0);

  const resetStream = useCallback(() => {
    if (flushTimerRef.current) window.clearTimeout(flushTimerRef.current);
    flushTimerRef.current = undefined;
    streamBufferRef.current = '';
    setStreamingText('');
  }, []);

  const loadHistory = useCallback(async (id: string) => {
    try {
      const messages = await api.getMessages(id);
      setHistory(messages);
      setState((current) => ({ ...current, error: null }));
    } catch (error) {
      setState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : 'Could not load this conversation.',
      }));
    }
  }, []);

  useEffect(() => {
    lastSeqRef.current = 0;
    setHistory([]);
    setRealtime([]);
    resetStream();
    setState({ rows: [], busy: false, pendingPermissions: [], pendingPrompts: [], error: null });

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
          // actually persisted, then drop the optimistic realtime rows.
          void loadHistory(sessionId).then(() => setRealtime([]));
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
    const merged = [...history, ...realtime];
    const rows = buildChatRows(merged);
    if (streamingText) {
      rows.push({ type: 'assistant', id: '__streaming', content: streamingText, streaming: true });
    }
    setState((current) => ({ ...current, rows }));
  }, [history, realtime, streamingText]);

  const sendMessage = useCallback((content: string, cwd?: string, permissionMode?: string) => {
    if (!sessionId || !content.trim()) return;
    setState((current) => ({ ...current, busy: true, error: null }));
    send({ type: 'chat.send', sessionId, content, cwd, permissionMode });
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
    send({ type: 'chat.plan-response', requestId, approve, ...options });
  }, [send]);

  return { ...state, sendMessage, abort, answerPermission, answerQuestion, answerPlan };
}
