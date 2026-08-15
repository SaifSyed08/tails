import fs from 'node:fs';
import type { IncomingMessage, Server } from 'node:http';
import { createRequire } from 'node:module';
import type { Duplex } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

import type { IPty } from 'node-pty';

import { readRecord, readString } from '@/shared/utils.js';

/**
 * How many output chunks are retained per shell for replay.
 *
 * The panel is dockable, so closing it is expected to be cheap and frequent.
 * Without a replay buffer, reopening shows an empty screen even though the
 * shell never died — which reads as "my terminal was killed". A few thousand
 * chunks covers a normal scrollback without letting a `yes`-style firehose
 * grow the process without bound.
 */
const MAX_REPLAY_CHUNKS = 4000;

/** Second bound on the same buffer, for one process emitting huge chunks. */
const MAX_REPLAY_BYTES = 2_000_000;

/**
 * How long a shell survives with no panel attached.
 *
 * Long enough that closing the panel to read something and reopening it keeps
 * your `cd` and your history; short enough that an abandoned build isn't still
 * holding a pty an hour later.
 */
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

/** Cap on simultaneously live shells; the idlest is reaped past this. */
const MAX_SESSIONS = 8;

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

const TERMINAL_PATH = '/shell';

type UpgradeListener = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

/**
 * Routes websocket upgrades between this gateway and the ones already attached.
 *
 * `new WebSocketServer({ server, path })` is the obvious way to add a second
 * websocket and it does not work: each such server registers its own `upgrade`
 * listener, and a listener whose `path` does not match *aborts the handshake
 * with a 400* rather than passing it on. Whichever gateway attached first
 * therefore kills every other gateway's connections — `/shell` returns 400
 * before this file's `connection` handler is ever reached.
 *
 * So this gateway runs in `noServer` mode behind a single dispatcher: it takes
 * over the existing `upgrade` listeners, claims `/shell`, and hands everything
 * else back to them untouched.
 */
function routeUpgrades(server: Server, wss: WebSocketServer): void {
  const existing = server.listeners('upgrade') as UpgradeListener[];
  for (const listener of existing) server.removeListener('upgrade', listener);

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname: string | null = null;
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      pathname = null;
    }

    if (pathname === TERMINAL_PATH) {
      wss.handleUpgrade(request, socket, head, (client) => {
        wss.emit('connection', client, request);
      });
      return;
    }

    for (const listener of existing) listener.call(server, request, socket, head);
  });
}

type TerminalSession = {
  key: string;
  cwd: string;
  pty: IPty;
  cols: number;
  rows: number;
  /** Bounded replay buffer — see MAX_REPLAY_CHUNKS. */
  buffer: string[];
  bufferBytes: number;
  sockets: Set<WebSocket>;
  idleTimer: NodeJS.Timeout | null;
  lastUsedAt: number;
};

type ServerFrame =
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number };

type NodePty = typeof import('node-pty');

/**
 * `undefined` means "not tried yet", `null` means "tried and unavailable".
 *
 * node-pty is a native addon: on a machine whose prebuilt binary does not match
 * the running Node/Electron ABI, importing it throws. That must degrade to a
 * terminal panel that says so, never to a server that refuses to boot — the
 * chat is the product, the shell is a convenience.
 */
let ptyModule: NodePty | null | undefined;

function loadPty(): NodePty | null {
  if (ptyModule !== undefined) return ptyModule;

  // Escape hatch for exercising the degraded path on a machine where the native
  // module *does* load — otherwise the only way to test it is to break the
  // install.
  if (process.env.TAILS_DISABLE_PTY === '1') {
    console.warn('[terminal] TAILS_DISABLE_PTY=1 — the terminal panel is disabled.');
    ptyModule = null;
    return ptyModule;
  }

  try {
    const nodeRequire = createRequire(import.meta.url);
    ptyModule = nodeRequire('node-pty') as NodePty;
  } catch (error) {
    console.error(
      '[terminal] node-pty could not be loaded — the terminal panel will be disabled. '
      + 'Rebuild the native module for this runtime (`npm rebuild node-pty`).',
      error,
    );
    ptyModule = null;
  }

  return ptyModule;
}

/** Candidate shells in preference order for the current platform. */
function shellCandidates(): string[] {
  if (process.platform === 'win32') {
    return ['powershell.exe', process.env.COMSPEC, 'cmd.exe']
      .filter((entry): entry is string => Boolean(entry));
  }

  return [process.env.SHELL, '/bin/bash', '/bin/sh']
    .filter((entry): entry is string => Boolean(entry));
}

/**
 * Resolves a usable working directory.
 *
 * A cwd that no longer exists makes `spawn` fail with an errno that surfaces to
 * the user as a blank panel, so an unusable path falls back to home rather than
 * failing the whole session.
 */
function resolveCwd(requested: string | null): string {
  if (requested) {
    try {
      const absolute = path.resolve(requested);
      if (fs.statSync(absolute).isDirectory()) return absolute;
    } catch {
      // Fall through to the home directory.
    }
  }

  return os.homedir() || process.cwd();
}

/** Case-insensitive on Windows, where two spellings of a path are one place. */
function sessionKey(cwd: string): string {
  return process.platform === 'win32' ? cwd.toLowerCase() : cwd;
}

function clampDimension(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(1000, Math.max(1, Math.floor(value)));
}

type ClientFrame =
  | { type: 'init'; cwd: string | null; cols: number; rows: number; restart: boolean }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

/** Parses an inbound frame, returning null for anything unrecognised. */
function parseClientFrame(raw: string): ClientFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const message = readRecord(parsed);
  if (!message) return null;

  switch (message.type) {
    case 'init':
      return {
        type: 'init',
        cwd: readString(message.cwd),
        cols: clampDimension(message.cols, DEFAULT_COLS),
        rows: clampDimension(message.rows, DEFAULT_ROWS),
        restart: message.restart === true,
      };

    case 'input':
      return typeof message.data === 'string' ? { type: 'input', data: message.data } : null;

    case 'resize':
      return {
        type: 'resize',
        cols: clampDimension(message.cols, DEFAULT_COLS),
        rows: clampDimension(message.rows, DEFAULT_ROWS),
      };

    default:
      return null;
  }
}

/**
 * Attaches the shell websocket to the HTTP server.
 *
 * Shells are keyed by working directory and outlive the socket that created
 * them, so the panel is a *view* onto a long-lived shell rather than the shell
 * itself. Two windows opened on the same directory share one process, which is
 * what makes a docked panel behave like a real terminal tab.
 */
export function attachTerminalGateway(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  routeUpgrades(server, wss);

  const sessions = new Map<string, TerminalSession>();

  const sendFrame = (socket: WebSocket, frame: ServerFrame) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
  };

  const broadcast = (session: TerminalSession, frame: ServerFrame) => {
    for (const socket of session.sockets) sendFrame(socket, frame);
  };

  const disposeSession = (session: TerminalSession) => {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = null;
    sessions.delete(session.key);
    try {
      session.pty.kill();
    } catch {
      // Already gone; nothing to clean up.
    }
  };

  const scheduleIdleKill = (session: TerminalSession) => {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (session.sockets.size > 0) return;
      disposeSession(session);
    }, IDLE_TIMEOUT_MS);
    // An idle shell must never be the reason the process refuses to exit.
    session.idleTimer.unref?.();
  };

  /** Reaps the least recently used detached shell when the cap is reached. */
  const enforceSessionCap = () => {
    while (sessions.size >= MAX_SESSIONS) {
      const detached = [...sessions.values()]
        .filter((entry) => entry.sockets.size === 0)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

      const victim = detached[0];
      if (!victim) return;
      disposeSession(victim);
    }
  };

  const createSession = (cwd: string, cols: number, rows: number): TerminalSession | null => {
    const pty = loadPty();
    if (!pty) return null;

    const key = sessionKey(cwd);
    enforceSessionCap();

    let child: IPty | null = null;
    let lastError: unknown;

    for (const file of shellCandidates()) {
      try {
        child = pty.spawn(file, [], {
          name: 'xterm-256color',
          cols,
          rows,
          cwd,
          env: {
            ...process.env,
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
          },
        });
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!child) {
      console.error('[terminal] no shell could be spawned:', lastError);
      return null;
    }

    const session: TerminalSession = {
      key,
      cwd,
      pty: child,
      cols,
      rows,
      buffer: [],
      bufferBytes: 0,
      sockets: new Set(),
      idleTimer: null,
      lastUsedAt: Date.now(),
    };

    child.onData((data) => {
      session.buffer.push(data);
      session.bufferBytes += data.length;
      while (
        session.buffer.length > MAX_REPLAY_CHUNKS
        || session.bufferBytes > MAX_REPLAY_BYTES
      ) {
        const dropped = session.buffer.shift();
        if (dropped === undefined) break;
        session.bufferBytes -= dropped.length;
      }

      broadcast(session, { type: 'output', data });
    });

    child.onExit(({ exitCode }) => {
      broadcast(session, { type: 'exit', code: exitCode });
      if (session.idleTimer) clearTimeout(session.idleTimer);
      session.idleTimer = null;
      // Dropped from the map rather than kept as a corpse, so the next `init`
      // for this directory spawns a fresh shell instead of attaching to a dead
      // one and looking frozen.
      sessions.delete(session.key);
    });

    sessions.set(key, session);
    return session;
  };

  wss.on('connection', (socket) => {
    let attached: TerminalSession | null = null;

    const detach = () => {
      if (!attached) return;
      attached.sockets.delete(socket);
      attached.lastUsedAt = Date.now();
      if (attached.sockets.size === 0) scheduleIdleKill(attached);
      attached = null;
    };

    const handleInit = (frame: Extract<ClientFrame, { type: 'init' }>) => {
      detach();

      const cwd = resolveCwd(frame.cwd);
      const key = sessionKey(cwd);

      const existing = sessions.get(key);
      if (existing && frame.restart) disposeSession(existing);

      const session = (!frame.restart && existing) || createSession(cwd, frame.cols, frame.rows);

      if (!session) {
        sendFrame(socket, {
          type: 'output',
          data: '\r\n\x1b[31mThe terminal backend is unavailable on this machine.\x1b[0m\r\n'
            + 'node-pty failed to load — see the server log for details.\r\n',
        });
        sendFrame(socket, { type: 'exit', code: -1 });
        return;
      }

      attached = session;
      session.sockets.add(socket);
      session.lastUsedAt = Date.now();
      if (session.idleTimer) {
        clearTimeout(session.idleTimer);
        session.idleTimer = null;
      }

      // Replay before resizing: the buffer was written at the old geometry, and
      // resizing first makes ConPTY reflow content the client has not seen yet.
      for (const chunk of session.buffer) {
        sendFrame(socket, { type: 'output', data: chunk });
      }

      if (session.cols !== frame.cols || session.rows !== frame.rows) {
        session.cols = frame.cols;
        session.rows = frame.rows;
        try {
          session.pty.resize(frame.cols, frame.rows);
        } catch {
          // A shell that exited between spawn and resize; onExit handles it.
        }
      }
    };

    socket.on('message', (raw) => {
      const frame = parseClientFrame(raw.toString());
      if (!frame) return;

      switch (frame.type) {
        case 'init':
          handleInit(frame);
          return;

        case 'input':
          if (!attached) return;
          attached.lastUsedAt = Date.now();
          try {
            attached.pty.write(frame.data);
          } catch {
            // Write to a dead pty; onExit has already told the client.
          }
          return;

        case 'resize': {
          if (!attached) return;
          if (attached.cols === frame.cols && attached.rows === frame.rows) return;
          attached.cols = frame.cols;
          attached.rows = frame.rows;
          try {
            attached.pty.resize(frame.cols, frame.rows);
          } catch {
            // Same as above.
          }
          return;
        }
      }
    });

    socket.on('close', detach);
    socket.on('error', detach);
  });

  // The shells are children of this process; leaving them running would leak a
  // pty per directory every time the server restarts in watch mode.
  const closeAll = () => {
    for (const session of [...sessions.values()]) disposeSession(session);
  };

  wss.on('close', closeAll);
  process.once('exit', closeAll);

  return wss;
}
