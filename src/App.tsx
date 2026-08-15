import { useCallback, useEffect, useRef, useState } from 'react';

import { ChatView } from '@/components/chat/ChatView';
import { Intro } from '@/components/intro/Intro';
import { MarketplacePage } from '@/components/marketplace/MarketplacePage';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { Header } from '@/components/shell/Header';
import { Sidebar } from '@/components/sidebar/Sidebar';
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
      // No cwd passed: the server defaults a new conversation to the user's
      // home folder rather than wherever the process happens to be running.
      const session = await api.createSession();
      setSessionId(session.id);
      setSessionTitle(session.title);
      setCwd(session.cwd);
      setView('chat');
      setRefreshToken((current) => current + 1);
    } catch {
      setSessionId(null);
    }
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
      <AppearanceProvider sessionId={sessionId}>
        {showIntro ? <Intro onDone={() => setShowIntro(false)} /> : null}
        <RestylingChip />

        <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
          {!sidebarCollapsed ? (
            <Sidebar
              activeSessionId={sessionId}
              onSelect={openSession}
              onNewChat={() => void startNewChat()}
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenMarketplace={() => setView('marketplace')}
              onToggleCollapsed={() => setSidebarCollapsed(true)}
              onRename={(session) => {
                void openSession(session);
                // The header field is the rename affordance, so selecting the
                // chat and letting them click the title keeps one code path.
              }}
              onDelete={(session) => void deleteSession(session)}
              refreshToken={refreshToken}
            />
          ) : null}

          <main className="flex min-w-0 flex-1 flex-col">
            <Header
              sessionTitle={view === 'marketplace' ? 'Marketplace' : sessionTitle}
              cwd={cwd}
              sidebarCollapsed={sidebarCollapsed}
              terminalOpen={terminalOpen}
              onToggleSidebar={() => setSidebarCollapsed(false)}
              onRenameSession={(title) => void renameSession(title)}
              onChangeCwd={(next) => void changeCwd(next)}
              onToggleTerminal={() => setTerminalOpen((current) => !current)}
            />

            <div className="flex min-h-0 flex-1 flex-col">
              {view === 'marketplace' ? (
                <MarketplacePage />
              ) : (
                <ChatView
                  sessionId={sessionId}
                  cwd={cwd}
                  onFirstMessage={() => setRefreshToken((current) => current + 1)}
                />
              )}

              {terminalOpen ? (
                <TerminalPanel cwd={cwd} onClose={() => setTerminalOpen(false)} />
              ) : null}
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
