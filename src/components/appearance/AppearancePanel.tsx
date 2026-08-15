import { Check, ChevronDown, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  clearLiveTokens,
  readLiveTokens,
  setLiveToken,
  writeLiveTokens,
} from '@/components/appearance/liveTokens';
import { startPointerTokens } from '@/components/appearance/pointerTokens';
import { ThemeProposal, type ProposalVariant } from '@/components/appearance/ThemeProposal';
import { useWebSocket } from '@/contexts/WebSocketContext';
import { applyFreeformCss, applyTheme, clearTheme, type AppearancePayload } from '@/theme/applyTheme';

/**
 * The appearance panel: the knobs the agent published, and the way back.
 *
 * Two things live here because they answer the same question — "the app just
 * changed, now what?" — and splitting them would mean the answer is only
 * available half the time.
 *
 * **The controls the agent invented.** Not a fixed settings page: after the
 * model builds a look it publishes the knobs *for that look*, because only
 * whoever built the thing knows what is worth adjusting. Each binds a CSS
 * custom property, so dragging one is a paint rather than a request — no
 * confirm step, no round trip, no re-derivation. See `liveTokens.ts` for the
 * mechanism.
 *
 * **Save, undo, reset.** Before this, a look landed and the only way back was
 * knowing to reload the window, which is knowledge the app never gave anyone.
 * All three are shown on *any* appearance change, including one that published
 * no controls at all — a `theme_apply` with no panel was exactly the case where
 * the user was most stranded, so gating the escape hatch on the agent having
 * remembered to publish knobs would have missed the point.
 *
 * Undo walks a short in-memory stack of prior states rather than jumping to the
 * default. "Back one step" and "back to the beginning" are different requests
 * and a single button cannot be both; iterating on a look means the interesting
 * previous state is almost never the built-in ramp.
 */

/** Mirrors `server/modules/appearance/controls.ts`. Kept in step by hand, like `types/chat.ts`. */
export type AppearanceControl =
  | {
    kind: 'slider'; id: string; label: string; binds: string; help?: string;
    min: number; max: number; step: number; unit: string; value: number;
  }
  | { kind: 'toggle'; id: string; label: string; binds: string; help?: string; on: string; off: string; value: boolean }
  | { kind: 'colour'; id: string; label: string; binds: string; help?: string; value: string }
  | {
    kind: 'select'; id: string; label: string; binds: string; help?: string;
    options: { label: string; value: string }[]; value: string;
  };

/** Everything that has to be restored together for "undo" to mean anything. */
type Snapshot = {
  theme: AppearancePayload | null;
  css: string;
  controls: AppearanceControl[];
  title: string;
  tokens: Record<string, string>;
};

/**
 * How far back undo reaches.
 *
 * Deep enough to walk out of an iteration the user did not like, shallow enough
 * that the stack is not quietly holding a dozen full stylesheets in memory for
 * the rest of the session.
 */
const HISTORY_LIMIT = 12;

const EMPTY: Snapshot = { theme: null, css: '', controls: [], title: '', tokens: {} };

/** The CSS text a control writes for a given UI value. */
const tokenValue = (control: AppearanceControl, value: number | boolean | string): string => {
  if (control.kind === 'slider') return `${value as number}${control.unit}`;
  if (control.kind === 'toggle') return value ? control.on : control.off;
  return String(value);
};

type AppearancePanelProps = { sessionId: string | null };

export function AppearancePanel({ sessionId }: AppearancePanelProps) {
  const { subscribe } = useWebSocket();

  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [values, setValues] = useState<Record<string, number | boolean | string>>({});
  const [depth, setDepth] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [proposal, setProposal] = useState<ProposalVariant[]>([]);

  // The stack is a ref, not state: pushing to it must not re-render, and the
  // only thing the UI needs from it is its depth, which is tracked separately.
  const historyRef = useRef<Snapshot[]>([]);
  const snapshotRef = useRef<Snapshot>(EMPTY);

  const commit = useCallback((next: Snapshot, remember = true) => {
    if (remember) {
      historyRef.current = [...historyRef.current, snapshotRef.current].slice(-HISTORY_LIMIT);
      setDepth(historyRef.current.length);
    }
    snapshotRef.current = next;
    setSnapshot(next);
    setValues(Object.fromEntries(next.controls.map((control) => [control.id, control.value])));
    setNote(null);
    setNaming(false);
    setDismissed(false);
    setTouched(true);
  }, []);

  useEffect(() => startPointerTokens(), []);

  useEffect(() => subscribe((message) => {
    if (message.kind !== 'appearance_changed') return;

    const payload = message.appearance as (AppearancePayload & {
      layer?: string;
      scope?: string;
      scopeKey?: string;
      controls?: AppearanceControl[];
      variants?: ProposalVariant[];
    }) | undefined;
    if (!payload) return;

    const isForThisWindow = payload.scope !== 'session'
      || !payload.scopeKey
      || payload.scopeKey === sessionId;
    if (!isForThisWindow) return;

    const current = snapshotRef.current;

    // A proposal changes nothing about the running app, so it is not a state
    // anyone would want to undo back into — it stays off the history stack.
    if (payload.layer === 'proposal') {
      setProposal(payload.variants ?? []);
      return;
    }

    if (payload.layer === 'controls') {
      commit({ ...current, controls: payload.controls ?? [], title: payload.name || 'Adjust' });
      return;
    }

    if (payload.layer === 'css') {
      commit({ ...current, css: payload.css });
      return;
    }

    if (payload.layer !== 'theme') return;

    // A new theme retires the previous look's knobs along with the values that
    // were tuned for it. A slider left behind would still move — it would just
    // be writing a property the new stylesheet never reads, which is the "knob
    // that does nothing" failure the whole engine was rebuilt to remove.
    clearLiveTokens();
    // A theme landing is the decision the comparison was asking about, so the
    // comparison has done its job and goes away without being clicked.
    setProposal([]);
    commit({
      theme: payload.css ? payload : null,
      css: current.css,
      controls: [],
      title: '',
      tokens: {},
    });
  }), [subscribe, sessionId, commit]);

  const onControlChange = useCallback((control: AppearanceControl, value: number | boolean | string) => {
    setValues((current) => ({ ...current, [control.id]: value }));
    setLiveToken(control.binds, tokenValue(control, value));
    // Knob positions are folded into the *current* snapshot rather than pushed
    // as a new one. Otherwise a single slider drag would bury the state the
    // user actually wants to undo to under sixty intermediate frames.
    snapshotRef.current = { ...snapshotRef.current, tokens: readLiveTokens() };
  }, []);

  const undo = useCallback(() => {
    const previous = historyRef.current.pop();
    if (!previous) return;
    setDepth(historyRef.current.length);

    if (previous.theme) void applyTheme(previous.theme);
    else clearTheme();
    applyFreeformCss(previous.css);
    writeLiveTokens(previous.tokens);

    snapshotRef.current = previous;
    setSnapshot(previous);
    setValues(Object.fromEntries(previous.controls.map((control) => [control.id, control.value])));
    setNote(null);
    window.dispatchEvent(new CustomEvent('tails:appearance-changed'));
  }, []);

  const reset = useCallback(() => {
    // Pushed first, so "reset" is itself undoable — the button is one click
    // away from the panel's other two and the cost of a misclick should not be
    // the look the user was iterating on.
    commit({ ...EMPTY }, true);

    clearTheme();
    applyFreeformCss('');
    clearLiveTokens();

    // The bindings go too, or the look returns on the next reload and the
    // button turns out to have meant "until you restart".
    for (const scope of ['global', 'session'] as const) {
      void fetch('/api/appearance/unbind', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope, sessionId }),
      }).catch(() => undefined);
    }

    window.dispatchEvent(new CustomEvent('tails:appearance-changed'));
    setNote('Back to the built-in look.');
  }, [commit, sessionId]);

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

  // Nothing has changed yet, so there is nothing to undo, save or reset. The
  // panel earns its place by appearing at the moment it becomes useful — but a
  // proposal can be on screen before anything has been applied at all.
  if (!touched || dismissed) {
    return proposal.length > 0
      ? <ThemeProposal variants={proposal} onDismiss={() => setProposal([])} />
      : null;
  }

  return (
    <>
      <ThemeProposal variants={proposal} onDismiss={() => setProposal([])} />
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
          <span className="truncate">{snapshot.title || 'Appearance'}</span>
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
          {snapshot.controls.map((control) => (
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
          <span className="ink-muted tabular-nums">{`${value as number}${control.unit}`}</span>
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
          {control.options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      ) : null}

      {control.help ? <span className="ink-muted block">{control.help}</span> : null}
    </label>
  );
}
