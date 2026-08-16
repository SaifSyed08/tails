import React, { createContext, useContext, useEffect, useRef, useState } from 'react';

import { useWebSocket } from '@/contexts/WebSocketContext';
import { applyFreeformCss, applyTheme, clearTheme, type AppearancePayload } from '@/theme/applyTheme';

/** What the app is doing about its own appearance right now. */
export type AppearancePhase = 'idle' | 'preparing' | 'applying';

type AppearanceApi = {
  phase: AppearancePhase;
  /** Name of the look being applied, for the in-chat affordance. */
  incomingName: string | null;
};

const AppearanceContext = createContext<AppearanceApi>({ phase: 'idle', incomingName: null });

type AppearanceProviderProps = {
  sessionId: string | null;
  children: React.ReactNode;
};

/**
 * Applies theme changes pushed from the server.
 *
 * Two phases, because the point is that the app visibly answers the user
 * rather than silently mutating. `preparing` starts the moment a change is
 * announced and covers font loading; `applying` is the transition itself.
 */
export function AppearanceProvider({ sessionId, children }: AppearanceProviderProps) {
  const { subscribe } = useWebSocket();
  const [phase, setPhase] = useState<AppearancePhase>('idle');
  const [incomingName, setIncomingName] = useState<string | null>(null);

  // Guards against two overlapping transitions, which is the main source of a
  // theme change that feels janky rather than deliberate.
  const applyingRef = useRef(false);
  const queuedRef = useRef<AppearancePayload | null>(null);

  useEffect(() => {
    const run = async (payload: AppearancePayload) => {
      if (applyingRef.current) {
        // Keep only the newest; superseded looks are never worth showing.
        queuedRef.current = payload;
        return;
      }

      applyingRef.current = true;
      setIncomingName(payload.name);
      setPhase('preparing');

      // A beat on `preparing` so the affordance is perceivable even when fonts
      // are already cached; without it the phase flickers past unseen.
      await new Promise((resolve) => setTimeout(resolve, 180));
      setPhase('applying');
      await applyTheme(payload);

      // Canvas-based surfaces cannot read CSS custom properties — xterm
      // measures and paints its own glyphs — so they need telling explicitly
      // that the tokens moved.
      window.dispatchEvent(new CustomEvent('tails:appearance-changed'));

      setPhase('idle');
      setIncomingName(null);
      applyingRef.current = false;

      const queued = queuedRef.current;
      queuedRef.current = null;
      if (queued) void run(queued);
    };

    return subscribe((message) => {
      if (message.kind !== 'appearance_changed') return;

      const payload = message.appearance as (AppearancePayload & {
        layer?: string;
        scope?: string;
        scopeKey?: string;
      }) | undefined;
      if (!payload) return;

      // A conversation-scoped change belongs only to that conversation's
      // window; a global one applies everywhere.
      const isForThisWindow = payload.scope !== 'session'
        || !payload.scopeKey
        || payload.scopeKey === sessionId;
      if (!isForThisWindow) return;

      // The freeform layer sits above the theme and swaps synchronously. It
      // skips the two-phase treatment on purpose: there are no fonts to
      // preload, and a stylesheet the author is iterating on should land the
      // instant it validates rather than after a deliberate 180ms beat.
      if (payload.layer === 'css') {
        applyFreeformCss(payload.css);
        window.dispatchEvent(new CustomEvent('tails:appearance-changed'));
        return;
      }

      if (payload.layer !== 'theme') return;

      void run(payload);
    });
  }, [subscribe, sessionId]);

  // Resolve the persisted look on mount and whenever the conversation changes,
  // so reopening a chat restores the appearance it was given.
  useEffect(() => {
    let cancelled = false;

    void fetch(`/api/appearance/resolve${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((resolved: AppearancePayload | null) => {
        if (cancelled) return;

        // Nothing bound is an answer, not an absence, and returning early here
        // is what made "reset to default" fail to survive a restart. The
        // pre-paint script in index.html has already applied the last cached
        // look from localStorage; if the server then says there is no theme,
        // that cache is stale and has to be cleared. Doing nothing left the app
        // wearing a theme it no longer had, with the element holding it
        // invisible to every layer that resets.
        if (!resolved?.css) {
          clearTheme();
          return;
        }

        void applyTheme(resolved);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return (
    <AppearanceContext.Provider value={{ phase, incomingName }}>
      {children}
    </AppearanceContext.Provider>
  );
}

export function useAppearance(): AppearanceApi {
  return useContext(AppearanceContext);
}
