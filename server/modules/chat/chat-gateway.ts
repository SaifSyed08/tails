import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

import {
  getSessionPermissionMode,
  getSessionTurnSettings,
  resolvePermission,
  runChatTurn,
  SELECTABLE_PERMISSION_MODES,
  type ChatAttachment,
} from '@/modules/chat/claude-runtime.js';
import { runRegistry } from '@/modules/chat/run-registry.js';
import { readEffortLevel } from '@/modules/chat/turn-settings.js';
import { sessionsService } from '@/modules/sessions/sessions.service.js';
import { appBroadcast } from '@/shared/broadcast.js';
import type { ClientMessage, NormalizedMessage } from '@/shared/types.js';
import { createMessage, readRecord, readString } from '@/shared/utils.js';

/**
 * Parses an inbound frame into a known client message.
 *
 * Returns null for anything unrecognised rather than throwing, so a malformed
 * frame closes nothing — one bad message must not drop a live run's socket.
 */
function parseClientMessage(raw: string): ClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const message = readRecord(parsed);
  if (!message) return null;

  switch (message.type) {
    case 'chat.send': {
      const sessionId = readString(message.sessionId);
      const content = typeof message.content === 'string' ? message.content : '';
      const attachments = readAttachments(message.attachments);
      // A message that is only a screenshot is still a message.
      if (!sessionId || (!content.trim() && attachments.length === 0)) return null;
      return {
        type: 'chat.send',
        sessionId,
        content,
        cwd: readString(message.cwd) ?? undefined,
        permissionMode: readString(message.permissionMode) ?? undefined,
        model: readString(message.model) ?? undefined,
        effort: readString(message.effort) ?? undefined,
        attachments,
        spoken: message.spoken === true,
      };
    }
    case 'chat.abort': {
      const sessionId = readString(message.sessionId);
      return sessionId ? { type: 'chat.abort', sessionId } : null;
    }
    case 'chat.subscribe': {
      if (!Array.isArray(message.sessions)) return null;
      const sessions = message.sessions
        .map(readRecord)
        .flatMap((entry) => {
          const sessionId = readString(entry?.sessionId);
          if (!sessionId) return [];
          const lastSeq = typeof entry?.lastSeq === 'number' ? entry.lastSeq : undefined;
          return [{ sessionId, lastSeq }];
        });
      return { type: 'chat.subscribe', sessions };
    }
    case 'chat.permission-response': {
      const requestId = readString(message.requestId);
      if (!requestId) return null;
      return {
        type: 'chat.permission-response',
        requestId,
        allow: message.allow === true,
        message: readString(message.message) ?? undefined,
        remember: message.remember === true,
      };
    }
    case 'chat.question-response': {
      const requestId = readString(message.requestId);
      const answers = readRecord(message.answers);
      if (!requestId || !answers) return null;

      // Values are option labels; anything non-string is dropped rather than
      // stringified, so the tool never receives a key it cannot match.
      const cleaned: Record<string, string> = {};
      for (const [question, answer] of Object.entries(answers)) {
        if (typeof answer === 'string' && answer.trim()) cleaned[question] = answer;
      }

      return {
        type: 'chat.question-response',
        requestId,
        answers: cleaned,
        response: readString(message.response) ?? undefined,
      };
    }

    case 'chat.plan-response': {
      const requestId = readString(message.requestId);
      if (!requestId) return null;
      return {
        type: 'chat.plan-response',
        requestId,
        approve: message.approve === true,
        message: readString(message.message) ?? undefined,
        autoAcceptEdits: message.autoAcceptEdits === true,
      };
    }

    default:
      return null;
  }
}

/**
 * Narrows the untrusted attachment array.
 *
 * Anything malformed is dropped rather than failing the send: losing one
 * attachment is recoverable, losing the message the user typed is not.
 */
function readAttachments(value: unknown): ChatAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = readRecord(entry);
    const name = readString(record?.name);
    const mediaType = readString(record?.mediaType);
    const data = typeof record?.data === 'string' ? record.data : null;
    // ~15MB of base64; past that the request body itself becomes the problem.
    if (!name || !mediaType || !data || data.length > 20_000_000) return [];
    return [{ name, mediaType, data }];
  }).slice(0, 8);
}

/**
 * Attaches the chat websocket to the HTTP server.
 *
 * Every connected socket receives every sequenced event. That is deliberate
 * for a single-user desktop app: it means two windows on the same conversation
 * stay in sync for free, and the client already filters by session id.
 */
export function attachChatGateway(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const sockets = new Set<WebSocket>();

  const broadcastToAll = (event: NormalizedMessage) => {
    const payload = JSON.stringify(event);
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  };

  runRegistry.subscribe(broadcastToAll);
  // App-wide events — an appearance change — reach every open window, which is
  // what lets a restyle apply to the settings window and the chat at once.
  appBroadcast.subscribe(broadcastToAll);

  wss.on('connection', (socket) => {
    sockets.add(socket);

    const send = (event: NormalizedMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    };

    socket.on('message', (raw) => {
      const message = parseClientMessage(raw.toString());
      if (!message) {
        send(createMessage('protocol_error', '', {
          errorCode: 'bad_request',
          content: 'Unrecognised message.',
        }));
        return;
      }

      switch (message.type) {
        case 'chat.send':
          void handleSend(message, send);
          return;

        case 'chat.abort':
          runRegistry.abortRun(message.sessionId);
          return;

        case 'chat.subscribe':
          for (const entry of message.sessions) {
            // The acknowledgement carries everything a reconnecting client
            // needs to resume: whether a run is live, any prompt already
            // waiting on an answer, and the permission mode actually in force
            // — which is the only way the composer's indicator can be right
            // on a conversation this client has never sent to.
            send(createMessage('chat_subscribed', entry.sessionId, {
              statusCode: runRegistry.isRunning(entry.sessionId) ? 'running' : 'idle',
              permissionMode: getSessionPermissionMode(entry.sessionId),
              // Same reason as the permission mode: the composer must be able
              // to show what is actually in force, not its own last guess.
              turnSettings: getSessionTurnSettings(entry.sessionId),
              appearance: { pendingPermissions: runRegistry.listPendingPermissions(entry.sessionId) },
            }));

            for (const replayed of runRegistry.replay(entry.sessionId, entry.lastSeq ?? 0)) {
              send(replayed);
            }
          }
          return;

        case 'chat.permission-response':
          resolvePermission(message.requestId, {
            allow: message.allow,
            message: message.message,
            remember: message.remember,
          });
          return;

        case 'chat.question-response':
          resolvePermission(message.requestId, {
            allow: true,
            answers: message.answers,
            response: message.response,
          });
          return;

        case 'chat.plan-response':
          resolvePermission(message.requestId, message.approve
            ? { allow: true, planMode: message.autoAcceptEdits ? 'acceptEdits' : 'default' }
            // Rejecting a plan is feedback, not refusal: the model stays in
            // plan mode and revises with this message in hand.
            : { allow: false, message: message.message ?? 'Keep planning — revise the approach.' });
          return;
      }
    });

    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });

  return wss;
}

async function handleSend(
  message: Extract<ClientMessage, { type: 'chat.send' }>,
  send: (event: NormalizedMessage) => void,
): Promise<void> {
  try {
    const session = sessionsService.ensureSession(message.sessionId, {
      cwd: message.cwd,
      title: message.content,
    });

    // The runtime owns the whole run, including echoing the user's own message
    // into the sequenced stream — starting the run here too would make its
    // `startRun` return null and the turn would never execute.
    // An unrecognised mode falls through to the SDK default rather than
    // erroring, so a stale client cannot break a send.
    const mode = SELECTABLE_PERMISSION_MODES.find((entry) => entry === message.permissionMode);
    await runChatTurn({
      sessionId: session.id,
      prompt: message.content,
      cwd: session.cwd,
      permissionMode: mode,
      attachments: message.attachments,
      spoken: message.spoken === true,
      // The model is checked against the CLI's own catalogue in the runtime,
      // which is the only place that knows what this account may use.
      ...(message.model ? { model: message.model } : {}),
      ...(readEffortLevel(message.effort) ? { effort: readEffortLevel(message.effort) } : {}),
    });
  } catch (error) {
    send(createMessage('error', message.sessionId, {
      errorCode: 'send_failed',
      content: error instanceof Error ? error.message : String(error),
    }));
  }
}
