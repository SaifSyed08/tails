import { Check, Eye, Monitor, Moon, Pencil, Sparkles, Sun, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import {
  readColorMode,
  setColorModePreference,
  subscribeColorMode,
  type ColorModePreference,
} from '@/components/appearance/colorMode';
import { api, type ThemeSummary } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Reveal, Stagger } from '@/shared/ui/Motion';

type SettingsPanelProps = {
  sessionId: string | null;
  onClose: () => void;
};

const INTRO_DISABLED_KEY = 'tails.introDisabled';

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
    <section className="space-y-2 border-t border-border pt-5">
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
            <section className="space-y-3">
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
                              className="min-w-0 flex-1 px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-ring"
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

            <section className="space-y-2 border-t border-border pt-5">
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
