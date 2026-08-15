import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

import { resolvePermission, runChatTurn } from '@/modules/chat/claude-runtime.js';
import { runRegistry } from '@/modules/chat/run-registry.js';
import { sessionsService } from '@/modules/sessions/sessions.service.js';
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
      if (!sessionId || !content.trim()) return null;
      return { type: 'chat.send', sessionId, content, cwd: readString(message.cwd) ?? undefined };
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
    default:
      return null;
  }
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

  runRegistry.subscribe((event) => {
    const payload = JSON.stringify(event);
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  });

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
            // needs to resume: whether a run is live, and any prompt already
            // waiting on an answer.
            send(createMessage('chat_subscribed', entry.sessionId, {
              statusCode: runRegistry.isRunning(entry.sessionId) ? 'running' : 'idle',
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
    await runChatTurn({ sessionId: session.id, prompt: message.content, cwd: session.cwd });
  } catch (error) {
    send(createMessage('error', message.sessionId, {
      errorCode: 'send_failed',
      content: error instanceof Error ? error.message : String(error),
    }));
  }
}
