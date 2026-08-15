import { Check, ChevronDown, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { startColorMode } from '@/components/appearance/colorMode';
import { commitAppearance } from '@/components/appearance/commit';
import { setLiveToken } from '@/components/appearance/liveTokens';
import { PointerLayer } from '@/components/appearance/PointerLayer';
import { refreshPointerTracking, startPointerTokens } from '@/components/appearance/pointerTokens';
import { ThemeProposal } from '@/components/appearance/ThemeProposal';
import { useWebSocket } from '@/contexts/WebSocketContext';
import { applyTheme, clearTheme } from '@/theme/applyTheme';

import {
  EMPTY_APPEARANCE_STATE,
  reduceAppearance,
  withControlValue,
  type AppearanceControlShape,
  type AppearanceEvent,
  type AppearanceState,
} from '../../../server/modules/appearance/layer-state';

/**
 * The appearance panel: the knobs the agent published, and the way back.
 *
 * ## Why this holds a whole state rather than a set of flags
 *
 * The first version tracked each layer separately and updated whichever one an
 * incoming event mentioned. That is the natural way to write it and it is the
 * cause of three shipped bugs — a cursor glow that outlived its theme, a
 * background texture that survived a change of preset, a pinned dark mode that
 * survived the adaptive theme after it. Every one was a layer that some path
 * set and no path cleared.
 *
 * So the panel now holds one `AppearanceState`, folds each broadcast into it
 * with `reduceAppearance`, and hands the whole thing to `commitAppearance`,
 * which writes every layer it owns unconditionally. A theme event *replaces*
 * the state rather than merging into it, so residue is not something to
 * remember to clear — there is nowhere for it to survive. The invariant is
 * asserted in `tests/layer-state.test.ts`.
 *
 * ## The two things on screen
 *
 * **The controls the agent invented.** After the model builds a look it
 * publishes the knobs *for that look*, because only whoever built the thing
 * knows what is worth adjusting. Each binds a CSS custom property, so dragging
 * one is a paint rather than a request.
 *
 * **Save, undo, reset.** Shown on *any* appearance change, including one that
 * published no controls — a `theme_apply` with no panel was exactly the case
 * where the user was most stranded, so gating the escape hatch on the agent
 * having remembered to publish knobs would have missed the point. Undo walks a
 * short in-memory stack rather than jumping to the default, because when you
 * are iterating on a look the interesting previous state is almost never the
 * built-in ramp.
 */

export type AppearanceControl = AppearanceControlShape;

/**
 * How far back undo reaches.
 *
 * Deep enough to walk out of an iteration the user did not like, shallow enough
 * that the stack is not quietly holding a dozen full stylesheets for the rest
 * of the session.
 */
const HISTORY_LIMIT = 12;

/** The CSS text a control writes for a given UI value. */
const tokenValue = (control: AppearanceControl, value: number | boolean | string): string => {
  if (control.kind === 'slider') return `${value as number}${control.unit ?? ''}`;
  if (control.kind === 'toggle') return value ? control.on ?? '1' : control.off ?? 'none';
  return String(value);
};

const controlDefaults = (controls: AppearanceControl[]): Record<string, number | boolean | string> =>
  Object.fromEntries(controls.map((control) => [control.id, control.value]));

type AppearancePanelProps = { sessionId: string | null };

export function AppearancePanel({ sessionId }: AppearancePanelProps) {
  const { subscribe } = useWebSocket();

  const [state, setState] = useState<AppearanceState>(EMPTY_APPEARANCE_STATE);
  const [values, setValues] = useState<Record<string, number | boolean | string>>({});
  const [depth, setDepth] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  // The stack is a ref, not state: pushing to it must not re-render, and the
  // only thing the UI needs from it is its depth, which is tracked separately.
  const historyRef = useRef<AppearanceState[]>([]);
  const stateRef = useRef<AppearanceState>(EMPTY_APPEARANCE_STATE);

  /** Installs a state and makes it the thing the DOM shows. */
  const land = useCallback((next: AppearanceState, remember: boolean) => {
    if (remember) {
      historyRef.current = [...historyRef.current, stateRef.current].slice(-HISTORY_LIMIT);
      setDepth(historyRef.current.length);
    }

    stateRef.current = next;
    setState(next);
    setValues(controlDefaults(next.controls));
    commitAppearance(next);
  }, []);

  useEffect(() => startPointerTokens(), []);
  useEffect(() => startColorMode(), []);

  useEffect(() => subscribe((message) => {
    if (message.kind !== 'appearance_changed') return;

    const payload = message.appearance as (AppearanceEvent & { scope?: string; scopeKey?: string }) | undefined;
    if (!payload) return;

    const isForThisWindow = payload.scope !== 'session'
      || !payload.scopeKey
      || payload.scopeKey === sessionId;
    if (!isForThisWindow) return;

    const next = reduceAppearance(stateRef.current, payload);
    if (next === stateRef.current) return;

    // A proposal changes nothing about the running app, so it is not a state
    // anyone would want to undo back into, and it should not make the panel
    // announce itself either.
    const isProposal = payload.layer === 'proposal';
    land(next, !isProposal);

    if (!isProposal) {
      setNote(null);
      setNaming(false);
      setDismissed(false);
      setTouched(true);
    }
  }), [subscribe, sessionId, land]);

  const onControlChange = useCallback((control: AppearanceControl, value: number | boolean | string) => {
    setValues((current) => ({ ...current, [control.id]: value }));

    const written = tokenValue(control, value);
    setLiveToken(control.binds, written);

    // Folded into the *current* state rather than pushed as a new one:
    // otherwise a single slider drag would bury the state the user actually
    // wants to undo to under sixty intermediate frames.
    stateRef.current = withControlValue(stateRef.current, control.binds, written);

    // A control can switch a drawn cursor on, or point a gradient at
    // `--pointer-x`, so the gate on the pointer writer has to be reconsidered
    // after a drag as well as after a theme change.
    refreshPointerTracking();
  }, []);

  const undo = useCallback(() => {
    const previous = historyRef.current.pop();
    if (!previous) return;
    setDepth(historyRef.current.length);

    // The theme stylesheet belongs to `applyTheme.ts`; everything else is
    // restored by the commit below. Scope `preview` so undoing a look does not
    // rewrite the cached boot stylesheet — the server binding has not changed,
    // and undo is a local visual step rather than a new decision.
    if (previous.themeCss) {
      void applyTheme({
        themeId: previous.themeId,
        name: previous.themeName,
        css: previous.themeCss,
        pinnedMode: previous.pinnedMode,
        scope: 'preview',
      });
    } else {
      clearTheme();
    }

    land(previous, false);
    setNote(null);
    window.dispatchEvent(new CustomEvent('tails:appearance-changed'));
  }, [land]);

  const reset = useCallback(() => {
    // One request, and deliberately no client-side teardown beside it. The
    // server drops every binding and every ephemeral layer and broadcasts a
    // theme event carrying an empty stylesheet; that arrives here like any
    // other change and reduces to the built-in floor. Same code path as the
    // agent's `theme_reset`, so the button and the tool cannot drift apart —
    // and one fewer place that has to remember what "everything" means.
    void fetch('/api/appearance/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
      .then(() => setNote('Back to the built-in look.'))
      .catch(() => setNote('Could not reach the server to reset.'));
  }, [sessionId]);

  const save = useCallback(async () => {
    try {
      const response = await fetch('/api/appearance/keep', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, sessionId }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? 'Could not save that look.');

      setNaming(false);
      setName('');
      setNote(`Saved as "${body?.name ?? name}".`);
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'Could not save that look.');
    }
  }, [name, sessionId]);

  const proposal = (
    <ThemeProposal
      variants={state.proposal}
      onDismiss={() => land({ ...stateRef.current, proposal: [] }, false)}
    />
  );

  // Nothing has changed yet, so there is nothing to undo, save or reset — but a
  // proposal or a themed cursor can be on screen before anything is applied.
  if (!touched || dismissed) {
    return (
      <>
        <PointerLayer />
        {proposal}
      </>
    );
  }

  return (
    <>
      <PointerLayer />
      {proposal}
      <div
        data-tails-part="popover"
        className="animate-rise-in fixed right-4 top-16 z-30 w-64 rounded-lg border border-border p-3 text-xs shadow-lg"
      >
        <div className="relative z-[1] flex items-center gap-1">
          <button
            type="button"
            onClick={() => setCollapsed((current) => !current)}
            className="-ml-1 flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-0.5 text-left font-medium transition-colors duration-quick hover:bg-muted/50"
            aria-expanded={!collapsed}
          >
            <ChevronDown
              className={`size-3.5 shrink-0 transition-transform duration-quick ${collapsed ? '-rotate-90' : ''}`}
            />
            <span className="truncate">{state.controlsTitle || 'Appearance'}</span>
          </button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label="Dismiss appearance panel"
            className="rounded p-1 transition-colors duration-quick hover:bg-muted/50"
          >
            <X className="size-3.5" />
          </button>
        </div>

        {!collapsed ? (
          <div className="relative z-[1] mt-2 space-y-3">
            {state.controls.map((control) => (
              <Control
                key={control.id}
                control={control}
                value={values[control.id] ?? control.value}
                onChange={(value) => onControlChange(control, value)}
              />
            ))}

            {naming ? (
              <div className="flex items-center gap-1">
                <input
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void save();
                    if (event.key === 'Escape') setNaming(false);
                  }}
                  placeholder="Name this look"
                  data-tails-part="input"
                  className="min-w-0 flex-1 rounded border border-border px-2 py-1 outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={!name.trim()}
                  aria-label="Save look"
                  className="rounded p-1.5 transition-colors duration-quick hover:bg-muted/50 disabled:opacity-40"
                >
                  <Check className="size-3.5" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setNaming(true)}
                  className="flex-1 rounded border border-border px-2 py-1 transition-colors duration-quick hover:bg-muted/50"
                >
                  Save as preset
                </button>
                <button
                  type="button"
                  onClick={undo}
                  disabled={depth === 0}
                  title={depth === 0 ? 'Nothing to undo' : 'Back one step'}
                  aria-label="Undo the last appearance change"
                  className="rounded border border-border p-1.5 transition-colors duration-quick hover:bg-muted/50 disabled:opacity-40"
                >
                  <Undo2 className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={reset}
                  className="rounded border border-border px-2 py-1 transition-colors duration-quick hover:bg-muted/50"
                >
                  Reset
                </button>
              </div>
            )}

            {note ? <p className="ink-muted">{note}</p> : null}
          </div>
        ) : null}
      </div>
    </>
  );
}

type ControlProps = {
  control: AppearanceControl;
  value: number | boolean | string;
  onChange: (value: number | boolean | string) => void;
};

function Control({ control, value, onChange }: ControlProps) {
  return (
    <label className="block space-y-1">
      <span className="flex items-center justify-between gap-2">
        <span className="truncate">{control.label}</span>
        {control.kind === 'slider' ? (
          <span className="ink-muted tabular-nums">{`${value as number}${control.unit ?? ''}`}</span>
        ) : null}
      </span>

      {control.kind === 'slider' ? (
        <input
          type="range"
          min={control.min}
          max={control.max}
          step={control.step}
          value={value as number}
          // `input` rather than `change`: a range fires `change` on release, and
          // a slider that only repaints when you let go is not a live control.
          onChange={(event) => onChange(Number(event.target.value))}
          className="w-full accent-primary"
        />
      ) : null}

      {control.kind === 'toggle' ? (
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
          className="accent-primary"
        />
      ) : null}

      {control.kind === 'colour' ? (
        <input
          type="color"
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
          className="h-6 w-full cursor-pointer rounded border border-border bg-transparent"
        />
      ) : null}

      {control.kind === 'select' ? (
        <select
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
          data-tails-part="input"
          className="w-full rounded border border-border px-1 py-0.5 outline-none"
        >
          {(control.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      ) : null}

      {control.help ? <span className="ink-muted block">{control.help}</span> : null}
    </label>
  );
}
