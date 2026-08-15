import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

import type { NormalizedMessage } from '@/types/chat';

type Listener = (message: NormalizedMessage) => void;

type WebSocketApi = {
  connected: boolean;
  send: (payload: unknown) => void;
  subscribe: (listener: Listener) => () => void;
};

const WebSocketContext = createContext<WebSocketApi | null>(null);

/** Delay before a dropped socket retries. */
const RECONNECT_DELAY_MS = 2000;

/**
 * Owns the single chat websocket.
 *
 * Listeners are held in a ref and dispatched synchronously on message, rather
 * than being pushed through React state. At token-streaming rates a state
 * update per frame would re-render the tree hundreds of times a second; the
 * consumers batch on their own schedule instead.
 */
export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const socketRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef(new Set<Listener>());
  const reconnectRef = useRef<number | undefined>(undefined);
  const closedByUnmountRef = useRef(false);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    closedByUnmountRef.current = false;

    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
      socketRef.current = socket;

      socket.onopen = () => setConnected(true);

      socket.onmessage = (event) => {
        let message: NormalizedMessage;
        try {
          message = JSON.parse(event.data as string) as NormalizedMessage;
        } catch {
          return;
        }
        for (const listener of listenersRef.current) listener(message);
      };

      socket.onclose = () => {
        setConnected(false);
        if (closedByUnmountRef.current) return;
        reconnectRef.current = window.setTimeout(connect, RECONNECT_DELAY_MS);
      };

      socket.onerror = () => socket.close();
    };

    connect();

    return () => {
      closedByUnmountRef.current = true;
      if (reconnectRef.current) window.clearTimeout(reconnectRef.current);
      socketRef.current?.close();
    };
  }, []);

  const send = useCallback((payload: unknown) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }, []);

  const subscribe = useCallback((listener: Listener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  return (
    <WebSocketContext.Provider value={{ connected, send, subscribe }}>
      {children}
    </WebSocketContext.Provider>
  );
}

export function useWebSocket(): WebSocketApi {
  const context = useContext(WebSocketContext);
  if (!context) throw new Error('useWebSocket must be used inside a WebSocketProvider');
  return context;
}
