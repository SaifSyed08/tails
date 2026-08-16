import { useCallback, useEffect, useRef, useState } from 'react';

import type { VoiceDictation, VoiceStatus } from '@/components/chat/voice-contract';
import { CAPTURE_PROCESSOR, captureWorkletUrl, TARGET_SAMPLE_RATE } from '@/components/voice/capture-worklet';

/**
 * The capture path, behind the composer's microphone button.
 *
 * Owns the whole lifecycle: whether dictation can run at all, the microphone
 * itself, the worklet that resamples it, and the socket that carries audio to
 * the local server. Transcribed text does not come back through the returned
 * state — it goes to `onText`, so it can be appended to a draft the user may
 * have already started typing.
 *
 * ## The microphone is closed when it is off
 *
 * Not muted — **stopped**. A muted track still holds the device open and still
 * lights the operating system's recording indicator, and a user who sees that
 * indicator while the app claims to be idle has learned that the app lies about
 * the microphone. That is the one thing this feature cannot afford, so `stop`
 * ends every track and closes the audio context rather than pausing anything.
 */

type Options = {
  /** Where a finished transcript goes. Called with cleaned text, never empty. */
  onText: (text: string) => void;
  /** The conversation's folder, used to seed the recogniser's vocabulary. */
  cwd?: string | null;
};

type ServerFrame =
  | { type: 'state'; listening: boolean }
  | { type: 'transcript'; text: string }
  | { type: 'error'; message: string };

type StatusResponse = { ready: boolean; reason?: string };

/**
 * Tells the desktop shell whether the user currently wants the microphone.
 *
 * The main process denies every permission by default, and it has no way to
 * know that a button was pressed in the renderer — so the grant is conditional
 * on this flag rather than standing. It is deliberately narrow: raised
 * immediately before `getUserMedia` and lowered the moment capture ends, so the
 * window in which `media` is grantable is the window in which the user is
 * actually dictating.
 *
 * Optional on purpose. In a browser build there is no shell and no bridge, and
 * the browser's own permission prompt is the right behaviour.
 */
function declareVoiceIntent(wanted: boolean): void {
  const bridge = (window as { tailsDesktop?: { voice?: { setIntent?: (v: boolean) => void } } }).tailsDesktop;
  bridge?.voice?.setIntent?.(wanted);
}

export function useVoiceDictation({ onText, cwd }: Options): VoiceDictation {
  const [status, setStatus] = useState<VoiceStatus>('unavailable');
  const [reason, setReason] = useState<string | undefined>('Checking for the speech model…');

  const socketRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  // Held in a ref so the socket handler never depends on a changing callback
  // identity — otherwise every render would want to rebuild the connection,
  // and an unmount could be left unable to tear the microphone down.
  const onTextRef = useRef(onText);
  useEffect(() => { onTextRef.current = onText; }, [onText]);

  /**
   * Releases the device and everything attached to it.
   *
   * Written to be safe to call twice, and from an unmount, because every error
   * path in `start` funnels through it — a failure between opening the stream
   * and opening the socket must not leave the microphone live.
   */
  const teardown = useCallback(() => {
    declareVoiceIntent(false);
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;

    void contextRef.current?.close().catch(() => {});
    contextRef.current = null;

    socketRef.current?.close();
    socketRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;

    // The button stays disabled until the server confirms both the engine and
    // the model are present, which is what makes it impossible for pressing it
    // to trigger the download implicitly.
    void fetch('/api/voice/status')
      .then((res) => res.json() as Promise<StatusResponse>)
      .then((body) => {
        if (cancelled) return;
        setStatus(body.ready ? 'idle' : 'unavailable');
        setReason(body.ready ? undefined : body.reason);
      })
      .catch(() => {
        if (cancelled) return;
        setStatus('unavailable');
        setReason('Could not reach the local speech service');
      });

    return () => { cancelled = true; };
  }, []);

  useEffect(() => teardown, [teardown]);

  const stop = useCallback(() => {
    // Tell the server before dropping the socket: an explicit stop should
    // transcribe what was said rather than discarding it, and a closed socket
    // has nowhere to deliver the result.
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'voice.stop' }));
      setStatus('transcribing');
    } else {
      setStatus('idle');
    }

    declareVoiceIntent(false);
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    void contextRef.current?.close().catch(() => {});
    contextRef.current = null;
  }, []);

  const start = useCallback(() => {
    let stream: MediaStream | null = null;

    void (async () => {
      try {
        // Raised immediately before the request and lowered by `teardown` on
        // every path out of here, including failure.
        declareVoiceIntent(true);
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        streamRef.current = stream;

        const context = new AudioContext();
        contextRef.current = context;
        await context.audioWorklet.addModule(captureWorkletUrl());

        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const socket = new WebSocket(`${protocol}://${window.location.host}/voice`);
        socket.binaryType = 'arraybuffer';
        socketRef.current = socket;

        socket.onopen = () => socket.send(JSON.stringify({ type: 'voice.start', cwd: cwd ?? undefined }));

        socket.onmessage = (event) => {
          let frame: ServerFrame;
          try {
            frame = JSON.parse(event.data as string) as ServerFrame;
          } catch {
            return;
          }

          if (frame.type === 'transcript') {
            onTextRef.current(frame.text);
            setStatus('idle');
            return;
          }
          if (frame.type === 'error') {
            setReason(frame.message);
            setStatus('unavailable');
            teardown();
            return;
          }
          // A gate transition only refines the label while capture is live; it
          // must not drag the state back out of `transcribing`.
          setStatus((current) => (current === 'listening' || current === 'idle'
            ? (frame.listening ? 'listening' : current)
            : current));
        };

        socket.onclose = () => { socketRef.current = null; };
        socket.onerror = () => socket.close();

        const source = context.createMediaStreamSource(stream);
        const node = new AudioWorkletNode(context, CAPTURE_PROCESSOR, {
          processorOptions: { targetRate: TARGET_SAMPLE_RATE },
        });
        node.port.onmessage = (event: MessageEvent<Int16Array>) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(event.data);
        };
        source.connect(node);
        // Not connected to `context.destination` on purpose: routing the
        // microphone to the speakers would feed the room back to itself.

        setStatus('listening');
      } catch (error) {
        teardown();
        setStatus('unavailable');
        setReason(
          error instanceof DOMException && error.name === 'NotAllowedError'
            ? 'Microphone permission was refused'
            : 'Could not open the microphone',
        );
      }
    })();
  }, [cwd, teardown]);

  return { status, reason, start, stop };
}
