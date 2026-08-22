import { useCallback, useEffect, useRef, useState } from 'react';

import { AppearancePanel } from '@/components/appearance/AppearancePanel';
import { ChatView } from '@/components/chat/ChatView';
import { ChatPet } from '@/components/petstage/ChatPet';
import { PreviewPane } from '@/components/preview/PreviewPane';
import { SurfacePane } from '@/components/surface/SurfacePane';
import { Intro } from '@/components/intro/Intro';
import { MarketplacePage } from '@/components/marketplace/MarketplacePage';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { ClaudeCliNotice } from '@/components/shell/ClaudeCliNotice';
import { Header } from '@/components/shell/Header';
import { Sidebar } from '@/components/sidebar/Sidebar';
import { UnreadWatcher } from '@/components/sidebar/unread';
import { TerminalPanel } from '@/components/terminal/TerminalPanel';
import { AppearanceProvider, useAppearance } from '@/contexts/AppearanceContext';
import { WebSocketProvider } from '@/contexts/WebSocketContext';
import { api, type SessionListItem } from '@/lib/api';

const INTRO_DISABLED_KEY = 'tails.introDisabled';

/**
 * The "the app is restyling itself" affordance.
 *
 * Shown during `preparing`, the gap between the agent settling on a look and
 * the transition running. A spinner would say "wait"; this says "watch".
 */
function RestylingChip() {
  const { phase, incomingName } = useAppearance();
  if (phase === 'idle') return null;

  return (
    <div className="pointer-events-none fixed left-1/2 top-14 z-40 -translate-x-1/2">
      <div className="animate-rise-in flex items-center gap-2 rounded-full border border-border bg-card/90 px-3 py-1.5 text-xs shadow-lg">
        <span className="size-1.5 animate-pulse rounded-full bg-primary" />
        Restyling{incomingName ? ` — ${incomingName}` : ''}
      </div>
    </div>
  );
}

export default function App() {
  const [showIntro, setShowIntro] = useState(
    () => localStorage.getItem(INTRO_DISABLED_KEY) !== '1',
  );
  const [sessionId, setSessionId] = useState<string | null>(null);

  const [sessionTitle, setSessionTitle] = useState('New chat');
  const [cwd, setCwd] = useState<string>('');
  const [refreshToken, setRefreshToken] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [view, setView] = useState<'chat' | 'marketplace'>('chat');

  const startNewChat = useCallback(async () => {
    try {
      // A draft, not a row. Nothing is written until the first message, which
      // is what stops every launch and every "New chat" click from leaving an
      // empty conversation in the sidebar. The server still mints the id and
      // the default folder so both sides agree on them.
      const session = await api.draftSession();
      setSessionId(session.id);
      setSessionTitle(session.title);
      setCwd(session.cwd);
      setView('chat');
    } catch {
      setSessionId(null);
    }
  }, []);

  /*
    The shortcut every desktop app has for this, so the answer to "where are the
    settings" can be muscle memory rather than a search. Ctrl+, on Windows and
    Linux, Cmd+, on macOS; it toggles, because a shortcut that only opens leaves
    you reaching for the mouse to close what you just opened.

    Not registered in the main process like the panic key: this one is ordinary,
    and a page that has focus in a text field should still get it — `,` with a
    modifier is not something a composer needs.
  */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== ',' || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      event.preventDefault();
      setSettingsOpen((current) => !current);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const bootstrappedRef = useRef(false);
  useEffect(() => {
    if (bootstrappedRef.current || sessionId) return;
    bootstrappedRef.current = true;
    void startNewChat();
  }, [sessionId, startNewChat]);

  const openSession = useCallback(async (session: SessionListItem) => {
    setView('chat');
    if (session.external) {
      try {
        const adopted = await api.adoptSession(session.id, {
          cwd: session.cwd,
          title: session.title,
          // Preserve real last-activity so opening an old chat does not
          // reorder the sidebar.
          lastActivityAt: session.updatedAt,
        });
        setSessionId(adopted.id);
        setSessionTitle(adopted.title);
        setCwd(adopted.cwd);
        setRefreshToken((current) => current + 1);
        return;
      } catch {
        // Fall through and open it as-is rather than blocking the click.
      }
    }
    setSessionId(session.id);
    setSessionTitle(session.title);
    setCwd(session.cwd);
  }, []);

  const renameSession = useCallback(async (title: string) => {
    if (!sessionId) return;
    setSessionTitle(title);
    try {
      await api.renameSession(sessionId, title);
      setRefreshToken((current) => current + 1);
    } catch {
      // Keep the optimistic name; the next list refresh corrects it.
    }
  }, [sessionId]);

  const changeCwd = useCallback(async (next: string) => {
    if (!sessionId) return;
    try {
      const updated = await api.setSessionCwd(sessionId, next);
      setCwd(updated.cwd);
      setRefreshToken((current) => current + 1);
    } catch {
      // A bad path leaves the previous folder in place, which is the safe
      // outcome — the agent keeps running where it was.
    }
  }, [sessionId]);

  const deleteSession = useCallback(async (session: SessionListItem) => {
    try {
      await api.deleteSession(session.id);
      setRefreshToken((current) => current + 1);
      if (session.id === sessionId) void startNewChat();
    } catch {
      // Nothing to recover: the list refresh will show it is still there.
    }
  }, [sessionId, startNewChat]);

  return (
    <WebSocketProvider>
      {/*
        The unread dots. Inside the provider because it subscribes, and mounted
        here rather than in the sidebar because a turn finishing while the
        marketplace or settings is open is exactly the case the dot exists for.
      */}
      <UnreadWatcher sessionId={sessionId} />
      <AppearanceProvider sessionId={sessionId}>
        {showIntro ? <Intro onDone={() => setShowIntro(false)} /> : null}
        <RestylingChip />
        {/* Renders nothing unless the Claude Code CLI is missing, which is the
            one condition under which the rest of this UI works and cannot
            answer. Mounted here rather than in the chat view so it is asked
            once per launch instead of once per conversation. */}
        <ClaudeCliNotice />
        {/* Renders nothing until the appearance actually changes, then carries
            the agent's published controls plus save / undo / reset. */}
        <AppearancePanel sessionId={sessionId} />

        <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
          {!sidebarCollapsed ? (
            <Sidebar
              activeSessionId={sessionId}
              onSelect={openSession}
              onNewChat={() => void startNewChat()}
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenMarketplace={() => setView('marketplace')}
              onToggleCollapsed={() => setSidebarCollapsed(true)}
              onRenamed={(renamedId, title) => {
                // The sidebar owns the rename; this only keeps the header's
                // copy of the name honest when it is the open conversation.
                if (renamedId === sessionId) setSessionTitle(title);
              }}
              onDelete={(session) => void deleteSession(session)}
              refreshToken={refreshToken}
            />
          ) : null}

          <main className="flex min-w-0 flex-1 flex-col">
            <Header
              sessionId={sessionId}
              sessionTitle={view === 'marketplace' ? 'Marketplace' : sessionTitle}
              cwd={cwd}
              sidebarCollapsed={sidebarCollapsed}
              terminalOpen={terminalOpen}
              onToggleSidebar={() => setSidebarCollapsed(false)}
              onRenameSession={(title) => void renameSession(title)}
              onChangeCwd={(next) => void changeCwd(next)}
              onToggleTerminal={() => setTerminalOpen((current) => !current)}
            />

            <div className="flex min-h-0 flex-1 flex-row">
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {view === 'marketplace' ? (
                <MarketplacePage />
              ) : (
                <ChatView
                  sessionId={sessionId}
                  cwd={cwd}
                  onFirstMessage={() => setRefreshToken((current) => current + 1)}
                />
              )}

              {/* Portalled into the chat view's overlay layer rather than
                  rendered by it: an assigned pet is the pet feature's business,
                  and the chat view only publishes the boxes it needs. */}
              <ChatPet sessionId={view === 'chat' ? sessionId : null} />

                {terminalOpen ? (
                  <TerminalPanel cwd={cwd} onClose={() => setTerminalOpen(false)} />
                ) : null}
              </div>

              {/*
                The preview, beside the conversation rather than over it.

                A sibling of the chat column so the two share the width instead
                of one covering the other — the whole point is seeing the thing
                and the conversation that produced it at the same time. It
                renders nothing until a tool opens it, so it costs no layout
                when unused.
              */}
              <PreviewPane sessionId={sessionId} />

              {/*
                The generated panel, beside the conversation for the same reason
                the preview is. Both can be open at once: one is a page the agent
                started and the other is a panel it composed, and a run that
                produces both should not have to choose which the user sees.
              */}
              <SurfacePane key={sessionId ?? 'no-session'} sessionId={sessionId} />
            </div>
          </main>
        </div>

        {settingsOpen ? (
          <SettingsPanel sessionId={sessionId} onClose={() => setSettingsOpen(false)} />
        ) : null}
      </AppearanceProvider>
    </WebSocketProvider>
  );
}
