import { Check, ChevronDown, Gauge } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import { EFFORT_LEVELS, type EffortLevel, type ModelChoice, type TurnSettings } from '@/types/chat';

/** Enough of a hint to choose without reading the docs, in the user's terms. */
const EFFORT_HINTS: Record<EffortLevel, string> = {
  low: 'Fastest, barely thinks',
  medium: 'Some thinking',
  high: 'Deep reasoning',
  xhigh: 'Deeper still',
  max: 'Everything it has',
};

type ModelPickerProps = {
  /** Everything the account may choose. Empty hides the control entirely. */
  models: ModelChoice[];
  /** What the CLI resolves to when nothing is chosen. */
  fallback: ModelChoice | null;
  settings: TurnSettings;
  onChange: (settings: TurnSettings) => void;
  disabled?: boolean;
};

/**
 * Picks the model and the effort for this conversation.
 *
 * One popover rather than two chips beside the permission mode: three controls
 * in a row is more chrome than a composer can carry, and these two are one
 * decision anyway — the effort levels on offer depend on the model chosen.
 *
 * Both apply from the next message. A fresh CLI is spawned per turn, so that
 * is the earliest either could take effect, and the footer says so rather than
 * letting the control imply it reaches back into a turn already running.
 */
export function ModelPicker({ models, fallback, settings, onChange, disabled }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node | null)) setOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // Nothing to offer means the catalogue could not be read. An empty picker
  // would be worse than none, for the same reason the badge hides itself.
  if (models.length === 0) return null;

  const selected = settings.model
    ? models.find((entry) => entry.id === settings.model) ?? null
    : null;
  // Effort belongs to whichever model will actually run.
  const effective = selected ?? fallback;
  const effortLevels = effective?.effortLevels ?? [];
  const supportsEffort = effortLevels.length > 0;

  const label = selected?.displayName ?? fallback?.displayName ?? 'Model';
  const effortLabel = settings.effort ?? null;

  const choose = (next: TurnSettings) => {
    // Dropping an effort the incoming model cannot do, rather than sending it
    // and having the server refuse: the picker should not offer, then retract.
    const levels = next.model
      ? models.find((entry) => entry.id === next.model)?.effortLevels ?? []
      : fallback?.effortLevels ?? [];
    const effort = next.effort && levels.includes(next.effort) ? next.effort : undefined;
    onChange({ ...(next.model ? { model: next.model } : {}), ...(effort ? { effort } : {}) });
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Model and effort for this conversation"
        className={cn(
          'flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors duration-quick',
          'hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:outline-none',
          open && 'bg-accent text-foreground',
          disabled && 'opacity-50',
        )}
      >
        <Gauge className="size-3" aria-hidden="true" />
        <span className="max-w-[10rem] truncate">{label}</span>
        {effortLabel ? <span className="text-muted-foreground/70">· {effortLabel}</span> : null}
        <ChevronDown className={cn('size-3 transition-transform duration-quick', open && 'rotate-180')} />
      </button>

      {open ? (
        <div
          role="menu"
          data-tails-part="popover"
          style={{ '--t-radius': 'var(--radius)' } as React.CSSProperties}
          className="animate-scale-in absolute bottom-full left-0 z-30 mb-2 w-72 overflow-hidden py-1 shadow-lg"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            setOpen(false);
            triggerRef.current?.focus();
          }}
        >
          <p className="px-3 pb-1 pt-1.5 text-[10px] uppercase tracking-wide text-muted-foreground/70">
            Model
          </p>

          {/* Choosing nothing is how you go back to the configured default —
              clearer than offering the CLI's own "Default (recommended)" row
              alongside the model it points at. */}
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!settings.model}
            onClick={() => choose({ ...(settings.effort ? { effort: settings.effort } : {}) })}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors duration-instant hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
          >
            <Check className={cn('size-3.5 shrink-0', settings.model && 'invisible')} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">
              Default
              {fallback ? <span className="text-muted-foreground"> · {fallback.displayName}</span> : null}
            </span>
          </button>

          {models.map((model) => (
            <button
              key={model.id}
              type="button"
              role="menuitemradio"
              aria-checked={settings.model === model.id}
              onClick={() => choose({ model: model.id, ...(settings.effort ? { effort: settings.effort } : {}) })}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors duration-instant hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
            >
              <Check
                className={cn('size-3.5 shrink-0', settings.model !== model.id && 'invisible')}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate">{model.displayName}</span>
            </button>
          ))}

          <div className="my-1 h-px bg-border" role="separator" />

          <p className="px-3 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
            Effort
          </p>

          {supportsEffort ? (
            <>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={!settings.effort}
                onClick={() => choose({ ...(settings.model ? { model: settings.model } : {}) })}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors duration-instant hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              >
                <Check className={cn('size-3.5 shrink-0', settings.effort && 'invisible')} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">Default</span>
              </button>

              {EFFORT_LEVELS.filter((level) => effortLevels.includes(level)).map((level) => (
                <button
                  key={level}
                  type="button"
                  role="menuitemradio"
                  aria-checked={settings.effort === level}
                  onClick={() => choose({ ...(settings.model ? { model: settings.model } : {}), effort: level })}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors duration-instant hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                >
                  <Check
                    className={cn('size-3.5 shrink-0', settings.effort !== level && 'invisible')}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">{level}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{EFFORT_HINTS[level]}</span>
                </button>
              ))}
            </>
          ) : (
            // Said plainly rather than shown greyed out: this model has no
            // effort control at all, which is different from having one set low.
            <p className="px-3 pb-1.5 text-xs text-muted-foreground">
              {effective?.displayName ?? 'This model'} has no effort setting.
            </p>
          )}

          <div className="my-1 h-px bg-border" role="separator" />
          <p className="px-3 pb-1 text-[11px] text-muted-foreground">
            Applies from your next message.
          </p>
        </div>
      ) : null}
    </div>
  );
}
