import {
  Archive, ArrowDownUp, ChevronDown, MessageSquarePlus, PanelLeftClose,
  Pencil, Search, Settings, Sparkles, Store, Trash2, X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
  onRename: (session: SessionListItem) => void;
  onDelete: (session: SessionListItem) => void;
  refreshToken: number;
};

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

type ContextMenuState = { session: SessionListItem; x: number; y: number } | null;

export function Sidebar({
  activeSessionId,
  onSelect,
  onNewChat,
  onOpenSettings,
  onOpenMarketplace,
  onToggleCollapsed,
  onRename,
  onDelete,
  refreshToken,
}: SidebarProps) {
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [chatsExpanded, setChatsExpanded] = useState(true);
  const [ordering, setOrdering] = useState<SessionOrdering>('recent');
  const [orderMenuOpen, setOrderMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [loaded, setLoaded] = useState<{ items: SessionListItem[]; token: number | null }>({
    items: [],
    token: null,
  });
  const sessions = loaded.items;
  const loading = loaded.token !== refreshToken;

  useEffect(() => {
    let cancelled = false;
    api.listSessions(200)
      .then((items) => {
        if (!cancelled) setLoaded({ items, token: refreshToken });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ items: [], token: refreshToken });
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  // Any click or Escape dismisses the transient menus, so they never strand.
  useEffect(() => {
    if (!contextMenu && !orderMenuOpen) return undefined;

    const dismiss = () => {
      setContextMenu(null);
      setOrderMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };

    window.addEventListener('click', dismiss);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('click', dismiss);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [contextMenu, orderMenuOpen]);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    // Focus after the input has actually mounted.
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? sessions.filter((session) => (
        session.title.toLowerCase().includes(needle)
        || session.cwd.toLowerCase().includes(needle)
      ))
      : sessions;

    const sorted = [...filtered];
    if (ordering === 'alphabetical') {
      sorted.sort((left, right) => left.title.localeCompare(right.title));
    } else if (ordering === 'oldest') {
      sorted.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    } else {
      sorted.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }
    return sorted;
  }, [sessions, query, ordering]);

  return (
    <aside
      data-tails-part="sidebar"
      className="flex h-full w-72 shrink-0 flex-col"
    >
      <div className="app-drag flex h-11 shrink-0 items-center gap-1 px-3">
        <span className="font-display text-sm font-semibold tracking-[0.18em]">TAILS</span>
        <div className="app-no-drag ml-auto flex items-center gap-0.5">
          <button
            type="button"
            onClick={openSearch}
            aria-label="Search chats"
            title="Search chats"
            className="rounded-md p-1.5 text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
          >
            <Search className="size-4" />
          </button>
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label="Hide sidebar"
            title="Hide sidebar"
            className="rounded-md p-1.5 text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
          >
            <PanelLeftClose className="size-4" />
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
          className="flex w-full items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-transform duration-instant ease-emphasis active:scale-[0.98]"
        >
          <MessageSquarePlus className="size-4" aria-hidden="true" />
          New chat
        </button>

        <button
          type="button"
          onClick={onOpenMarketplace}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
        >
          <Store className="size-4" aria-hidden="true" />
          Marketplace
          <Sparkles className="ml-auto size-3 opacity-60" aria-hidden="true" />
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
          Chats
        </button>

        <div className="relative ml-auto flex items-center gap-0.5">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setOrderMenuOpen((current) => !current);
            }}
            aria-label="Change ordering"
            title="Change ordering"
            className="rounded p-1 text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
          >
            <ArrowDownUp className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={onNewChat}
            aria-label="New chat"
            title="New chat"
            className="rounded p-1 text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
          >
            <MessageSquarePlus className="size-3.5" />
          </button>

          {orderMenuOpen ? (
            <div
              data-tails-part="popover"
              className="animate-scale-in absolute right-0 top-7 z-20 w-40 overflow-hidden py-1"
              onClick={(event) => event.stopPropagation()}
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
                    setOrderMenuOpen(false);
                  }}
                  className={cn(
                    'block w-full px-3 py-1.5 text-left text-xs transition-colors duration-quick hover:bg-accent',
                    ordering === value && 'text-primary',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {chatsExpanded ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {loading ? (
            <div className="space-y-1.5 px-1">
              {[0, 1, 2, 3].map((index) => (
                <div
                  key={index}
                  className="h-9 animate-fade-in rounded-lg bg-muted/50"
                  style={{ animationDelay: `${index * 50}ms` }}
                />
              ))}
            </div>
          ) : null}

          {!loading && visible.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {query ? 'No chats match that.' : 'No conversations yet.'}
            </p>
          ) : null}

          {visible.map((session) => (
            <div key={session.id} className="group/row relative">
              <button
                type="button"
                onClick={() => onSelect(session)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setContextMenu({ session, x: event.clientX, y: event.clientY });
                }}
                className={cn(
                  'block w-full overflow-hidden rounded-lg px-3 py-2 text-left transition-colors duration-quick',
                  session.id === activeSessionId
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
              >
                {/* The title scrolls on hover rather than sitting truncated, so
                    a long name is readable without a tooltip delay. */}
                <span className="block overflow-hidden whitespace-nowrap">
                  <span className="inline-block max-w-full truncate align-bottom text-sm group-hover/row:animate-none group-hover/row:overflow-visible">
                    {session.title}
                  </span>
                </span>
                <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground opacity-0 transition-opacity duration-quick group-hover/row:opacity-100">
                  {session.cwd ? (
                    <span className="truncate font-mono" title={session.cwd}>
                      {readFolderName(session.cwd)}
                    </span>
                  ) : null}
                  <span aria-hidden="true">·</span>
                  <span className="shrink-0">{readRelativeTime(session.updatedAt)}</span>
                </span>
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex-1" />
      )}

      {contextMenu ? (
        <div
          data-tails-part="popover"
          className="animate-scale-in fixed z-50 w-44 overflow-hidden py-1"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              onRename(contextMenu.session);
              setContextMenu(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors duration-quick hover:bg-accent"
          >
            <Pencil className="size-3.5" /> Rename
          </button>
          <button
            type="button"
            disabled
            title="Archiving is not implemented yet"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs opacity-40"
          >
            <Archive className="size-3.5" /> Archive
          </button>
          <button
            type="button"
            onClick={() => {
              onDelete(contextMenu.session);
              setContextMenu(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-destructive transition-colors duration-quick hover:bg-destructive/10"
          >
            <Trash2 className="size-3.5" /> Delete
          </button>
        </div>
      ) : null}

      <div className="border-t border-border p-2">
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
        >
          <Settings className="size-4" aria-hidden="true" />
          Settings
        </button>
      </div>
    </aside>
  );
}
