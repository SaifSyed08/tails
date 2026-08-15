import { useCallback, useEffect, useRef, useState } from 'react';

import { ChatView } from '@/components/chat/ChatView';
import { Intro } from '@/components/intro/Intro';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { Sidebar } from '@/components/sidebar/Sidebar';
import { AppearanceProvider, useAppearance } from '@/contexts/AppearanceContext';
import { WebSocketProvider } from '@/contexts/WebSocketContext';
import { api, type SessionListItem } from '@/lib/api';

/**
 * The "the app is restyling itself" affordance.
 *
 * Shown during `preparing`, which is the gap between the agent deciding on a
 * look and the transition running. A spinner would say "wait"; this says
 * "watch".
 */
function RestylingChip() {
  const { phase, incomingName } = useAppearance();
  if (phase === 'idle') return null;

  return (
    <div className="pointer-events-none fixed left-1/2 top-4 z-40 -translate-x-1/2">
      <div className="animate-rise-in flex items-center gap-2 rounded-full border border-border bg-card/90 px-3 py-1.5 text-xs shadow-lg backdrop-blur">
        <span className="size-1.5 animate-pulse rounded-full bg-primary" />
        Restyling{incomingName ? ` — ${incomingName}` : ''}
      </div>
    </div>
  );
}

/** Whether the intro has been disabled in settings. */
const INTRO_DISABLED_KEY = 'tails.introDisabled';

export default function App() {
  const [showIntro, setShowIntro] = useState(
    () => localStorage.getItem(INTRO_DISABLED_KEY) !== '1',
  );
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string>('');
  const [refreshToken, setRefreshToken] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);

  /**
   * Starts a new conversation.
   *
   * The id is minted here, before anything is sent, so the conversation has a
   * stable identity from the first keystroke and the send path never has to
   * hand one id off to another.
   */
  const startNewChat = useCallback(async () => {
    try {
      const session = await api.createSession({ cwd: cwd || undefined });
      setSessionId(session.id);
      setCwd(session.cwd);
      setRefreshToken((current) => current + 1);
    } catch {
      // Falling back to a null session leaves the composer usable; the send
      // path will create the row on first message.
      setSessionId(null);
    }
  }, [cwd]);

  // Without a session the composer would accept text and silently drop it, so
  // one is allocated up front. Guarded against React 18 double-invoke in dev,
  // which would otherwise create two empty conversations on every boot.
  const bootstrappedRef = useRef(false);
  useEffect(() => {
    if (bootstrappedRef.current || sessionId) return;
    bootstrappedRef.current = true;
    void startNewChat();
  }, [sessionId, startNewChat]);

  const openSession = useCallback(async (session: SessionListItem) => {
    // A conversation Claude Code created elsewhere is adopted on first open so
    // it gains an app row and can be resumed like any other.
    if (session.external) {
      try {
        const adopted = await api.adoptSession(session.id, {
          cwd: session.cwd,
          title: session.title,
        });
        setSessionId(adopted.id);
        setCwd(adopted.cwd);
        setRefreshToken((current) => current + 1);
        return;
      } catch {
        // Fall through and open it read-only rather than blocking the click.
      }
    }
    setSessionId(session.id);
    setCwd(session.cwd);
  }, []);

  return (
    <WebSocketProvider>
      <AppearanceProvider sessionId={sessionId}>
      {showIntro ? <Intro onDone={() => setShowIntro(false)} /> : null}
      <RestylingChip />

      <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
        <Sidebar
          activeSessionId={sessionId}
          onSelect={openSession}
          onNewChat={() => void startNewChat()}
          onOpenSettings={() => setSettingsOpen(true)}
          refreshToken={refreshToken}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
            <span className="font-display text-sm font-semibold tracking-[0.15em]">
              T.A.I.L.S.
            </span>
            {cwd ? (
              <span className="truncate font-mono text-xs text-muted-foreground" title={cwd}>
                {cwd}
              </span>
            ) : null}
          </header>

          <ChatView
            sessionId={sessionId}
            cwd={cwd}
            onFirstMessage={() => setRefreshToken((current) => current + 1)}
          />
        </main>
      </div>

      {settingsOpen ? (
        <SettingsPanel sessionId={sessionId} onClose={() => setSettingsOpen(false)} />
      ) : null}
      </AppearanceProvider>
    </WebSocketProvider>
  );
}
