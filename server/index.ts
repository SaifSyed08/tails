import cors from 'cors';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getConnection } from '@/db/connection.js';
import { createAppearanceRouter } from '@/modules/appearance/appearance.routes.js';
import { attachChatGateway } from '@/modules/chat/chat-gateway.js';
import { createChatRouter } from '@/modules/chat/chat.routes.js';
import { createPetsRouter } from '@/modules/pets/index.js';
import { createSessionsRouter } from '@/modules/sessions/sessions.routes.js';
import { sessionsService } from '@/modules/sessions/sessions.service.js';
import { attachTerminalGateway } from '@/modules/terminal/terminal-gateway.js';
import { createVoiceRouter } from '@/modules/voice/voice.routes.js';
import { attachVoiceGateway } from '@/modules/voice/voice-gateway.js';
import { AppError } from '@/shared/utils.js';

const PORT = Number(process.env.TAILS_SERVER_PORT || 4317);
const HOST = '127.0.0.1';

/**
 * Locates the project root by walking up to the nearest `package.json`.
 *
 * A fixed number of `..` segments cannot work here: this file runs from
 * `server/` under tsx in development and from `dist-server/server/` once
 * built, which are different depths. Guessing one of them silently serves the
 * client from a directory that does not exist.
 */
function findAppRoot(startDir: string): string {
  let current = startDir;

  for (let depth = 0; depth < 6; depth += 1) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return process.cwd();
}

const APP_ROOT = findAppRoot(path.dirname(fileURLToPath(import.meta.url)));

const app = express();

app.use(express.json({ limit: '10mb' }));
// The desktop shell and the Vite dev server are different origins in dev only;
// the server binds to loopback either way, so this is not a public surface.
app.use(cors({ origin: true }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.1.0' });
});

app.use('/api/chat', createChatRouter());
app.use('/api/sessions', createSessionsRouter());
app.use('/api/appearance', createAppearanceRouter());
app.use('/api/pets', createPetsRouter());
app.use('/api/voice', createVoiceRouter());

// In production the built client is served from the same origin, so the app
// and its API share cookies, websockets, and CSP with no special casing.
const clientDir = path.join(APP_ROOT, 'dist');
app.use(express.static(clientDir));

/**
 * SPA fallback.
 *
 * Scoped to non-API paths so an unmatched `/api/*` route 404s as JSON instead
 * of silently returning the HTML shell — the failure mode that makes a missing
 * route look like a working one.
 */
app.get(/^(?!\/api\/).*/, (_req, res, next) => {
  res.sendFile(path.join(clientDir, 'index.html'), (error) => {
    if (error) next();
  });
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown endpoint.' } });
});

app.use((
  error: unknown,
  _req: express.Request,
  res: express.Response,
  _next: express.NextFunction,
) => {
  if (error instanceof AppError) {
    res.status(error.statusCode).json({
      error: { code: error.code, message: error.message, details: error.details },
    });
    return;
  }

  console.error('Unhandled error:', error);
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Something went wrong.',
    },
  });
});

const server = http.createServer(app);
attachChatGateway(server);
attachTerminalGateway(server);
// Each gateway chains the previous one's upgrade listeners, so the order here
// is the order they get offered a handshake. Any of them may go first; none of
// them may be a plain `new WebSocketServer({ server, path })`.
attachVoiceGateway(server);

getConnection();
// A conversation with no messages is not a conversation. Earlier builds wrote
// one on every launch, so the first boot after this change has a backlog to
// clear.
sessionsService.sweepEmptySessions();

server.listen(PORT, HOST, () => {
  console.log(`T.A.I.L.S. server listening on http://${HOST}:${PORT}`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
  // Don't hang forever on a websocket that refuses to close.
  setTimeout(() => process.exit(0), 3000).unref();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
