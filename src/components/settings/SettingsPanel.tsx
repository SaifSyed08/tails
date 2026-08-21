import { Check, Eye, Monitor, Moon, Pencil, Sparkles, Sun, Trash2, Volume2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import {
  readColorMode,
  setColorModePreference,
  subscribeColorMode,
  type ColorModePreference,
} from '@/components/appearance/colorMode';
import {
  DEFAULT_VOICE,
  readDefaultVoice,
  resolveVoice,
  saveDefaultVoice,
  type DefaultVoice,
} from '@/components/settings/default-voice';
import { useSpeech } from '@/components/voice/useSpeech';
import { VoiceSettings } from '@/components/voice/VoiceSettings';
import {
  collisionSoundEnabled,
  setCollisionSoundEnabled,
} from '@/components/petstage/pet-sfx';
import { api, type ThemeSummary } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Reveal, Stagger, useReducedMotion } from '@/shared/ui/Motion';

type SettingsPanelProps = {
  sessionId: string | null;
  onClose: () => void;
};

const INTRO_DISABLED_KEY = 'tails.introDisabled';

/**
 * Every section, in the order they appear, for the index at the top.
 *
 * The list exists because the panel had grown to five headings in one scroll
 * and the answer to "where do I change the voice" was "scroll and find out".
 * Declared once and read by both the index and the sections themselves, so a
 * heading cannot be renamed in one place and left stale in the other —
 * `settings-sections.test.ts` asserts every id here is on a real section.
 */
const SECTIONS = [
  { id: 'settings-appearance', label: 'Appearance' },
  { id: 'settings-colour-mode', label: 'Colour mode' },
  { id: 'settings-instructions', label: 'Instructions' },
  // The two halves of voice, adjacent and named apart: the voice module's
  // section is the machine listening, this module's is the machine speaking.
  // They share a word and nothing else, which is exactly the case an index has
  // to disambiguate rather than paper over.
  { id: 'settings-voice-input', label: 'Voice' },
  { id: 'settings-voice', label: 'Default voice' },
  { id: 'settings-pets', label: 'Pets' },
  { id: 'settings-startup', label: 'Startup' },
] as const;

/**
 * Approximates a theme's look as three swatches.
 *
 * Derived from the spec's hues rather than the real derived tokens: the point
 * is a recognisable thumbnail, and rendering the actual ramp per card would
 * mean deriving every theme on every render for a few pixels of accuracy.
 */
function ThemeSwatches({ theme }: { theme: ThemeSummary }) {
  const { surfaceHue, accentHue } = theme.spec.palette;
  const swatches = [
    `hsl(${surfaceHue} 12% 22%)`,
    `hsl(${surfaceHue} 10% 46%)`,
    `hsl(${accentHue} 72% 55%)`,
  ];

  return (
    <div className="flex gap-1">
      {swatches.map((color) => (
        <span
          key={color}
          className="size-4 rounded-full ring-1 ring-inset ring-black/10"
          style={{ background: color }}
        />
      ))}
    </div>
  );
}

/**
 * Light, dark, or whatever the operating system is doing.
 *
 * Three states rather than a toggle, because "follow the system" is a real
 * answer and a two-way switch cannot express it — and because the app defaults
 * to dark, someone whose machine is set to light has no way to say so without
 * it.
 *
 * `system` is live: `colorMode.ts` holds a `prefers-color-scheme` listener, so
 * a machine on a scheduled theme flips this app at dusk along with everything
 * else. Reading the media query once at boot would make "system" mean "whatever
 * the system was when you launched", which is the version of this feature
 * everyone has been annoyed by.
 *
 * When a theme pins a mode the control is disabled rather than ignored. A
 * segmented control that silently does nothing is worse than one that is
 * visibly unavailable: the first looks broken, the second explains itself.
 */
function ColorModeControl() {
  const { preference, effective, pinnedMode } = useSyncExternalStore(
    subscribeColorMode,
    readColorMode,
    readColorMode,
  );

  const options: { value: ColorModePreference; label: string; icon: typeof Sun }[] = [
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'dark', label: 'Dark', icon: Moon },
    { value: 'system', label: 'System', icon: Monitor },
  ];

  return (
    <section id="settings-colour-mode" className="space-y-2 border-t border-border pt-5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold">Colour mode</h3>
        {pinnedMode ? (
          <span className="text-xs text-muted-foreground">
            Locked to {pinnedMode} by the current look
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            {preference === 'system' ? `Following your system — ${effective} right now` : null}
          </span>
        )}
      </div>

      <div
        role="radiogroup"
        aria-label="Colour mode"
        className={cn(
          'inline-flex gap-1 rounded-lg border border-border p-1',
          pinnedMode && 'pointer-events-none opacity-50',
        )}
      >
        {options.map((option) => {
          const Icon = option.icon;
          const active = !pinnedMode && preference === option.value;

          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={pinnedMode !== null}
              onClick={() => setColorModePreference(option.value)}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors duration-quick',
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <Icon className="size-3.5" />
              {option.label}
            </button>
          );
        })}
      </div>

      {pinnedMode ? (
        <p className="text-xs text-muted-foreground">
          Looks like Terminal are built for one mode only. Pick another look, or reset the
          appearance, to choose again.
        </p>
      ) : null}
    </section>
  );
}

/**
 * Standing instructions for how T.A.I.L.S. talks.
 *
 * Global, and deliberately not a fourth chip on the composer. The per-turn
 * knobs down there — permission mode, model, effort — are decisions about the
 * message you are about to send; this is a decision about the person sending
 * it, and something you would have to retype in every new chat is not a
 * preference. So it is stored once, server-side, and every conversation in
 * every window reads the same answer.
 *
 * Saved on a button rather than as you type. This is prose: a debounced
 * autosave would store half-written sentences, and a turn that started
 * mid-thought would be shaped by one.
 */
function ConversationInstructions() {
  // Null until the server answers. The cap is the server's to state — writing
  // the number here as well is how a field comes to offer room that the save
  // then quietly takes back.
  const [limit, setLimit] = useState<number | null>(null);
  const [saved, setSaved] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    api.getConversationInstructions()
      .then((result) => {
        if (cancelled) return;
        setSaved(result.instructions);
        setDraft(result.instructions);
        setLimit(result.maxLength);
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : 'Could not load your instructions.');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    setBusy(true);
    setError(null);

    try {
      const result = await api.setConversationInstructions(draft);
      setSaved(result.instructions);
      // The stored text, not the typed text: a paste the server clamped should
      // leave the box showing what will actually reach the model.
      setDraft(result.instructions);
      setLimit(result.maxLength);
      setConfirmed(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save that.');
    } finally {
      setBusy(false);
    }
  };

  const dirty = draft !== saved;

  return (
    <section id="settings-instructions" className="space-y-2 border-t border-border pt-5">
      <div>
        <h3 className="text-sm font-semibold">Conversation instructions</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Standing notes on how T.A.I.L.S. should talk to you — tone, length, house style.
          Added to what it already knows rather than replacing it, so it keeps every ability
          it has and only changes how it speaks. Leave this empty and nothing is added at all.
        </p>
      </div>

      {error ? (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <textarea
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setConfirmed(false);
        }}
        rows={4}
        disabled={limit === null}
        maxLength={limit ?? undefined}
        aria-label="Conversation instructions"
        aria-describedby="conversation-instructions-hint"
        placeholder={'Keep answers short and skip the preamble.\nUse British spelling.\nWhen you explain code, cover the tricky part rather than every line.'}
        data-tails-part="input"
        // A `focus:ring-*` would be inert here: the theme owns `box-shadow` on
        // a tagged part at (0,2,0), so the utility silently never renders and
        // the field ends up with no focus indicator at all. An outline is not
        // in the contract's hands.
        className="w-full resize-y p-2.5 text-sm outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
      />

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || busy}
          className="rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-transform duration-instant ease-emphasis active:scale-95 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>

        {dirty ? (
          <button
            type="button"
            onClick={() => {
              setDraft(saved);
              setConfirmed(false);
            }}
            className="rounded-md border border-border px-2.5 py-1.5 text-xs transition-colors duration-quick hover:bg-accent"
          >
            Discard
          </button>
        ) : null}

        {limit === null ? null : (
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            {draft.length} / {limit}
          </span>
        )}
      </div>

      {/* Announced, because the only other evidence a save landed is a button
          going grey. The wording follows the model picker: a fresh CLI is
          spawned per turn, so the next message is genuinely the earliest this
          can take effect, and neither control should imply otherwise. */}
      <p
        id="conversation-instructions-hint"
        aria-live="polite"
        className="text-xs text-muted-foreground"
      >
        {confirmed
          ? `${saved ? 'Saved' : 'Cleared'}. Applies from your next message, in every conversation.`
          : 'Applies from your next message, in every conversation.'}
      </p>
    </section>
  );
}

/** What the preview says. Long enough that pitch and speed are audible in it. */
const VOICE_PREVIEW_LINE = 'This is how I will sound when nothing else has a voice of its own.';

/**
 * The voice for everything that has not been given one.
 *
 * Per-pet voices already existed; a chat with no pet, or a pet nobody has
 * chosen a voice for, had nothing underneath them. This is that floor, and the
 * paragraph under the heading states the whole order rather than leaving the
 * user to infer it — the interesting case is the one that looks like a bug from
 * outside, a pet deliberately kept quiet, which this must not override.
 *
 * Saved as you change it, unlike the instructions box above. These are three
 * discrete controls with no half-written state, and a Save button next to a
 * slider you have just dragged is a step nobody expects to have to take.
 */
function DefaultVoiceControl() {
  const speech = useSpeech();
  const [voice, setVoice] = useState<DefaultVoice>(DEFAULT_VOICE);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
    A slider fires per step, so one sweep is thirty writes — and the last write
    to arrive is not necessarily the last one sent, which is how a dragged value
    ends up stored two steps behind where it was left. Local state stays
    authoritative and the write is debounced behind it.
  */
  const pendingRef = useRef<DefaultVoice | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    readDefaultVoice()
      .then((stored) => {
        if (cancelled) return;
        setVoice(stored);
        setLoaded(true);
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : 'Could not load the default voice.');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => {
    // Closing the panel must not swallow a change made a moment before. The
    // pending write is fired rather than cancelled, and its result dropped —
    // there is no longer a control to report an error on.
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    if (pendingRef.current) void saveDefaultVoice(pendingRef.current).catch(() => {});
  }, []);

  const commit = (next: DefaultVoice) => {
    setVoice(next);
    setError(null);
    pendingRef.current = next;

    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      pendingRef.current = null;
      // The response is not applied back. The controls cannot produce a value
      // outside the server's clamp, so there is nothing to correct, and
      // adopting a reply that raced a later drag is the bug this avoids.
      void saveDefaultVoice(next).catch((saveError: unknown) => {
        setError(saveError instanceof Error ? saveError.message : 'That voice could not be saved.');
      });
    }, 300);
  };

  // Deliberately resolved with no pet: this is exactly the "a chat with nobody
  // in it" path, so the preview is the real fallback rather than a
  // demonstration of one.
  const preview = () => {
    if (speech.speaking) {
      speech.hush();
      return;
    }
    const settings = resolveVoice(null, voice, speech.voices);
    if (settings) speech.speak(VOICE_PREVIEW_LINE, settings);
  };

  return (
    <section id="settings-voice" className="space-y-3 border-t border-border pt-5">
      <div>
        <h3 className="text-sm font-semibold">Default voice</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Which voice reads replies aloud, for a chat with no pet and for a pet who has not
          been given a voice of his own. A pet with his own voice keeps it, and a pet set to
          stay quiet stays quiet.
        </p>
      </div>

      {error ? (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {!speech.supported ? (
        <p className="text-xs text-muted-foreground">
          This machine has no speech synthesiser, so there is no voice to choose.
        </p>
      ) : (
        <>
          <label className="block space-y-1 text-sm">
            <span>Speaks with</span>
            <select
              value={voice.name ?? ''}
              disabled={!loaded}
              onChange={(event) => commit({ ...voice, name: event.target.value || null })}
              data-tails-part="input"
              // `focus:ring-*` is inert on a themed part — the contract owns
              // box-shadow at (0,2,0) — so the focus indicator is an outline.
              className="w-full px-2 py-1 text-sm outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
            >
              {/* The platform's own pick, named as such. Offering the resolved
                  voice by name here would claim a choice the user never made,
                  and it is not stable across machines. */}
              <option value="">Whatever this machine prefers</option>
              {speech.voices.map((available) => (
                <option key={available.name} value={available.name}>
                  {available.name}
                  {available.lang ? ` (${available.lang})` : ''}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-1 text-sm">
            <span className="flex items-baseline justify-between">
              <span>Pitch</span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {voice.pitch.toFixed(1)}
              </span>
            </span>
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.1}
              value={voice.pitch}
              disabled={!loaded}
              onChange={(event) => commit({ ...voice, pitch: Number(event.target.value) })}
              className="w-full accent-primary disabled:opacity-60"
            />
          </label>

          <label className="block space-y-1 text-sm">
            <span className="flex items-baseline justify-between">
              <span>Speed</span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {voice.rate.toFixed(1)}
              </span>
            </span>
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.1}
              value={voice.rate}
              disabled={!loaded}
              onChange={(event) => commit({ ...voice, rate: Number(event.target.value) })}
              className="w-full accent-primary disabled:opacity-60"
            />
          </label>

          {/* Nobody picks a voice from a name, and nobody judges a pitch from a
              number. The pet panel makes the same call for the same reason. */}
          <button
            type="button"
            onClick={preview}
            disabled={!loaded || speech.voices.length === 0}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs transition-colors duration-quick hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            <Volume2 className="size-3.5" aria-hidden="true" />
            {speech.speaking ? 'Stop' : 'Hear it'}
          </button>

          {/* The other half of the split the user tripped over: per-pet voices
              live on the pet, this lives on the app, and each side has to say
              where the other one is or the split is just two places to look. */}
          <p className="text-xs text-muted-foreground">
            To give one pet a voice of his own, open him from the sidebar carousel or from
            the chat and use the Voice section of his panel.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * A jump link per section, so the whole panel is legible without scrolling it.
 *
 * The complaint this answers was about *finding* a setting, and half of that
 * problem survives opening the panel: five headings in one scroll means the
 * ones below the fold do not exist until you go looking. Scrolled rather than
 * linked by hash, because a `#fragment` in an app with no router is a URL
 * change that means nothing and does not survive a reload.
 */
function SectionIndex() {
  const reduced = useReducedMotion();

  return (
    <nav aria-label="Settings sections" className="flex flex-wrap gap-1.5">
      {SECTIONS.map((section) => (
        <button
          key={section.id}
          type="button"
          onClick={() => document.getElementById(section.id)?.scrollIntoView({
            behavior: reduced ? 'auto' : 'smooth',
            block: 'start',
          })}
          className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
        >
          {section.label}
        </button>
      ))}
    </nav>
  );
}

/**
 * Appearance settings.
 *
 * The manual half of generative theming: everything the agent can do through
 * its tools, the user can also do by hand here — preview, apply to this chat
 * or everywhere, rename a look the agent invented so it becomes a keeper, and
 * delete it.
 */
export function SettingsPanel({ sessionId, onClose }: SettingsPanelProps) {
  const [themes, setThemes] = useState<ThemeSummary[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [introDisabled, setIntroDisabled] = useState(
    () => localStorage.getItem(INTRO_DISABLED_KEY) === '1',
  );
  // Read once on open rather than watched: it is only ever changed from this
  // panel, so there is nothing else to stay in step with.
  const [collisionSound, setCollisionSound] = useState(collisionSoundEnabled);

  // Reloads are requested by bumping a token rather than by calling a fetcher
  // directly, which keeps every state write inside a promise callback instead
  // of running synchronously as the effect body.
  const [reloadToken, setReloadToken] = useState(0);
  const refresh = useCallback(() => setReloadToken((current) => current + 1), []);

  useEffect(() => {
    let cancelled = false;

    api.listThemes()
      .then((items) => {
        if (cancelled) return;
        setThemes(items);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : 'Could not load looks.');
      });

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  // Escape closes, which is what every panel like this should do.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const runAction = async (themeId: string, action: () => Promise<unknown>) => {
    setBusyId(themeId);
    setError(null);
    try {
      await action();
      refresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'That did not work.');
    } finally {
      setBusyId(null);
    }
  };

  const toggleIntro = (disabled: boolean) => {
    setIntroDisabled(disabled);
    localStorage.setItem(INTRO_DISABLED_KEY, disabled ? '1' : '0');
  };

  return (
    // The positioning has to live on a plain wrapper, not on the scrim itself.
    // `[data-tails-part][data-tails-part]` sets `position: relative` at (0,2,0)
    // to anchor the theme's paint layer, which outranks Tailwind's `.fixed` —
    // put both on one element and the panel lays out in normal flow underneath
    // the `h-screen` app, so opening settings looks like nothing happened until
    // the page is scrolled. The scrim fills the wrapper by box size instead,
    // because an `absolute inset-0` here would lose the same specificity fight.
    <div className="fixed inset-0 z-40">
      <div
        data-tails-part="scrim"
        className="flex size-full items-start justify-center p-6"
      >
        <Reveal
          variant="scale"
          part="card"
          className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden"
        >
          <header className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
            <h2 className="font-display text-sm font-semibold uppercase tracking-wide">Settings</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close settings"
              className="rounded-md p-1.5 text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </header>

          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
            <SectionIndex />

            <section id="settings-appearance" className="space-y-3">
              <div>
                <h3 className="text-sm font-semibold">Appearance</h3>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Pick a look, or ask T.A.I.L.S. in chat to design one — anything it makes shows up
                  here, and you can rename it to keep it.
                </p>
              </div>

              {error ? (
                <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </p>
              ) : null}

              <Stagger variant="fade" className="space-y-2">
                {themes.map((theme) => (
                  <div
                    key={theme.id}
                    data-tails-part="card"
                    className={cn(
                      'p-3 transition-colors duration-quick',
                      busyId === theme.id && 'opacity-60',
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 shrink-0">
                        <ThemeSwatches theme={theme} />
                      </div>

                      <div className="min-w-0 flex-1">
                        {renamingId === theme.id ? (
                          <div className="flex gap-2">
                            <input
                              value={renameDraft}
                              onChange={(event) => setRenameDraft(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key !== 'Enter') return;
                                void runAction(theme.id, () => api.renameTheme(theme.id, renameDraft))
                                  .then(() => setRenamingId(null));
                              }}
                              autoFocus
                              aria-label="Preset name"
                              data-tails-part="input"
                              className="min-w-0 flex-1 px-2 py-1 text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
                            />
                            <button
                              type="button"
                              onClick={() => void runAction(theme.id, () => api.renameTheme(theme.id, renameDraft))
                                .then(() => setRenamingId(null))}
                              aria-label="Save name"
                              className="rounded-md bg-primary px-2 py-1 text-primary-foreground"
                            >
                              <Check className="size-3.5" />
                            </button>
                          </div>
                        ) : (
                          <>
                            <p className="flex items-center gap-1.5 text-sm font-medium">
                              {theme.name}
                              {theme.builtIn ? (
                                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                  built in
                                </span>
                              ) : null}
                              {theme.spec.mode !== 'adaptive' ? (
                                <span
                                  className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-warning"
                                  title="This look pins the colour mode, so the light/dark toggle is disabled while it is active."
                                >
                                  {theme.spec.mode} only
                                </span>
                              ) : null}
                            </p>
                            <p className="mt-0.5 text-xs text-muted-foreground">{theme.summary}</p>
                          </>
                        )}

                        <div className="mt-2.5 flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            onClick={() => void runAction(theme.id, () =>
                              api.previewTheme(theme.spec, sessionId ?? undefined))}
                            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs transition-colors duration-quick hover:bg-accent"
                          >
                            <Eye className="size-3" /> Preview
                          </button>
                          <button
                            type="button"
                            disabled={!sessionId}
                            onClick={() => void runAction(theme.id, () => api.applyTheme({
                              themeId: theme.id, scope: 'session', sessionId: sessionId ?? undefined,
                            }))}
                            className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground transition-transform duration-instant ease-emphasis active:scale-95 disabled:opacity-50"
                          >
                            This chat
                          </button>
                          <button
                            type="button"
                            onClick={() => void runAction(theme.id, () => api.applyTheme({
                              themeId: theme.id, scope: 'global',
                            }))}
                            className="rounded-md border border-border px-2 py-1 text-xs transition-colors duration-quick hover:bg-accent"
                          >
                            Everywhere
                          </button>

                          {!theme.builtIn ? (
                            <>
                              <button
                                type="button"
                                onClick={() => {
                                  setRenamingId(theme.id);
                                  setRenameDraft(theme.name);
                                }}
                                aria-label={`Rename ${theme.name}`}
                                className="ml-auto rounded-md p-1 text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
                              >
                                <Pencil className="size-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => void runAction(theme.id, () => api.deleteTheme(theme.id))}
                                aria-label={`Delete ${theme.name}`}
                                className="rounded-md p-1 text-muted-foreground transition-colors duration-quick hover:bg-destructive/10 hover:text-destructive"
                              >
                                <Trash2 className="size-3.5" />
                              </button>
                            </>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </Stagger>

              <div className="flex flex-wrap gap-2 pt-1">
                {/* The full teardown, not an unbind: every layer, both scopes,
                    the same endpoint the agent's `theme_reset` calls. Clearing
                    only the global binding used to leave a hand-written CSS
                    layer and a set of published controls on screen, which is
                    how "reset" came to mean "reset some of it". */}
                <button
                  type="button"
                  onClick={() => void runAction('reset', () => fetch('/api/appearance/reset', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ sessionId }),
                  }))}
                  className="rounded-md border border-border px-2.5 py-1.5 text-xs transition-colors duration-quick hover:bg-accent"
                >
                  Reset everything
                </button>
                {sessionId ? (
                  <button
                    type="button"
                    onClick={() => void runAction('reset-session', () =>
                      api.unbindTheme('session', sessionId))}
                    className="rounded-md border border-border px-2.5 py-1.5 text-xs transition-colors duration-quick hover:bg-accent"
                  >
                    Clear this chat&apos;s look
                  </button>
                ) : null}
              </div>

              <p className="flex items-start gap-1.5 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                <Sparkles className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                Try asking in chat: &ldquo;make this conversation futuristic&rdquo; — then rename what it
                builds to keep it as a preset.
              </p>
            </section>

            <ColorModeControl />

            <ConversationInstructions />

            {/* The voice module's own section, mounted whole — it owns its
                fetching, its state and its copy, including licence wording that
                belongs next to the code that knows why. The wrapper is only
                here to carry the index's anchor and the divider every other
                section draws for itself. */}
            <div id="settings-voice-input" className="border-t border-border pt-5">
              <VoiceSettings />
            </div>

            <DefaultVoiceControl />

            <section id="settings-pets" className="space-y-2 border-t border-border pt-5">
              <h3 className="text-sm font-semibold">Pets</h3>
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={collisionSound}
                  onChange={(event) => {
                    setCollisionSound(event.target.checked);
                    setCollisionSoundEnabled(event.target.checked);
                  }}
                  className="mt-0.5 size-4 accent-primary"
                />
                <span>
                  <span className="block text-sm">Sound when a pet hits a wall</span>
                  {/*
                    Off by default, and the copy says why rather than leaving it
                    to be discovered: this one fires on bounces the user did not
                    aim, which is the kind of noise people switch off once and
                    never switch back on.
                  */}
                  <span className="block text-xs text-muted-foreground">
                    A soft thud when a thrown pet reaches the edge of the chat, louder for a
                    harder throw. Off by default, because it happens without being asked for.
                  </span>
                </span>
              </label>
            </section>

            <section id="settings-startup" className="space-y-2 border-t border-border pt-5">
              <h3 className="text-sm font-semibold">Startup</h3>
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={!introDisabled}
                  onChange={(event) => toggleIntro(!event.target.checked)}
                  className="mt-0.5 size-4 accent-primary"
                />
                <span>
                  <span className="block text-sm">Play the intro on launch</span>
                  <span className="block text-xs text-muted-foreground">
                    It runs while the app loads, and any key skips it.
                  </span>
                </span>
              </label>
            </section>
          </div>
        </Reveal>
      </div>
    </div>
  );
}
