import { useCallback, useEffect, useRef, useState } from 'react';

import type { VoiceIntent, VoiceMode, VoiceModeState } from '@/components/chat/voice-contract';
import { CAPTURE_PROCESSOR, captureWorkletUrl, TARGET_SAMPLE_RATE } from '@/components/voice/capture-worklet';
import { useWakeWord, type WakeWordArm } from '@/components/voice/useWakeWord';

/**
 * The microphone, the wake words, and the dictation socket.
 *
 * ## One device, two intents
 *
 * The microphone is either open or closed. When it is open, the app is either
 * waiting for a wake word or capturing a sentence. That is the whole state
 * machine — but *why* it was opened decides what happens to the words, and
 * that is carried separately as the intent. See `voice-contract.ts`: dictation
 * fills the box, voice mode sends.
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
  /** Where transcribed text goes. Called with cleaned text, never empty. */
  onText: (text: string) => void;
  /**
   * A spoken turn has finished.
   *
   * Only ever called under the `voice` intent — this is the auto-send, and
   * dictation must never trigger it. Fired after `onText`, so the composer
   * already holds every word before anything is sent.
   */
  onSpokenTurn?: () => void;
  /** A wake word fired. The caller's cue for the sound and the glow. */
  onWake?: (id: string) => void;
  /** The conversation's folder, used to seed the recogniser's vocabulary. */
  cwd?: string | null;
  /**
   * Wake words available to voice mode.
   *
   * Only armed while the intent is `voice`: dictation has no use for them, and
   * an idle Worker holding 12.9 MB of WASM for a mode that is not running is
   * exactly the kind of thing that turns "off" into a lie.
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
  /**
   * A permission request currently being put to the user out loud.
   *
   * Folded in here rather than resolved by the component so the control stays
   * one state machine — the same reason `speech` is passed in. Owned by
   * `useSpokenApproval`, which decides what is being asked and when the
   * microphone should be open for the answer.
   */
  asking?: { prompt: string; awaiting: boolean } | null;
};

/** Stable empty default, so callers that never arm do not restart the effect. */
const NONE: WakeWordArm[] = [];

type ServerFrame =
  | { type: 'state'; listening: boolean }
  /** Settled text, sent while the user is still talking. Never a revision. */
  | { type: 'partial'; text: string }
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
  onText, onSpokenTurn, onWake, cwd, armed = NONE, speech, asking,
}: Options): VoiceModeState {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [reason, setReason] = useState<string | undefined>(undefined);
  const [intent, setIntent] = useState<VoiceIntent>('off');
  const [capturing, setCapturing] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [level, setLevel] = useState(0);
  const [wakeCount, setWakeCount] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const levelSentAt = useRef(0);
  /*
    The intent, readable from callbacks that were created before it changed —
    the worklet's message handler and the socket's, both of which outlive a
    render. Every decision about *what to do with the words* reads this, so it
    is written synchronously in `start` rather than derived from state.
  */
  const intentRef = useRef<VoiceIntent>('off');
  /** True between pressing stop and the socket closing, so the tail is kept. */
  const stoppingRef = useRef(false);

  const onTextRef = useRef(onText);
  useEffect(() => { onTextRef.current = onText; }, [onText]);
  const onSpokenTurnRef = useRef(onSpokenTurn);
  useEffect(() => { onSpokenTurnRef.current = onSpokenTurn; }, [onSpokenTurn]);
  const onWakeRef = useRef(onWake);
  useEffect(() => { onWakeRef.current = onWake; }, [onWake]);
  const cwdRef = useRef(cwd);
  useEffect(() => { cwdRef.current = cwd; }, [cwd]);

  /*
    Forward references. `capture`, the worklet handler and the wake-word
    callback are all created once and then live for the lifetime of the
    microphone, so anything they call has to be reached through a ref or they
    would keep calling the first render's version of it.
  */
  const captureRef = useRef<() => void>(() => {});
  const finishRef = useRef<() => void>(() => {});
  const wakeResetRef = useRef<() => void>(() => {});

  /*
    Armed only under the `voice` intent. `useWakeWord` compares by value, so
    handing it the empty array tears the Worker down and hands back the models'
    memory the moment voice mode ends.
  */
  const wake = useWakeWord({
    armed: intent === 'voice' ? armed : NONE,
    onDetected: (id) => {
      setWakeCount((count) => count + 1);
      onWakeRef.current?.(id);
      captureRef.current();
    },
  });
  const wakeFeedRef = useRef(wake.feed);
  useEffect(() => { wakeFeedRef.current = wake.feed; }, [wake.feed]);
  useEffect(() => { wakeResetRef.current = wake.reset; }, [wake.reset]);
  /*
    Read by the worklet handler to decide whether the wake Worker should see
    this chunk at all. While an utterance is being captured it should not: the
    phrase has already fired, and continuing to score the user's own sentence
    is both wasted work and a way to re-trigger mid-sentence.
  */
  const capturingRef = useRef(false);
  useEffect(() => { capturingRef.current = capturing; }, [capturing]);

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
    intentRef.current = 'off';
    stoppingRef.current = false;
    closeSocket();
    releaseMicrophone();
    setIntent('off');
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
    stoppingRef.current = false;

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

      if (frame.type === 'partial') {
        // Appended exactly like a finished transcript, because by the time it
        // arrives it is finished — the server only sends words that have
        // stopped changing. Capture keeps running.
        onTextRef.current(frame.text);
        return;
      }

      if (frame.type === 'transcript') {
        onTextRef.current(frame.text);
        setTranscribing(false);
        finishRef.current();
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

    /*
      A socket that never opens has to say so.

      This used to be `onerror = () => socket.close()` and nothing else, so a
      handshake that failed left the microphone open, the level meter moving,
      the button lit, and no text — ever, with no error anywhere. That is how a
      missing line in the dev proxy turned into "dictation prints nothing"
      rather than into "dictation could not connect".

      Keyed on whether the socket ever reached OPEN, because a close during
      capture is normal — it is how every utterance ends.
    */
    let opened = false;
    socket.addEventListener('open', () => { opened = true; });

    const failed = () => {
      socketRef.current = null;
      setCapturing(false);
      setTranscribing(false);
      setReason('Could not reach the local speech service — the /voice socket did not connect.');
    };

    socket.onclose = () => {
      socketRef.current = null;
      if (!opened) failed();
    };
    socket.onerror = () => {
      if (!opened) failed();
      socket.close();
    };

    setCapturing(true);
  }, [closeSocket]);

  /**
   * What happens after one utterance has been transcribed.
   *
   * The three cases are genuinely different, which is why this is not a single
   * `close and stop`:
   *
   * - **Stopping.** The user pressed the button. Everything shuts down.
   * - **Voice mode.** Send it, then go back to waiting for the wake word.
   *   The socket closes because the next utterance needs a fresh one.
   * - **Dictation.** Keep going. Someone dictating a paragraph pauses between
   *   sentences, and closing the microphone at the first full stop would make
   *   them press the button again for every one of them. The server has
   *   already reset its own buffer, so the same socket carries the next
   *   sentence.
   */
  const finishUtterance = useCallback(() => {
    if (stoppingRef.current) {
      stoppingRef.current = false;
      setCapturing(false);
      closeSocket();
      releaseMicrophone();
      intentRef.current = 'off';
      setIntent('off');
      return;
    }

    if (intentRef.current === 'voice') {
      setCapturing(false);
      closeSocket();
      // Clears the embedding window so the wake word is heard afresh rather
      // than re-fired off the tail of what was just said.
      wakeResetRef.current();
      onSpokenTurnRef.current?.();
      return;
    }

    // Dictation: the socket stays open and capture continues.
  }, [closeSocket, releaseMicrophone]);

  useEffect(() => { captureRef.current = capture; }, [capture]);
  useEffect(() => { finishRef.current = finishUtterance; }, [finishUtterance]);

  const endCapture = useCallback(() => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      // An explicit stop must transcribe what was said rather than discard it,
      // so the socket stays open until the transcript comes back — and
      // `stoppingRef` is what tells `finishUtterance` that this is the last one.
      stoppingRef.current = true;
      socketRef.current.send(JSON.stringify({ type: 'voice.stop' }));
      setTranscribing(true);
      setCapturing(false);
      return;
    }
    disable();
  }, [disable]);

  const start = useCallback((next: 'dictation' | 'voice') => {
    // Already open under a different intent: switch rather than stack a second
    // microphone on top of the first.
    if (streamRef.current) {
      intentRef.current = next;
      setIntent(next);
      if (next === 'dictation' && !socketRef.current) captureRef.current();
      return;
    }

    intentRef.current = next;
    setIntent(next);

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

          // And only while *not* capturing: the phrase has already fired.
          if (!capturingRef.current) wakeFeedRef.current(pcm);

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

        /*
          Dictation captures at once — there is no wake word coming, so waiting
          would be waiting forever, and that exact case is what made the
          microphone button appear to do nothing. Voice mode waits, unless
          nothing is armed, in which case it has nothing to wait for either.
        */
        if (next === 'dictation' || armed.length === 0) captureRef.current();
      } catch (error) {
        releaseMicrophone();
        intentRef.current = 'off';
        setIntent('off');
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

  /*
    `asking` outranks everything but an unusable microphone, because it is the
    one state where the words being captured are not a message. Below it the
    order is unchanged, and it is still the consequence that decides: speaking
    over listening because the user cannot answer what is still being said.
  */
  const mode: VoiceMode = available === false ? 'unavailable'
    : asking ? 'asking'
      : speech?.speaking ? 'speaking'
        : transcribing ? 'transcribing'
          : capturing ? 'listening'
            : intent !== 'off' ? 'waiting'
              : 'off';

  return {
    intent,
    mode,
    reason,
    // Only while voice mode is on: a wake-word failure is not an error to
    // report at someone who is dictating.
    wakeReason: intent === 'voice' ? wake.error : undefined,
    armed: armed.map((word) => word.id),
    armedLabels: armed.map((word) => word.label),
    // Zero unless the microphone is genuinely open, so the meter can never
    // imply a device that is closed.
    level: intent !== 'off' ? level : 0,
    wakeCount,
    ...(asking ? { asking } : {}),
    start,
    disable,
    capture,
    endCapture,
    hush,
  };
}
