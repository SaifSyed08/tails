import { MessageSquarePlus, Search, Settings } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { api, type SessionListItem } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Stagger } from '@/shared/ui/Motion';

type SidebarProps = {
  activeSessionId: string | null;
  onSelect: (session: SessionListItem) => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
  /** Bumped by the parent after a send so a new conversation appears. */
  refreshToken: number;
};

/** Groups a timestamp into a human bucket for the list headers. */
function readDayBucket(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  if (date.getTime() >= startOfToday) return 'Today';
  if (date.getTime() >= startOfToday - dayMs) return 'Yesterday';
  if (date.getTime() >= startOfToday - 7 * dayMs) return 'This week';
  return 'Earlier';
}

export function Sidebar({
  activeSessionId,
  onSelect,
  onNewChat,
  onOpenSettings,
  refreshToken,
}: SidebarProps) {
  const [query, setQuery] = useState('');
  // `loadedToken` records which refresh this data answers, so loading is
  // derived rather than a second state written from inside the effect.
  const [loaded, setLoaded] = useState<{ items: SessionListItem[]; token: number | null }>({
    items: [],
    token: null,
  });

  const sessions = loaded.items;
  const loading = loaded.token !== refreshToken;

  useEffect(() => {
    let cancelled = false;

    void api.listSessions(100)
      .then((items) => {
        if (!cancelled) setLoaded({ items, token: refreshToken });
      })
      .catch(() => {
        // An empty list is the honest result of a failed read here; the chat
        // itself still works without history.
        if (!cancelled) setLoaded({ items: [], token: refreshToken });
      });

    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  // Title filtering only, for now. Full-text search across transcripts is the
  // next step and needs a streaming endpoint rather than this list.
  const grouped = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? sessions.filter((session) => session.title.toLowerCase().includes(needle))
      : sessions;

    const buckets = new Map<string, SessionListItem[]>();
    for (const session of filtered) {
      const bucket = readDayBucket(session.updatedAt);
      const list = buckets.get(bucket) ?? [];
      list.push(session);
      buckets.set(bucket, list);
    }
    return [...buckets.entries()];
  }, [sessions, query]);

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-border bg-card/40">
      <div className="space-y-3 p-3">
        <button
          type="button"
          onClick={onNewChat}
          className="flex w-full items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-transform duration-instant ease-emphasis active:scale-[0.98]"
        >
          <MessageSquarePlus className="size-4" aria-hidden="true" />
          New chat
        </button>

        <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5 transition-shadow duration-quick focus-within:ring-2 focus-within:ring-ring">
          <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search chats"
            aria-label="Search conversations"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

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

        {!loading && grouped.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            {query ? 'No chats match that.' : 'No conversations yet.'}
          </p>
        ) : null}

        {grouped.map(([bucket, items]) => (
          <div key={bucket} className="mb-3">
            <p className="px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {bucket}
            </p>
            <Stagger variant="fade" className="space-y-0.5">
              {items.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => onSelect(session)}
                  title={session.title}
                  className={cn(
                    'block w-full truncate rounded-lg px-3 py-2 text-left text-sm transition-colors duration-quick',
                    session.id === activeSessionId
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                  )}
                >
                  {session.title}
                </button>
              ))}
            </Stagger>
          </div>
        ))}
      </div>

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
