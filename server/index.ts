import cors from 'cors';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getConnection } from '@/db/connection.js';
import { createAppearanceRouter } from '@/modules/appearance/appearance.routes.js';
import { attachChatGateway } from '@/modules/chat/chat-gateway.js';
import { createSessionsRouter } from '@/modules/sessions/sessions.routes.js';
import { AppError } from '@/shared/utils.js';

const PORT = Number(process.env.TAILS_SERVER_PORT || 4317);
const HOST = '127.0.0.1';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const app = express();

app.use(express.json({ limit: '10mb' }));
// The desktop shell and the Vite dev server are different origins in dev only;
// the server binds to loopback either way, so this is not a public surface.
app.use(cors({ origin: true }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.1.0' });
});

app.use('/api/sessions', createSessionsRouter());
app.use('/api/appearance', createAppearanceRouter());

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

getConnection();

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
