import { AlertTriangle, Download, Loader2, Mic, Volume2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { cn } from '@/lib/utils';
import {
  formatBytes,
  readArmed,
  readSensitivity,
  voiceApi,
  writeArmed,
  writeSensitivity,
  type DictationStatus,
  type WakeStatus,
  type WakeWordEntry,
} from '@/components/voice/voice-api';
import {
  downloadPiperVoice,
  readPiperStatus,
  type PiperStatus,
} from '@/components/voice/piper-client';

/**
 * Everything about voice that belongs in Settings.
 *
 * Self-contained so the settings panel mounts it with one line, and so this
 * module owns its own copy — the licence wording in particular is a claim
 * about what may be redistributed, and it should live next to the code that
 * knows why rather than in a general settings file.
 *
 * The rule this screen exists to honour: **nothing downloads implicitly.**
 * Every model is a button with its size on it, pressed by the person who wants
 * it. A toggle whose model is missing offers the download instead of quietly
 * starting one.
 */

function Row({ title, detail, children }: {
  title: string;
  detail?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="text-sm">{title}</div>
        {detail ? <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function ActionButton({ busy, onClick, children }: {
  busy: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs',
        'hover:bg-muted disabled:opacity-60',
      )}
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
      {children}
    </button>
  );
}

function WakeWordRow({ word, armed, sensitivity, range, busy, onDownload, onToggle, onSensitivity }: {
  word: WakeWordEntry;
  armed: boolean;
  sensitivity: number;
  range: { min: number; max: number };
  busy: boolean;
  onDownload: () => void;
  onToggle: (next: boolean) => void;
  onSensitivity: (value: number) => void;
}) {
  return (
    <div className="border-t border-border/60 py-3 first:border-t-0">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm">
            {word.label}
            {word.belowPhraseFloor ? (
              <span
                className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-amber-500"
                /* Stated where the choice is made, not buried in a doc: this
                   phrase is short enough that near-rhymes reach it. */
                title="A short phrase — more likely to trigger by accident. Raise the sensitivity if it fires on its own."
              >
                <AlertTriangle className="size-3" aria-hidden="true" />
                short phrase
              </span>
            ) : null}
          </div>
          {word.nonCommercial ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Community model, licensed CC&#8209;BY&#8209;NC&#8209;SA — free for personal use, not
              redistributed with the app. Downloaded only if you ask for it.
            </p>
          ) : null}
        </div>

        {word.installed ? (
          <label className="flex shrink-0 items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={armed}
              onChange={(event) => onToggle(event.target.checked)}
              className="size-4 accent-current"
            />
            {armed ? 'Listening' : 'Off'}
          </label>
        ) : (
          <ActionButton busy={busy} onClick={onDownload}>
            {formatBytes(word.downloadBytes) || 'Download'}
          </ActionButton>
        )}
      </div>

      {word.installed && armed ? (
        <label className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
          <span className="w-20 shrink-0">Sensitivity</span>
          <input
            type="range"
            min={range.min}
            max={range.max}
            step={0.01}
            value={sensitivity}
            onChange={(event) => onSensitivity(Number(event.target.value))}
            className="w-full accent-current"
          />
          {/* Higher threshold means fewer accidental triggers, so the label is
              inverted from the raw number to match what the user is choosing. */}
          <span className="w-16 shrink-0 text-right">
            {sensitivity >= 0.8 ? 'Strict' : sensitivity >= 0.6 ? 'Balanced' : 'Eager'}
          </span>
        </label>
      ) : null}
    </div>
  );
}

export function VoiceSettings() {
  const [dictation, setDictation] = useState<DictationStatus | null>(null);
  const [wake, setWake] = useState<WakeStatus | null>(null);
  const [armed, setArmed] = useState<string[]>(() => readArmed());
  const [sensitivity, setSensitivity] = useState<Record<string, number>>(() => readSensitivity());
  const [speech, setSpeech] = useState<PiperStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [status, wakeStatus, speechStatus] = await Promise.all([
      voiceApi.status().catch(() => null),
      voiceApi.wake().catch(() => null),
      readPiperStatus(),
    ]);
    setDictation(status);
    setWake(wakeStatus);
    setSpeech(speechStatus);
  }, []);

  useEffect(() => {
    // Guarded rather than fire-and-forget: closing the panel mid-request would
    // otherwise set state on a component that is gone.
    let cancelled = false;
    void (async () => {
      const [status, wakeStatus, speechStatus] = await Promise.all([
        voiceApi.status().catch(() => null),
        voiceApi.wake().catch(() => null),
        readPiperStatus(),
      ]);
      if (cancelled) return;
      setDictation(status);
      setWake(wakeStatus);
      setSpeech(speechStatus);
    })();
    return () => { cancelled = true; };
  }, []);

  const run = useCallback(async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const toggle = useCallback((id: string, next: boolean) => {
    setArmed((current) => {
      const updated = next ? [...new Set([...current, id])] : current.filter((each) => each !== id);
      writeArmed(updated);
      return updated;
    });
  }, []);

  const setWordSensitivity = useCallback((id: string, value: number) => {
    setSensitivity((current) => {
      const updated = { ...current, [id]: value };
      writeSensitivity(updated);
      return updated;
    });
  }, []);

  return (
    <section className="space-y-4">
      <header>
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <Mic className="size-4" aria-hidden="true" />
          Voice
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Speech recognition runs on this machine. No audio and no transcript ever leaves it.
        </p>
      </header>

      <div className="rounded-lg border border-border p-3">
        <Row
          title="Dictation"
          detail={dictation?.ready
            ? 'Ready. Press the microphone in the composer to speak.'
            : dictation?.reason ?? 'Checking…'}
        >
          {dictation && !dictation.ready && !dictation.modelPresent ? (
            <ActionButton
              busy={busy === 'speech'}
              onClick={() => void run('speech', voiceApi.downloadSpeechModel)}
            >
              {`${dictation.downloadMiB} MB`}
            </ActionButton>
          ) : null}
        </Row>
      </div>

      <div className="rounded-lg border border-border p-3">
        <div className="pb-1">
          <div className="text-sm">Wake words</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Listening for a wake word keeps the microphone open. It is off until you turn it on,
            and the indicator in the composer shows whenever it is listening.
          </p>
        </div>

        {wake?.words.map((word) => (
          <WakeWordRow
            key={word.id}
            word={word}
            armed={armed.includes(word.id)}
            sensitivity={sensitivity[word.id] ?? word.threshold}
            range={wake.thresholdRange}
            busy={busy === word.id}
            onDownload={() => void run(word.id, () => voiceApi.downloadWakeWord(word.id))}
            onToggle={(next) => toggle(word.id, next)}
            onSensitivity={(value) => setWordSensitivity(word.id, value)}
          />
        ))}

        {!wake ? <p className="py-2 text-xs text-muted-foreground">Checking…</p> : null}
      </div>

      {/*
        Speech out.

        Its own box rather than a row inside dictation, because the two fail
        independently: a machine can hear without a voice installed and the
        reverse, and folding them together would make one missing download read
        as the whole feature being broken.
      */}
      <div className="rounded-lg border border-border p-3">
        <div className="pb-1">
          <div className="text-sm">Spoken replies</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {speech?.enginePresent
              ? 'Answers are read back in one of these voices. Synthesis runs on this machine — no text is sent anywhere. Until a voice is downloaded the app falls back to the system voice, which works but sounds dated.'
              : 'The speech engine is not installed. Replies fall back to the system voice.'}
          </p>
        </div>

        {speech?.voices.map((voice) => (
          <Row
            key={voice.id}
            title={voice.label}
            detail={voice.id === speech.defaultVoice
              ? 'Used when a chat has no pet of its own.'
              : undefined}
          >
            {voice.installed ? (
              <span className="text-xs text-muted-foreground">Installed</span>
            ) : (
              <ActionButton
                busy={busy === voice.id}
                onClick={() => void run(voice.id, () => downloadPiperVoice(voice.id))}
              >
                {busy === voice.id
                  ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  : <Download className="size-3.5" aria-hidden="true" />}
                {`${voice.downloadMiB} MB`}
              </ActionButton>
            )}
          </Row>
        ))}

        {speech && speech.voices.every((voice) => !voice.installed) ? (
          <p className="flex items-start gap-1.5 pt-1 text-xs text-muted-foreground">
            <Volume2 className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
            Nothing is downloaded yet, so replies use the system voice.
          </p>
        ) : null}

        {!speech ? <p className="py-2 text-xs text-muted-foreground">Checking…</p> : null}
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </section>
  );
}
