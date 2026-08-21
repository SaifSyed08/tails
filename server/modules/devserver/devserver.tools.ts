import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import {
  detectUrl,
  listDevServers,
  readDevServer,
  startDevServer,
  stopDevServer,
} from '@/modules/devserver/dev-servers.js';
import { openPreviewFor } from '@/modules/preview/preview.tools.js';

/**
 * Starting something that has to outlive the turn that started it.
 *
 * The shell tool is the right way to run a command that finishes. It is the
 * wrong way to run one that does not, because a dev server started that way is
 * a child of this turn's CLI and dies with it — see `dev-servers.ts` for why
 * that happens and why it is not fixable from the agent's side.
 *
 * So this exists to be *preferred over the shell* for one specific shape of
 * command, and the descriptions say so directly. A tool the model has to reason
 * its way to is a tool that gets used half the time.
 */

const textResult = (payload: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

/**
 * How long to watch the output for an address before answering.
 *
 * Long enough for Vite or Next to announce a port, short enough not to stall
 * the turn. Failing to find one is not an error — the server may be slow, and
 * `dev_server_status` exists for exactly that case.
 */
const URL_WAIT_MS = 4_000;
const URL_POLL_MS = 250;

const startTool = (sessionId: string) => tool(
  'dev_server_start',
  [
    'Start a long-running server — a dev server, a preview build, a static file server, a watcher.',
    'USE THIS INSTEAD OF THE SHELL for anything that does not exit on its own. A background shell command is a child of this turn and is killed shortly after the turn ends, which is why servers started that way stop working a message or two later. Processes started here belong to the application and keep running across turns until they are stopped or the app closes.',
    'It waits briefly for the server to announce its address and, if it finds one, opens the preview pane automatically — so you do not need to call preview_open after this.',
  ].join(' '),
  {
    command: z.string().min(1)
      .describe('The command to run, exactly as you would type it in a terminal, e.g. "npm run dev".'),
    cwd: z.string().min(1)
      .describe('Absolute path to run it in. Use the project directory, not a guess.'),
    url: z.string().optional()
      .describe('The address it will serve, if you already know it, e.g. http://localhost:5173. Omit to let it be detected from the output.'),
    title: z.string().max(60).optional()
      .describe('Short label for the preview pane, e.g. "Todo app".'),
  },
  async ({ command, cwd, url, title }) => {
    const started = startDevServer({ command, cwd, url: url ?? null });

    // Watch for an address rather than sleeping a fixed time and hoping.
    let found = url ?? null;
    const deadline = Date.now() + URL_WAIT_MS;
    while (!found && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, URL_POLL_MS));
      const current = readDevServer(started.id);
      if (!current) break;
      if (current.status === 'exited') {
        return textResult({
          ok: false,
          id: started.id,
          exitCode: current.exitCode,
          log: current.log.slice(-20),
          error: 'The server exited immediately. Its last output is above.',
        }, true);
      }
      found = detectUrl(current.log);
    }

    const shown = found ? openPreviewFor(sessionId, found, title) : false;
    const current = readDevServer(started.id);

    return textResult({
      ok: true,
      id: started.id,
      url: found,
      previewOpened: shown,
      note: found
        ? 'Running, and showing in the preview pane.'
        : 'Running, but no address was announced yet. Call dev_server_status to read its output, then preview_open once you know the port.',
      log: current?.log.slice(-10) ?? [],
    });
  },
);

const statusTool = tool(
  'dev_server_status',
  'List the servers started with dev_server_start, with their recent output. Use this to check whether one is still up, or to read why one stopped.',
  {
    id: z.string().optional().describe('One server. Omit for all of them.'),
  },
  async ({ id }) => {
    if (id) {
      const one = readDevServer(id);
      if (!one) return textResult({ ok: false, error: `No server ${id}. It may have been stopped.` }, true);
      return textResult({ ok: true, server: { ...one, log: one.log.slice(-40) } });
    }

    return textResult({
      ok: true,
      servers: listDevServers().map((server) => ({
        id: server.id,
        command: server.command,
        url: server.url,
        status: server.status,
        exitCode: server.exitCode,
        lastOutput: server.log.slice(-3),
      })),
    });
  },
);

const stopTool = tool(
  'dev_server_stop',
  'Stop a server started with dev_server_start. Only when it is genuinely no longer wanted — the user may still be looking at it, and these are meant to outlive the turn.',
  { id: z.string().describe('The id returned by dev_server_start.') },
  async ({ id }) => {
    const stopped = await stopDevServer(id);
    return stopped
      ? textResult({ ok: true, id, stopped: true })
      : textResult({ ok: false, error: `No server ${id}.` }, true);
  },
);

export const DEVSERVER_ALLOWED_TOOLS = [
  'mcp__tails-devserver__dev_server_start',
  'mcp__tails-devserver__dev_server_status',
  'mcp__tails-devserver__dev_server_stop',
];

/**
 * Built per turn, because starting a server opens this conversation's preview.
 *
 * Only `dev_server_start` needs the id — it opens the pane itself once the
 * server announces a port — but the whole server is constructed per turn rather
 * than mixing a factory tool with two constants, which would leave the next
 * person guessing which is which.
 */
export const createDevServerServer = (sessionId: string) => createSdkMcpServer({
  name: 'tails-devserver',
  version: '1.0.0',
  tools: [startTool(sessionId), statusTool, stopTool],
});
