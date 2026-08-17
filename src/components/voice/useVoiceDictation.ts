import { useCallback, useEffect, useRef, useState } from 'react';

import type { VoiceMode, VoiceModeState } from '@/components/chat/voice-contract';
import { CAPTURE_PROCESSOR, captureWorkletUrl, TARGET_SAMPLE_RATE } from '@/components/voice/capture-worklet';
import { useWakeWord, type WakeWordArm } from '@/components/voice/useWakeWord';

/**
 * Voice mode: the microphone, the wake words, and the dictation socket.
 *
 * ## One mode, two moments
 *
 * The microphone is either open or closed. When it is open the app is either
 * waiting for a wake word or capturing a sentence. That is the whole state
 * machine, and it is one machine rather than two features sharing a device.
 *
 * ## The microphone is closed when it is off
 *
 * Not muted — **stopped**. A muted track still holds the device open and still
 * lights the operating system's recording indicator, and a user who sees that
 * indicator while the app claims to be idle has learned that the app lies
 * about the microphone. `disable` ends every track and closes the audio
 * context rather than pausing anything.
 *
 * ## Waiting does not stream
 *
 * While armed but not capturing, audio goes only to the local wake-word
 * Worker. The dictation socket is not even open. Nothing is sent anywhere
 * until the user has either said the wake word or pressed the button.
 */

type Options = {
  /** Where a finished transcript goes. Called with cleaned text, never empty. */
  onText: (text: string) => void;
  /** The conversation's folder, used to seed the recogniser's vocabulary. */
  cwd?: string | null;
  /**
   * Wake words to listen for while the microphone is open.
   *
   * Empty — the default — means no Worker is created and none of the 12.9 MB
   * of WASM is ever fetched.
   */
  armed?: WakeWordArm[];
  /**
   * Speech output, folded in so the control is one state machine.
   *
   * Owned by `useSpeech`; passed in rather than created here because the same
   * synthesiser serves pets and replies, and voice mode only needs to know
   * whether it is currently talking.
   */
  speech?: { speaking: boolean; hush: () => void };
};

/** Stable empty default, so callers that never arm do not restart the effect. */
const NONE: WakeWordArm[] = [];

type ServerFrame =
  | { type: 'state'; listening: boolean }
  | { type: 'transcript'; text: string }
  | { type: 'error'; message: string };

type StatusResponse = { ready: boolean; reason?: string };

/**
 * Tells the desktop shell whether the user currently wants the microphone.
 *
 * The main process denies every permission by default and has no way to know a
 * button was pressed, so the grant is conditional on this flag rather than
 * standing. Optional: in a browser build there is no shell, and the browser's
 * own prompt is the right behaviour.
 */
function declareVoiceIntent(wanted: boolean): void {
  const bridge = (window as { tailsDesktop?: { voice?: { setIntent?: (v: boolean) => void } } }).tailsDesktop;
  bridge?.voice?.setIntent?.(wanted);
}

/** How often the input level is published. ~8/s is enough to read as live. */
const LEVEL_INTERVAL_MS = 120;

export function useVoiceDictation({
  onText, cwd, armed = NONE, speech,
}: Options): VoiceModeState {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [reason, setReason] = useState<string | undefined>(undefined);
  const [engaged, setEngaged] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [level, setLevel] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const levelSentAt = useRef(0);

  const onTextRef = useRef(onText);
  useEffect(() => { onTextRef.current = onText; }, [onText]);
  const cwdRef = useRef(cwd);
  useEffect(() => { cwdRef.current = cwd; }, [cwd]);

  const wake = useWakeWord({
    armed,
    // Hearing the wake word is the same event as pressing the button.
    onDetected: () => captureRef.current(),
  });
  const wakeFeedRef = useRef(wake.feed);
  useEffect(() => { wakeFeedRef.current = wake.feed; }, [wake.feed]);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/voice/status')
      .then((res) => res.json() as Promise<StatusResponse>)
      .then((body) => {
        if (cancelled) return;
        setAvailable(body.ready);
        setReason(body.ready ? undefined : body.reason);
      })
      .catch(() => {
        if (cancelled) return;
        setAvailable(false);
        setReason('Could not reach the local speech service');
      });
    return () => { cancelled = true; };
  }, []);

  /** Closes the dictation socket without touching the microphone. */
  const closeSocket = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
  }, []);

  const releaseMicrophone = useCallback(() => {
    declareVoiceIntent(false);
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    void contextRef.current?.close().catch(() => {});
    contextRef.current = null;
    setLevel(0);
  }, []);

  const disable = useCallback(() => {
    closeSocket();
    releaseMicrophone();
    setEngaged(false);
    setCapturing(false);
    setTranscribing(false);
  }, [closeSocket, releaseMicrophone]);

  useEffect(() => disable, [disable]);

  /** Opens the dictation socket and begins sending audio to the recogniser. */
  const capture = useCallback(() => {
    if (socketRef.current || !streamRef.current) return;

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${window.location.host}/voice`);
    socket.binaryType = 'arraybuffer';
    socketRef.current = socket;

    socket.onopen = () => socket.send(JSON.stringify({
      type: 'voice.start', cwd: cwdRef.current ?? undefined,
    }));

    socket.onmessage = (event) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(event.data as string) as ServerFrame;
      } catch {
        return;
      }

      if (frame.type === 'transcript') {
        onTextRef.current(frame.text);
        setTranscribing(false);
        setCapturing(false);
        closeSocket();
        return;
      }
      if (frame.type === 'error') {
        setReason(frame.message);
        setTranscribing(false);
        setCapturing(false);
        closeSocket();
      }
      // A `state` frame only refines the label; the button already knows it is
      // capturing, and letting the server drive that would make the UI lag the
      // user's own press.
    };

    socket.onclose = () => { socketRef.current = null; };
    socket.onerror = () => socket.close();

    setCapturing(true);
  }, [closeSocket]);

  // Held in a ref so the wake-word callback, created once, always calls the
  // current version.
  const captureRef = useRef(capture);
  useEffect(() => { captureRef.current = capture; }, [capture]);

  const endCapture = useCallback(() => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      // An explicit stop must transcribe what was said rather than discard it,
      // so the socket stays open until the transcript comes back.
      socketRef.current.send(JSON.stringify({ type: 'voice.stop' }));
      setTranscribing(true);
    } else {
      closeSocket();
    }
    setCapturing(false);
    wake.reset();
  }, [closeSocket, wake]);

  const enable = useCallback(() => {
    if (streamRef.current) return;

    void (async () => {
      try {
        declareVoiceIntent(true);
        const stream = await navigator.mediaDevices.getUserMedia({
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

        const source = context.createMediaStreamSource(stream);
        const node = new AudioWorkletNode(context, CAPTURE_PROCESSOR, {
          processorOptions: { targetRate: TARGET_SAMPLE_RATE },
        });

        node.port.onmessage = (event: MessageEvent<Int16Array>) => {
          const pcm = event.data;

          // Only while capturing. Waiting for a wake word sends nothing.
          const socket = socketRef.current;
          if (socket?.readyState === WebSocket.OPEN) socket.send(pcm);

          wakeFeedRef.current(pcm);

          const now = performance.now();
          if (now - levelSentAt.current >= LEVEL_INTERVAL_MS) {
            levelSentAt.current = now;
            let sum = 0;
            for (let i = 0; i < pcm.length; i += 1) {
              const v = pcm[i] / 32768;
              sum += v * v;
            }
            // Square-rooted twice, in effect: RMS then a perceptual curve, so
            // ordinary speech fills the meter instead of nudging it.
            setLevel(Math.min(1, Math.sqrt(Math.sqrt(sum / pcm.length)) * 1.4));
          }
        };

        source.connect(node);
        // Deliberately not connected to `context.destination`: routing the
        // microphone to the speakers would feed the room back to itself.

        setEngaged(true);
        // With nothing armed, turning voice mode on means "start dictating" —
        // there is no wake word coming, so waiting would be waiting forever.
        if (armed.length === 0) captureRef.current();
      } catch (error) {
        releaseMicrophone();
        setEngaged(false);
        setAvailable(false);
        setReason(
          error instanceof DOMException && error.name === 'NotAllowedError'
            ? 'Microphone permission was refused'
            : 'Could not open the microphone',
        );
      }
    })();
  }, [armed.length, releaseMicrophone]);

  const hush = useCallback(() => speech?.hush(), [speech]);

  const mode: VoiceMode = available === false ? 'unavailable'
    : speech?.speaking ? 'speaking'
      : transcribing ? 'transcribing'
        : capturing ? 'listening'
          : engaged ? 'waiting'
            : 'off';

  return {
    mode,
    reason,
    armed: armed.map((word) => word.id),
    // Zero unless the microphone is genuinely open, so the meter can never
    // imply a device that is closed.
    level: engaged ? level : 0,
    enable,
    disable,
    capture,
    endCapture,
    hush,
  };
}
