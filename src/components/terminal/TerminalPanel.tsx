import { ClipboardAddon } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { Plus, TerminalSquare, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { readTerminalTheme } from '@/components/terminal/xtermTheme';
import { cn } from '@/lib/utils';

// Imported here rather than from the global stylesheet so the panel carries its
// own dependency: nothing breaks if the app is ever built without it mounted.
import '@xterm/xterm/css/xterm.css';

/** The event another part of the app dispatches after a theme is applied. */
const APPEARANCE_EVENT = 'tails:appearance-changed';

const HEIGHT_STORAGE_KEY = 'tails.terminal.height';
const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 140;

/**
 * Resize is debounced because `fit()` reflows the pty.
 *
 * A drag emits a pointermove per frame; forwarding each one would send ~60
 * SIGWINCH-equivalents a second and make a running program redraw itself into a
 * flicker. One fit at the end of a gesture burst is indistinguishable to the
 * eye and calm for the shell.
 */
const RESIZE_DEBOUNCE_MS = 80;

const RECONNECT_DELAY_MS = 2000;

type ConnectionStatus = 'connecting' | 'ready' | 'exited';

type ServerFrame =
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number };

function clampHeight(value: number): number {
  const ceiling = typeof window === 'undefined'
    ? 640
    : Math.max(MIN_HEIGHT, Math.round(window.innerHeight * 0.85));
  return Math.min(ceiling, Math.max(MIN_HEIGHT, Math.round(value)));
}

function readStoredHeight(): number {
  try {
    const raw = window.localStorage.getItem(HEIGHT_STORAGE_KEY);
    const parsed = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) ? clampHeight(parsed) : DEFAULT_HEIGHT;
  } catch {
    return DEFAULT_HEIGHT;
  }
}

function storeHeight(value: number): void {
  try {
    window.localStorage.setItem(HEIGHT_STORAGE_KEY, String(value));
  } catch {
    // A blocked localStorage costs the remembered height, nothing more.
  }
}

export type TerminalPanelProps = {
  /** Working directory the shell runs in. Changing it attaches a new shell. */
  cwd: string;
  onClose: () => void;
};

/**
 * A dockable shell, backed by the `/shell` websocket.
 *
 * The pty lives on the server keyed by `cwd`, so this component is a *view*: it
 * can be unmounted and remounted, or dropped by a reconnect, and the shell it
 * reattaches to is the same process with the same history. That is why the
 * terminal is reset before every `init` — the server replays its buffer, and
 * repainting from a clean screen is what makes reattaching idempotent instead
 * of doubling the scrollback.
 */
export function TerminalPanel({ cwd, onClose }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const dragRef = useRef<{ pointerY: number; height: number } | null>(null);

  const [height, setHeight] = useState<number>(readStoredHeight);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  // Bumping this tears the view down and rebuilds it; `restart` additionally
  // tells the server to discard the existing shell for this directory.
  const [session, setSession] = useState({ id: 0, restart: false });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const { theme, fontFamily } = readTerminalTheme();

    const terminal = new Terminal({
      // The clipboard addon is built on proposed API; without this it throws on
      // load rather than degrading.
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily,
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5000,
      theme,
    });

    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new ClipboardAddon());
    terminal.loadAddon(new WebLinksAddon((_event, uri) => {
      window.open(uri, '_blank', 'noopener,noreferrer');
    }));

    terminal.open(container);

    // WebGL is a straight upgrade where it exists and unavailable where it does
    // not (software rendering, a lost context, a locked-down GPU). Failing to
    // load it must be invisible — the canvas renderer is already correct.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      terminal.loadAddon(webgl);
    } catch {
      // Canvas renderer stays in place.
    }

    try {
      fit.fit();
    } catch {
      // A container with no layout yet; the ResizeObserver fits it shortly.
    }

    terminalRef.current = terminal;
    fitRef.current = fit;

    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let resizeTimer: number | undefined;
    let restartOnConnect = session.restart;

    const send = (payload: unknown) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
    };

    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${protocol}://${window.location.host}/shell`);

      socket.onopen = () => {
        setStatus('ready');
        terminal.reset();
        send({
          type: 'init',
          cwd,
          cols: terminal.cols,
          rows: terminal.rows,
          restart: restartOnConnect,
        });
        // A reconnect must reattach, never wipe the shell the user was using.
        restartOnConnect = false;
      };

      socket.onmessage = (event) => {
        let frame: ServerFrame;
        try {
          frame = JSON.parse(event.data as string) as ServerFrame;
        } catch {
          return;
        }

        if (frame.type === 'output') {
          terminal.write(frame.data);
          return;
        }

        if (frame.type === 'exit') {
          setStatus('exited');
          terminal.write(`\r\n\x1b[2m[process exited with code ${frame.code}]\x1b[0m\r\n`);
        }
      };

      socket.onclose = () => {
        if (disposed) return;
        setStatus((current) => (current === 'exited' ? current : 'connecting'));
        reconnectTimer = window.setTimeout(connect, RECONNECT_DELAY_MS);
      };

      socket.onerror = () => socket?.close();
    };

    connect();

    const inputSubscription = terminal.onData((data) => send({ type: 'input', data }));
    const resizeSubscription = terminal.onResize(({ cols, rows }) => {
      send({ type: 'resize', cols, rows });
    });

    const observer = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        try {
          fit.fit();
        } catch {
          // Zero-sized while the panel animates; the next tick fits it.
        }
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(container);

    return () => {
      disposed = true;
      window.clearTimeout(reconnectTimer);
      window.clearTimeout(resizeTimer);
      observer.disconnect();
      inputSubscription.dispose();
      resizeSubscription.dispose();
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
      terminalRef.current = null;
      fitRef.current = null;
      terminal.dispose();
    };
  }, [cwd, session]);

  // Re-derive the palette whenever a theme lands. Deferred a frame because the
  // event fires as the stylesheet is swapped, and reading tokens in the same
  // tick can still return the outgoing values.
  useEffect(() => {
    const handleAppearanceChange = () => {
      window.requestAnimationFrame(() => {
        const terminal = terminalRef.current;
        if (!terminal) return;
        try {
          const { theme, fontFamily } = readTerminalTheme();
          terminal.options.theme = theme;
          terminal.options.fontFamily = fontFamily;
          fitRef.current?.fit();
        } catch {
          // Disposed between the event and the frame.
        }
      });
    };

    window.addEventListener(APPEARANCE_EVENT, handleAppearanceChange);
    return () => window.removeEventListener(APPEARANCE_EVENT, handleAppearanceChange);
  }, []);

  const restart = useCallback(() => {
    setStatus('connecting');
    setSession((current) => ({ id: current.id + 1, restart: true }));
  }, []);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragRef.current = { pointerY: event.clientY, height };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    // Dragging the top edge upward grows the panel, hence the inverted delta.
    setHeight(clampHeight(drag.height + (drag.pointerY - event.clientY)));
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    storeHeight(height);
  };

  const nudgeHeight = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 16;
    const delta = event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = clampHeight(height + delta);
    setHeight(next);
    storeHeight(next);
  };

  return (
    <div
      data-tails-part="terminal"
      style={{ height }}
      className="relative flex shrink-0 flex-col overflow-hidden border-t border-border bg-card"
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal"
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={nudgeHeight}
        className="absolute inset-x-0 top-0 z-10 h-1.5 cursor-row-resize transition-colors duration-quick ease-standard hover:bg-primary/40 focus-visible:bg-primary/60 focus-visible:outline-none"
      />

      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <TerminalSquare className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate font-mono text-xs text-muted-foreground" title={cwd}>
          {cwd}
        </span>
        <span
          className={cn(
            'shrink-0 text-[0.625rem] uppercase tracking-wide',
            status === 'ready' && 'text-positive',
            status === 'connecting' && 'text-warning',
            status === 'exited' && 'text-muted-foreground',
          )}
        >
          {status === 'ready' ? 'live' : status}
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={restart}
            aria-label="New terminal"
            title="New terminal"
            className="rounded-md p-1 text-muted-foreground transition-colors duration-quick ease-standard hover:bg-accent hover:text-accent-foreground"
          >
            <Plus className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close terminal"
            title="Close terminal"
            className="rounded-md p-1 text-muted-foreground transition-colors duration-quick ease-standard hover:bg-accent hover:text-accent-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden bg-background px-2 py-1" />
    </div>
  );
}

export default TerminalPanel;
