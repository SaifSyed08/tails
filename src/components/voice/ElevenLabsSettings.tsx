import { Check, Loader2, Play } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { readDefaultVoice, saveDefaultVoice, type DefaultVoice } from '@/components/settings/default-voice';

/**
 * The cloud voice, and the chance to hear it before choosing it.
 *
 * ## Sampling is the feature, not a nicety
 *
 * A provider with hundreds of voices and a list of names is a list of names.
 * Nobody can tell "Charlotte" from "Matilda" by reading them, so without a play
 * button the only way to choose is to apply one, go back to the chat, say
 * something, and listen — then repeat. That loop is slow enough that most
 * people would pick the first entry and conclude the feature was not worth it.
 *
 * The sample says a line from this app rather than the vendor's stock preview,
 * so what is being judged is how the voice reads *this* kind of speech.
 *
 * ## The key never reaches this component
 *
 * It is posted once and afterwards only ever described — four characters, which
 * is enough to tell two keys apart and not enough to be worth anything in a
 * screenshot. Every sample and every line is fetched through this app's own
 * server, which holds the key; the page never talks to the vendor.
 */

type Voice = { id: string; name: string; description: string };

type Status = {
  configured: boolean;
  keyHint: string | null;
  voices: Voice[];
  sampleLine: string;
};

const EMPTY: Status = { configured: false, keyHint: null, voices: [], sampleLine: '' };

/*
  One element for every sample, at module scope.

  Not a ref, because the unmount cleanup has to be able to stop whatever is
  playing and a ref that an effect reads must not be reassigned — the lint rule
  that says so is right, and the shape it is pointing at is this one. A single
  element is also what stops a fast run down the list from playing four voices
  at once, which is the state in which none of them can be judged.
*/
let sampler: HTMLAudioElement | null = null;

function stopSample(): void {
  sampler?.pause();
}

/** Plays one sample, replacing whatever was playing. Resolves when it starts. */
async function playSample(url: string, onEnded: () => void): Promise<void> {
  sampler ??= new Audio();
  sampler.pause();
  sampler.src = url;
  const finish = () => { URL.revokeObjectURL(url); onEnded(); };
  // Revoked when it finishes rather than on the next press: a sample cut short
  // by another still has to release its blob.
  sampler.onended = finish;
  sampler.onerror = finish;
  await sampler.play();
}

export function ElevenLabsSettings() {
  const [status, setStatus] = useState<Status>(EMPTY);
  const [voice, setVoice] = useState<DefaultVoice | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((): void => {
    void fetch('/api/voice/elevenlabs')
      .then((response) => response.json() as Promise<Status>)
      .then(setStatus)
      .catch(() => setError('Could not reach the voice service.'));
    void readDefaultVoice().then(setVoice).catch(() => {});
  }, []);

  useEffect(load, [load]);

  // Leaving the panel stops the sample. A voice still talking over a
  // conversation the user has gone back to is the app not letting go.
  useEffect(() => stopSample, []);

  const saveKey = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/voice/elevenlabs/key', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      if (!response.ok) throw new Error('The key was not accepted.');
      // Cleared from the field the moment it is stored. A key left in an input
      // is a key in a screenshot of the settings screen.
      setKey('');
      load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save that.');
    } finally {
      setBusy(false);
    }
  };

  const sample = async (id: string): Promise<void> => {
    stopSample();
    setPlaying(id);
    setError(null);
    try {
      const response = await fetch(`/api/voice/elevenlabs/sample/${encodeURIComponent(id)}`, {
        method: 'POST',
      });
      if (!response.ok) throw new Error('That voice did not answer.');

      const url = URL.createObjectURL(await response.blob());
      await playSample(url, () => setPlaying(null));
    } catch (playError) {
      setError(playError instanceof Error ? playError.message : 'Could not play that.');
      setPlaying(null);
    }
  };

  const choose = async (id: string | null): Promise<void> => {
    if (!voice) return;
    setBusy(true);
    try {
      setVoice(await saveDefaultVoice({ ...voice, elevenVoiceId: id }));
    } catch {
      setError('Could not save that choice.');
    } finally {
      setBusy(false);
    }
  };

  const chosen = voice?.elevenVoiceId ?? null;

  return (
    // The id is carried by the panel that mounts this, not by the section
    // itself: its jump-link test reads that file, and a section holding its own
    // would be a link to nowhere. Same arrangement as the transcription
    // settings beside it.
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">Cloud voice</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Much better speech than anything that runs on this machine, from ElevenLabs, using
          your own key. It is billed per character and every line spoken this way leaves the
          machine — including the ones a chatty pet says on its own, without being asked. The
          local voice stays the default until you pick one here.
        </p>
      </div>

      {error ? (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="password"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder={status.configured ? `Saved ${status.keyHint ?? ''}` : 'Paste your API key'}
          aria-label="ElevenLabs API key"
          data-tails-part="input"
          className="min-w-56 flex-1 p-2 text-sm outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        />
        <button
          type="button"
          onClick={() => void saveKey()}
          disabled={busy || (!key.trim() && !status.configured)}
          className="rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-transform duration-instant ease-emphasis active:scale-95 disabled:opacity-50"
        >
          {key.trim() ? 'Save key' : 'Remove key'}
        </button>
      </div>

      {!status.configured ? (
        <p className="text-xs text-muted-foreground">
          No key yet, so nothing here is in use and nothing is being billed.
        </p>
      ) : status.voices.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          The key is saved, but no voices came back — it may be wrong, or the account may have
          none.
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Press play to hear each one say “{status.sampleLine}”.
          </p>
          <ul className="max-h-72 space-y-1 overflow-y-auto">
            {status.voices.map((entry) => (
              <li
                key={entry.id}
                data-tails-part="card"
                className="flex items-center justify-between gap-2 px-3 py-2"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm">{entry.name}</span>
                  {entry.description ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      {entry.description}
                    </span>
                  ) : null}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void sample(entry.id)}
                    aria-label={`Hear ${entry.name}`}
                    className="rounded-md border border-border p-1.5 text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
                  >
                    {playing === entry.id
                      ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                      : <Play className="size-3.5" aria-hidden="true" />}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void choose(chosen === entry.id ? null : entry.id)}
                    aria-pressed={chosen === entry.id}
                    className="flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-xs transition-transform duration-instant ease-emphasis active:scale-95 disabled:opacity-50 aria-pressed:border-primary aria-pressed:text-primary"
                  >
                    {chosen === entry.id ? <Check className="size-3" aria-hidden="true" /> : null}
                    {chosen === entry.id ? 'In use' : 'Use'}
                  </button>
                </span>
              </li>
            ))}
          </ul>
          {chosen ? (
            <button
              type="button"
              onClick={() => void choose(null)}
              className="rounded-md border border-border px-2.5 py-1.5 text-xs transition-transform duration-instant ease-emphasis active:scale-95"
            >
              Go back to the local voice
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
