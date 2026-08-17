import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Arms wake-word listening, and tears it down completely when disarmed.
 *
 * The Worker is created when a word is armed and terminated when none is —
 * there is no dormant instance holding 12.9 MB of WASM and three models in
 * memory for a feature that is switched off. That also means the WASM payload
 * is only ever fetched by someone who turned this on: Vite emits the worker
 * and its assets as their own chunk, and nothing references them until the
 * `new Worker(...)` below runs.
 */

export type WakeWordArm = {
  id: string;
  file: string;
  /** How the phrase is written for a person — "Hey Jarvis", not `hey_jarvis`. */
  label: string;
  threshold: number;
};

export type WakeWordState = {
  /** True once the models are loaded and audio is being scored. */
  listening: boolean;
  error?: string;
};

type WorkerMessage =
  | { type: 'ready' }
  | { type: 'detected'; id: string }
  | { type: 'error'; message: string };

type Options = {
  /** Words to listen for. An empty list means the Worker is not created at all. */
  armed: WakeWordArm[];
  /** Called with the word's id when it fires. */
  onDetected: (id: string) => void;
};

export function useWakeWord({ armed, onDetected }: Options): WakeWordState & {
  /** Feeds one 80 ms chunk of 16 kHz mono PCM. Cheap no-op when disarmed. */
  feed: (pcm: Int16Array) => void;
  reset: () => void;
} {
  /*
    Only the Worker's own messages move this. Whether we are *listening* is
    derived below rather than stored, because "no words armed" is already
    expressed by `armed` — mirroring it into state would mean writing state
    from an effect body to keep two copies of one fact agreeing.
  */
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const workerRef = useRef<Worker | null>(null);

  const onDetectedRef = useRef(onDetected);
  useEffect(() => { onDetectedRef.current = onDetected; }, [onDetected]);

  // Compared by value: `armed` is rebuilt on every render by most callers, and
  // keying the effect on the array identity would restart the Worker — and
  // re-download the models — on each one.
  const signature = armed.map((word) => `${word.id}:${word.threshold}`).join(',');

  useEffect(() => {
    if (armed.length === 0) return undefined;

    let cancelled = false;
    const worker = new Worker(new URL('./wake-worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      if (cancelled) return;
      const message = event.data;
      if (message.type === 'ready') { setReady(true); setError(undefined); }
      else if (message.type === 'detected') onDetectedRef.current(message.id);
      else { setError(message.message); setReady(false); }
    };

    worker.onerror = () => {
      if (!cancelled) { setError('Wake word could not start'); setReady(false); }
    };

    worker.postMessage({
      type: 'init',
      base: '/api/voice/wake/model/',
      words: armed.map((word) => ({ id: word.id, file: word.file, threshold: word.threshold })),
    });

    return () => {
      cancelled = true;
      // Terminate rather than idle it: this is a permanently-open microphone's
      // consumer, and "off" has to mean the work is not happening.
      worker.terminate();
      workerRef.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const feed = useCallback((pcm: Int16Array) => {
    const worker = workerRef.current;
    if (!worker) return;
    // Copied before transfer: the caller owns its buffer and will keep using
    // it, and transferring would detach it underneath them.
    const copy = pcm.slice();
    worker.postMessage({ type: 'audio', pcm: copy }, [copy.buffer]);
  }, []);

  const reset = useCallback(() => {
    workerRef.current?.postMessage({ type: 'reset' });
  }, []);

  return { listening: armed.length > 0 && ready, error, feed, reset };
}
