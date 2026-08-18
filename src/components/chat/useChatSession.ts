import { useCallback, useEffect, useRef, useState } from 'react';

import { endsSuggestion } from '@/components/chat/suggestion';
import { mergeTranscript, unaccountedFor } from '@/components/chat/transcript';
import { useWebSocket } from '@/contexts/WebSocketContext';
import { api } from '@/lib/api';
import { EFFORT_LEVELS, PERMISSION_MODE_VALUES, type EffortLevel, type PermissionMode, type TurnSettings } from '@/types/chat';
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

function readEffort(value: unknown): EffortLevel | null {
  return EFFORT_LEVELS.find((entry) => entry === value) ?? null;
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

  /**
   * The model and effort this conversation runs with.
   *
   * Per conversation and reset with it, exactly like the permission mode:
   * inheriting a heavier model or a maximum effort into a chat the user
   * thought was fresh is the same failure as inheriting auto-accept, and costs
   * real money rather than just surprise.
   */
  const [turnSettings, setTurnSettings] = useState<TurnSettings>({});

  // Deltas land here and are flushed on a timer; writing them to state per
  // token is the single easiest way to make a chat UI feel slow.
  const streamBufferRef = useRef('');
  const flushTimerRef = useRef<number | undefined>(undefined);
  const lastSeqRef = useRef(0);
  /**
   * Ids already handled for this conversation.
   *
   * Reset with the rest of the per-conversation state below: ids are unique,
   * so this only ever grows within one transcript, and carrying it across
   * conversations would keep a set alive for every chat ever opened.
   */
  const seenRef = useRef(new Set<string>());
  const modeRef = useRef<PermissionMode>('default');
  // The server's mode is authoritative only until the user picks one: a
  // reconnect mid-conversation must not undo a selection they just made.
  const modeAdoptedRef = useRef(false);
  const turnSettingsRef = useRef<TurnSettings>({});
  const turnSettingsAdoptedRef = useRef(false);

  const changeMode = useCallback((next: PermissionMode) => {
    modeAdoptedRef.current = true;
    modeRef.current = next;
    setMode(next);
  }, []);

  const changeTurnSettings = useCallback((next: TurnSettings) => {
    turnSettingsAdoptedRef.current = true;
    turnSettingsRef.current = next;
    setTurnSettings(next);
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
    seenRef.current = new Set();
    setHistory([]);
    setRealtime([]);
    resetStream();
    setState({ rows: [], busy: false, pendingPermissions: [], pendingPrompts: [], error: null });
    // A new conversation starts in the default mode until the server says
    // otherwise, which it does in the subscribe acknowledgement.
    modeAdoptedRef.current = false;
    modeRef.current = 'default';
    setMode('default');
    turnSettingsAdoptedRef.current = false;
    turnSettingsRef.current = {};
    setTurnSettings({});
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

      /*
        Every message is handled at most once, whatever kind it is.

        `chat.subscribe` replays the run buffer from `lastSeq`, which is what
        makes a refresh or a reconnect recover a turn in progress — and the
        buffer holds *stream deltas* as well as finished messages. Deltas are
        accumulated with `+=` into a ref, so a replay did not merely re-render
        them, it appended the reply to itself: verified against the running
        gateway, a second subscribe re-fed all five deltas of a 198-character
        answer and the streamed text came out twice.

        The first attempt at this guarded `setRealtime` alone, which fixed the
        duplicated *message* and left the duplicated *stream* untouched,
        because deltas never reach that branch. One check at the door covers
        every kind, including the ones added later — which is the property the
        per-branch version could not have.
      */
      if (message.id) {
        if (seenRef.current.has(message.id)) return;
        seenRef.current.add(message.id);
      }

      if (typeof message.seq === 'number') lastSeqRef.current = message.seq;

      // Whatever the last turn predicted, this turn has overtaken it.
      if (endsSuggestion(message.kind)) setSuggestion(null);

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
          // A backstop rather than the main path — see the `text` case below,
          // which is what actually retires the partial. This still matters for
          // a stream that ends without producing a message at all: an aborted
          // turn would otherwise leave its half-sentence on screen forever.
          resetStream();
          return;

        case 'text':
          /*
            The finished message supersedes the partial, whichever order they
            arrive in.

            This used to be left to `stream_end`, on the stated assumption that
            the completed text came *after* it. Observed against the live
            gateway, it does not: the order is `stream_delta`, then
            `text/assistant`, then `stream_end`. So between the message landing
            and the stream closing, the reply was on screen twice — once as the
            committed row and once as the partial still being rendered
            underneath it. A short answer flashed; a long one sat doubled for
            the whole gap, which is what "double output from Claude" was.

            Clearing here makes it order-independent: whichever of the two
            arrives first retires the partial, and the other is a no-op.
          */
          if (message.role === 'assistant') resetStream();
          setRealtime((current) => [...current, message]);
          return;

        case 'chat_subscribed': {
          const payload = message.appearance as { pendingPermissions?: PendingPermission[] } | undefined;
          const reported = readPermissionMode(message.permissionMode);
          if (reported && !modeAdoptedRef.current) {
            modeRef.current = reported;
            setMode(reported);
          }

          // Same rule as the mode: the server's answer is authoritative right
          // up until the user makes a choice of their own.
          if (!turnSettingsAdoptedRef.current) {
            const effort = readEffort(message.turnSettings?.effort);
            const adopted: TurnSettings = {
              ...(message.turnSettings?.model ? { model: message.turnSettings.model } : {}),
              ...(effort ? { effort } : {}),
            };
            turnSettingsRef.current = adopted;
            setTurnSettings(adopted);
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
          /*
            Appended once, however many times it arrives.

            `chat.subscribe` replays the run buffer from `lastSeq` — that is
            the whole point of it, and what makes a mid-stream refresh or a
            reconnect recover instead of losing the turn. But the consumer was
            append-only, so every replay added a second copy of messages it
            already had. Verified against the live gateway: two subscribes with
            the same `lastSeq` deliver the identical message twice, same `id`
            and same `seq`.

            React's StrictMode makes it routine rather than rare in
            development — the subscribe effect has no cleanup, so it fires
            twice on mount — but the bug is not StrictMode's. A protocol that
            can re-deliver requires a consumer that can absorb it, and this one
            could not.

            Keyed on `id` rather than on content: two identical messages are
            two messages, and `mergeTranscript` already handles that case as a
            multiset. This is about the *same* message arriving twice.
          */
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
    options: { cwd?: string; attachments?: AttachmentPayload[]; spoken?: boolean } = {},
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
      // From the ref for the same reason as the mode: a setting changed
      // between renders must not send under the previous one.
      ...turnSettingsRef.current,
      attachments,
      // Only sent when true, so a typed message carries nothing extra.
      ...(options.spoken ? { spoken: true } : {}),
    });
  }, [sessionId, send]);

  const abort = useCallback(() => {
    if (!sessionId) return;
    send({ type: 'chat.abort', sessionId });
  }, [sessionId, send]);

  const answerPermission = useCallback((requestId: string, allow: boolean, remember = false) => {
    // Answering is the next turn starting; the previous turn's guess is spent.
    setSuggestion(null);
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
    setSuggestion(null);
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
    setSuggestion(null);
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
    turnSettings,
    changeTurnSettings,
    suggestion,
    clearSuggestion,
    sendMessage,
    abort,
    answerPermission,
    answerQuestion,
    answerPlan,
  };
}
