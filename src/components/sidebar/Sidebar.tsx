import {
  Archive, ArchiveRestore, ArrowDownUp, ChevronDown, PanelLeftClose, Pencil, Pin, PinOff,
  Plus, Search, Settings, Store, Trash2, X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { FloatingCard } from '@/components/sidebar/FloatingCard';
import { SessionRow } from '@/components/sidebar/SessionRow';
import { useWebSocket } from '@/contexts/WebSocketContext';
import { api, type SessionListItem } from '@/lib/api';
import { cn } from '@/lib/utils';

export type SessionOrdering = 'recent' | 'oldest' | 'alphabetical';

type SidebarProps = {
  activeSessionId: string | null;
  onSelect: (session: SessionListItem) => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
  onOpenMarketplace: () => void;
  onToggleCollapsed: () => void;
  /** Fired after a rename lands, so the header can follow the active chat. */
  onRenamed: (sessionId: string, title: string) => void;
  onDelete: (session: SessionListItem) => void;
  refreshToken: number;
};

/** Coalescing window for list reloads. One turn publishes three changes. */
const RELOAD_DEBOUNCE_MS = 120;
/** Hover dwell before the folder/time card appears, so scanning stays quiet. */
const HOVER_DELAY_MS = 400;

/** Renders "3h ago" / "2d ago" without pulling in a date library. */
function readRelativeTime(isoDate: string): string {
  const elapsedMs = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.round(elapsedMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(isoDate).toLocaleDateString();
}

/** The last path segment, which is the part that identifies a project. */
function readFolderName(cwd: string): string {
  if (!cwd) return '';
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

type MenuState = { session: SessionListItem; x: number; y: number } | null;
type HoverState = { session: SessionListItem; x: number; y: number } | null;

export function Sidebar({
  activeSessionId,
  onSelect,
  onNewChat,
  onOpenSettings,
  onOpenMarketplace,
  onToggleCollapsed,
  onRenamed,
  onDelete,
  refreshToken,
}: SidebarProps) {
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [chatsExpanded, setChatsExpanded] = useState(true);
  const [ordering, setOrdering] = useState<SessionOrdering>('recent');
  const [showArchived, setShowArchived] = useState(false);
  const [orderMenuOpen, setOrderMenuOpen] = useState(false);
  const [menu, setMenu] = useState<MenuState>(null);
  const [hover, setHover] = useState<HoverState>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const orderMenuRef = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<number | undefined>(undefined);

  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  // Bumped by anything that wants the list re-read. Keeping the fetch in one
  // effect keyed on a counter means there is a single place that can cancel an
  // in-flight response, so a slow reload can never overwrite a newer one.
  const [reloadNonce, setReloadNonce] = useState(0);
  const { subscribe } = useWebSocket();

  const requestReload = useCallback(() => setReloadNonce((current) => current + 1), []);

  useEffect(() => {
    let cancelled = false;

    api.listSessions(200, showArchived)
      .then((items) => {
        if (!cancelled) setSessions(items);
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [showArchived, refreshToken, reloadNonce]);

  /**
   * Live list updates.
   *
   * The server publishes `sessions_changed` whenever a title, a pin, an
   * archive flag or a last-message timestamp moves — including from a run in
   * another window. Debounced because one chat turn publishes three times: on
   * send, when the transcript is created, and on completion.
   */
  useEffect(() => {
    let timer: number | undefined;

    const unsubscribe = subscribe((message) => {
      if (message.kind !== 'sessions_changed') return;
      window.clearTimeout(timer);
      timer = window.setTimeout(requestReload, RELOAD_DEBOUNCE_MS);
    });

    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [subscribe, requestReload]);

  useEffect(() => () => window.clearTimeout(hoverTimerRef.current), []);

  const closeMenu = useCallback(() => setMenu(null), []);
  const closeOrderMenu = useCallback(() => setOrderMenuOpen(false), []);

  const dismissHover = useCallback(() => {
    window.clearTimeout(hoverTimerRef.current);
    setHover(null);
  }, []);

  // The ordering dropdown stays anchored inside the sidebar, so it gets its own
  // outside-click handler rather than `FloatingCard`'s. The ref spans the
  // toggle as well as the menu: without that, the pointerdown that closes it
  // would be followed by the toggle's own click reopening it.
  useEffect(() => {
    if (!orderMenuOpen) return undefined;

    const onPointerDown = (event: PointerEvent) => {
      if (orderMenuRef.current?.contains(event.target as Node)) return;
      setOrderMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOrderMenuOpen(false);
    };

    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [orderMenuOpen]);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    // Focus after the input has actually mounted.
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);

  /**
   * Gives a conversation a row in our database before we try to change it.
   *
   * Pin, archive, rename and delete all write to that row, and a chat
   * discovered in Claude Code's own history does not have one until it is
   * adopted. The provider id doubles as the app id, so the entry keeps its
   * identity and the sidebar needs no id remapping.
   */
  const ensureOwned = useCallback(async (session: SessionListItem) => {
    if (!session.external) return;
    await api.adoptSession(session.id, {
      cwd: session.cwd,
      title: session.title,
      lastActivityAt: session.updatedAt,
    });
  }, []);

  // Every action patches local state first and lets the server's broadcast
  // confirm it. The write is a round trip the user should not have to watch,
  // and a failure simply reloads the truth.
  const patchLocal = useCallback((sessionId: string, patch: Partial<SessionListItem>) => {
    setSessions((current) => current.map(
      (entry) => (entry.id === sessionId ? { ...entry, ...patch } : entry),
    ));
  }, []);

  const commitRename = useCallback(async (session: SessionListItem, rawTitle: string) => {
    setRenamingId(null);
    const title = rawTitle.trim();
    if (!title || title === session.title) return;

    patchLocal(session.id, { title });
    try {
      await ensureOwned(session);
      const updated = await api.renameSession(session.id, title);
      onRenamed(session.id, updated.title);
    } catch {
      requestReload();
    }
  }, [ensureOwned, onRenamed, patchLocal, requestReload]);

  const togglePinned = useCallback(async (session: SessionListItem) => {
    patchLocal(session.id, { pinned: !session.pinned });
    try {
      await ensureOwned(session);
      await api.setSessionPinned(session.id, !session.pinned);
    } catch {
      requestReload();
    }
  }, [ensureOwned, patchLocal, requestReload]);

  const toggleArchived = useCallback(async (session: SessionListItem) => {
    // An archived chat leaves whichever list is on screen, so drop the row
    // outright rather than patching a flag nothing here would read again.
    setSessions((current) => current.filter((entry) => entry.id !== session.id));
    try {
      await ensureOwned(session);
      await api.setSessionArchived(session.id, !session.archived);
    } catch {
      requestReload();
    }
  }, [ensureOwned, requestReload]);

  const removeSession = useCallback(async (session: SessionListItem) => {
    setSessions((current) => current.filter((entry) => entry.id !== session.id));
    try {
      // Deleting reaches the same row, so an external chat has to be adopted
      // first; that is also what leaves the tombstone keeping Claude Code's
      // copy of it out of the list.
      await ensureOwned(session);
    } catch {
      // Fall through: the parent still gets its chance, and a failed delete
      // reappears on the next reload.
    }
    onDelete(session);
  }, [ensureOwned, onDelete]);

  const scheduleHover = useCallback((session: SessionListItem, anchor: HTMLElement | null) => {
    window.clearTimeout(hoverTimerRef.current);
    if (!anchor) {
      setHover(null);
      return;
    }

    const rect = anchor.getBoundingClientRect();
    hoverTimerRef.current = window.setTimeout(
      () => setHover({ session, x: rect.right + 8, y: rect.top }),
      HOVER_DELAY_MS,
    );
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? sessions.filter((session) => (
        session.title.toLowerCase().includes(needle)
        || session.cwd.toLowerCase().includes(needle)
      ))
      : sessions;

    const byOrdering = (left: SessionListItem, right: SessionListItem) => {
      if (ordering === 'alphabetical') return left.title.localeCompare(right.title);
      // Parsed rather than compared as strings: our own rows and the ones the
      // SDK reports are not written in the same timestamp format, and a
      // lexical compare interleaved the two sources by format before date.
      const leftAt = Date.parse(left.updatedAt);
      const rightAt = Date.parse(right.updatedAt);
      return ordering === 'oldest' ? leftAt - rightAt : rightAt - leftAt;
    };

    return [...filtered].sort((left, right) => {
      // Pinned first in every ordering — a pin is a statement about the list,
      // not about the sort key.
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      return byOrdering(left, right);
    });
  }, [sessions, query, ordering]);

  return (
    <aside
      data-tails-part="sidebar"
      className="flex h-full w-72 shrink-0 flex-col"
    >
      {/* 56px. Three places have to agree on this number or the window's drag
          region and the OS caption buttons stop lining up with the chrome:
          here, the shell header, and `HEADER_HEIGHT` in electron/main.js. */}
      <div className="app-drag flex h-14 shrink-0 items-center gap-1 px-3.5">
        <span className="font-display text-base font-semibold tracking-[0.2em]">TAILS</span>
        <div className="app-no-drag ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={openSearch}
            aria-label="Search chats"
            title="Search chats"
            className="rounded-sm p-2 text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
          >
            <Search className="size-[1.125rem]" />
          </button>
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label="Hide sidebar"
            title="Hide sidebar"
            className="rounded-sm p-2 text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
          >
            <PanelLeftClose className="size-[1.125rem]" />
          </button>
        </div>
      </div>

      {searchOpen ? (
        <div className="animate-fade-in px-3 pb-2">
          {/* The field is the wrapper, not the `input` element: the icon and
              the clear button sit inside the same box. */}
          <div
            data-tails-part="input"
            className="flex items-center gap-2 px-2.5 py-1.5 focus-within:ring-2 focus-within:ring-ring"
          >
            <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              ref={searchInputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                setQuery('');
                setSearchOpen(false);
              }}
              placeholder="Search chats and folders"
              aria-label="Search conversations"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setSearchOpen(false);
              }}
              aria-label="Close search"
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      ) : null}

      <nav className="space-y-0.5 px-2 pb-2">
        <button
          type="button"
          onClick={onNewChat}
          className="flex w-full items-center gap-2 rounded-sm bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-transform duration-instant ease-emphasis active:scale-[0.98]"
        >
          <Plus className="size-4" aria-hidden="true" />
          New chat
        </button>

        <button
          type="button"
          onClick={onOpenMarketplace}
          className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-sm text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
        >
          <Store className="size-4" aria-hidden="true" />
          Marketplace
        </button>
      </nav>

      <div className="flex items-center gap-1 px-4 py-1.5">
        <button
          type="button"
          onClick={() => setChatsExpanded((current) => !current)}
          className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors duration-quick hover:text-foreground"
          aria-expanded={chatsExpanded}
        >
          <ChevronDown
            className={cn(
              'size-3 transition-transform duration-quick ease-standard',
              !chatsExpanded && '-rotate-90',
            )}
            aria-hidden="true"
          />
          {showArchived ? 'Archived' : 'Chats'}
        </button>

        <div ref={orderMenuRef} className="relative ml-auto flex items-center gap-0.5">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setOrderMenuOpen((current) => !current);
            }}
            aria-label="Change ordering"
            title="Change ordering"
            className="rounded-sm p-1 text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
          >
            <ArrowDownUp className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={onNewChat}
            aria-label="New chat"
            title="New chat"
            className="rounded-sm p-1 text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
          >
            <Plus className="size-3.5" />
          </button>

          {orderMenuOpen ? (
            // Positioning on the wrapper, the surface on the child. Keeping
            // them apart means the anchor never depends on how the surface
            // contract happens to specify `position` today.
            <div className="absolute right-0 top-7 z-20">
              <div
                data-tails-part="popover"
                className="animate-scale-in w-44 overflow-hidden py-1"
              >
                {([
                  ['recent', 'Most recent'],
                  ['oldest', 'Oldest first'],
                  ['alphabetical', 'Alphabetical'],
                ] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => {
                      setOrdering(value);
                      closeOrderMenu();
                    }}
                    className={cn(
                      'block w-full px-3 py-1.5 text-left text-xs transition-colors duration-quick hover:bg-accent',
                      ordering === value && 'text-primary',
                    )}
                  >
                    {label}
                  </button>
                ))}
                <div className="my-1 border-t border-border" />
                <button
                  type="button"
                  onClick={() => {
                    setShowArchived((current) => !current);
                    closeOrderMenu();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors duration-quick hover:bg-accent"
                >
                  <Archive className="size-3.5" aria-hidden="true" />
                  {showArchived ? 'Show active chats' : 'Show archived'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {chatsExpanded ? (
        <div className="min-h-0 flex-1 space-y-px overflow-y-auto px-2 pb-2">
          {loading ? (
            <div className="space-y-1 px-1">
              {[0, 1, 2, 3].map((index) => (
                <div
                  key={index}
                  className="h-8 animate-fade-in rounded-sm bg-muted/50"
                  style={{ animationDelay: `${index * 50}ms` }}
                />
              ))}
            </div>
          ) : null}

          {!loading && visible.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {query ? 'No chats match that.' : showArchived ? 'Nothing archived.' : 'No conversations yet.'}
            </p>
          ) : null}

          {visible.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              active={session.id === activeSessionId}
              renaming={session.id === renamingId}
              onOpen={() => onSelect(session)}
              onOpenMenu={(x, y) => {
                dismissHover();
                setMenu({ session, x, y });
              }}
              onHover={(anchor) => scheduleHover(session, anchor)}
              onCommitRename={(title) => void commitRename(session, title)}
              onCancelRename={() => setRenamingId(null)}
            />
          ))}
        </div>
      ) : (
        <div className="flex-1" />
      )}

      {/* Folder and last-activity, on hover only. They used to occupy a second
          line in every row, which is what made the list twice as tall as it
          needed to be. */}
      {hover && !menu ? (
        <FloatingCard x={hover.x} y={hover.y} className="w-64 px-3 py-2">
          <p className="text-xs font-medium leading-snug">{hover.session.title}</p>
          <p
            className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground"
            title={hover.session.cwd}
          >
            <span className="truncate font-mono">
              {readFolderName(hover.session.cwd) || 'No folder'}
            </span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0">{readRelativeTime(hover.session.updatedAt)}</span>
          </p>
        </FloatingCard>
      ) : null}

      {menu ? (
        <FloatingCard x={menu.x} y={menu.y} onDismiss={closeMenu} className="w-44 py-1">
          <button
            type="button"
            onClick={() => {
              setRenamingId(menu.session.id);
              closeMenu();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors duration-quick hover:bg-accent"
          >
            <Pencil className="size-3.5" /> Rename
          </button>
          <button
            type="button"
            onClick={() => {
              void togglePinned(menu.session);
              closeMenu();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors duration-quick hover:bg-accent"
          >
            {menu.session.pinned
              ? <><PinOff className="size-3.5" /> Unpin</>
              : <><Pin className="size-3.5" /> Pin</>}
          </button>
          <button
            type="button"
            onClick={() => {
              void toggleArchived(menu.session);
              closeMenu();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors duration-quick hover:bg-accent"
          >
            {menu.session.archived
              ? <><ArchiveRestore className="size-3.5" /> Unarchive</>
              : <><Archive className="size-3.5" /> Archive</>}
          </button>
          <button
            type="button"
            onClick={() => {
              void removeSession(menu.session);
              closeMenu();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-destructive transition-colors duration-quick hover:bg-destructive/10"
          >
            <Trash2 className="size-3.5" /> Delete
          </button>
        </FloatingCard>
      ) : null}

      <div className="border-t border-border p-2">
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-sm text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
        >
          <Settings className="size-4" aria-hidden="true" />
          Settings
        </button>
      </div>
    </aside>
  );
}
