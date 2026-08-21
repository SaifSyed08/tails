import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

/**
 * Long-running processes owned by the app rather than by a turn.
 *
 * ## The problem this exists to solve
 *
 * A dev server started with the ordinary shell tool is a child of the Claude
 * Code CLI, and this app spawns **a fresh CLI per turn** — see the note beside
 * `permissionMode` in `claude-runtime.ts`. Twenty seconds after a turn ends the
 * SDK query is aborted to stop reading that subprocess, and the whole process
 * tree goes with it. So `npm run dev` reliably died shortly after the message
 * that started it, and again on the next message, which read as the app killing
 * servers at random.
 *
 * The obvious fix was to make the conversation own one long-lived CLI instead of
 * one per turn. That is a rewrite of the run lifecycle, and it turns out to be
 * the wrong shape anyway: the thing that needs to outlive a turn is not the
 * *agent*, it is the *server*. So the server gets its own process, parented to
 * the app rather than to whatever turn happened to start it — the same idea as
 * opening a second terminal tab for a dev server instead of running it in the
 * one you are working in.
 *
 * ## What still ends them
 *
 * The app. These are children of the long-lived server process, not detached
 * from it, and that is deliberate: a preview server that outlives the
 * application is an orphan holding a port, and the user has no way to find it.
 * Closing TAILS stops them; a turn ending does not.
 */

/** Lines of output kept per process. Enough to diagnose a crash, bounded. */
const LOG_LINES = 200;

/**
 * How long a stop waits for a graceful exit before insisting.
 *
 * Dev servers usually clean up their port on SIGTERM. The escalation matters
 * because the ones that do not would otherwise hold the port and the next start
 * would fail with an error about something the user never sees.
 */
const STOP_GRACE_MS = 3_000;

/**
 * Kills a process *and everything it started*.
 *
 * `child.kill()` is not enough here and the reason cost a probe: the command
 * runs through a shell, so the child this module holds is the shell, and the
 * dev server is its grandchild. Killing the shell orphans the server — the
 * registry reported the process stopped, `listDevServers()` went empty, and the
 * port carried on serving. A stop that claims success and leaks a port is worse
 * than one that fails loudly.
 *
 * Windows has no process groups to signal, so `taskkill /T` walks the tree.
 * Elsewhere the child leads its own group and the negative pid signals all of
 * it. Either way the tree goes, not just the shell in front of it.
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform === 'win32') {
    // `/T` is the whole point: terminate this process and its descendants.
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    // No group, or already gone. Fall back to the process itself.
    try { child.kill(signal); } catch { /* already exited */ }
  }
}

export type DevServer = {
  id: string;
  command: string;
  cwd: string;
  /** The address the caller said this would serve, if it said. */
  url: string | null;
  startedAt: number;
  status: 'running' | 'exited';
  exitCode: number | null;
  /** Recent output, newest last. */
  log: string[];
};

type Entry = DevServer & { child: ChildProcess };

const servers = new Map<string, Entry>();
let counter = 0;

const publicView = ({ child, ...rest }: Entry): DevServer => {
  void child;
  return { ...rest, log: [...rest.log] };
};

export const listDevServers = (): DevServer[] => [...servers.values()].map(publicView);

export const readDevServer = (id: string): DevServer | null => {
  const entry = servers.get(id);
  return entry ? publicView(entry) : null;
};

function record(entry: Entry, chunk: string): void {
  for (const line of chunk.split(/\r?\n/)) {
    if (!line.trim()) continue;
    entry.log.push(line);
  }
  // Trimmed from the front: a server that has been up for an hour is
  // interesting for what it did most recently, not for how it booted.
  if (entry.log.length > LOG_LINES) entry.log.splice(0, entry.log.length - LOG_LINES);
}

export function startDevServer(input: {
  command: string;
  cwd: string;
  url?: string | null;
}): DevServer {
  counter += 1;
  const id = `dev-${counter}`;

  /*
    Through a shell, because the command is one the agent wrote — `npm run dev`,
    `python -m http.server 8000`, whatever the project uses — and splitting that
    into argv correctly for every shape it can take is a worse problem than
    handing it to the shell that already knows how.
  */
  const child = spawn(input.command, {
    cwd: input.cwd,
    shell: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group everywhere that has them, so the whole tree can be
    // signalled at once. Not on Windows: `detached` there means a new console
    // window, and `taskkill /T` walks the tree without needing it.
    detached: process.platform !== 'win32',
  });

  const entry: Entry = {
    id,
    command: input.command,
    cwd: input.cwd,
    url: input.url ?? null,
    startedAt: Date.now(),
    status: 'running',
    exitCode: null,
    log: [],
    child,
  };

  child.stdout?.on('data', (data: Buffer) => record(entry, data.toString()));
  child.stderr?.on('data', (data: Buffer) => record(entry, data.toString()));

  child.on('error', (error) => {
    record(entry, `failed to start: ${error.message}`);
    entry.status = 'exited';
    entry.exitCode = null;
  });

  child.on('exit', (code) => {
    entry.status = 'exited';
    entry.exitCode = code;
    record(entry, `process exited with code ${code}`);
  });

  servers.set(id, entry);
  return publicView(entry);
}

export async function stopDevServer(id: string): Promise<boolean> {
  const entry = servers.get(id);
  if (!entry) return false;

  if (entry.status === 'running') {
    killTree(entry.child, 'SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // Still there. A dev server that ignores SIGTERM and keeps the port is
        // worse than one killed abruptly.
        killTree(entry.child, 'SIGKILL');
        resolve();
      }, STOP_GRACE_MS);
      entry.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

  servers.delete(id);
  return true;
}

/**
 * Stops everything. Wired to the app shutting down.
 *
 * Without it, quitting TAILS leaves dev servers holding ports with no window
 * left to find them from — the failure mode being avoided is a user who cannot
 * start their own server tomorrow because of one this app forgot about.
 */
export function stopAllDevServers(): void {
  for (const entry of servers.values()) {
    if (entry.status === 'running') killTree(entry.child, 'SIGKILL');
  }
  servers.clear();
}

/**
 * Finds a localhost URL a server has announced.
 *
 * Dev servers print where they are listening, and the agent should not have to
 * guess or be told. Matched loosely on purpose — Vite writes `Local:
 * http://localhost:5173/`, Next writes `- Local: http://localhost:3000`, and a
 * plain Python server writes `Serving HTTP on 0.0.0.0 port 8000` — so the port
 * is taken from whichever form turns up.
 */
export function detectUrl(log: string[]): string | null {
  for (const line of [...log].reverse()) {
    const direct = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d{2,5})/i.exec(line);
    if (direct) return `http://localhost:${direct[1]}`;

    const port = /\bport\s+(\d{2,5})\b/i.exec(line);
    if (port) return `http://localhost:${port[1]}`;
  }
  return null;
}
