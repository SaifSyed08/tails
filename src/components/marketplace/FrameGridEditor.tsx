import { Loader2, Scan } from 'lucide-react';
import { useState } from 'react';

import { cn } from '@/lib/utils';

import { measureGrid } from './detect-grid';
import {
  PET_STATE_NAMES,
  type FrameGrid,
  type InstalledPet,
  type PetStateName,
  type PetStates,
} from './marketplace-api';
import { describeRangeFit, SpritePreview } from './SpritePreview';

/**
 * The frame-grid editor.
 *
 * This exists because the Codex spritesheet format does not describe its own
 * layout. The server measures what it can from the image dimensions and labels
 * the result a guess; this is where the user overrules it. Nothing here is a
 * power-user escape hatch — for any sheet that is not on the 192x208 Codex
 * pitch, this panel is the only thing that makes the pet render correctly.
 *
 * States are edited as "row plus frame count" rather than raw frame indices
 * because that is how these sheets are actually built — one animation per row,
 * ragged lengths — and because a range that stays inside a row is exactly the
 * range that `steps()` can play without approximation.
 */

type GridDraft = Record<'width' | 'height' | 'columns' | 'rows' | 'fps', string>;

type StateDraft = { enabled: boolean; row: number; count: string };

type FrameGridEditorProps = {
  pet: InstalledPet;
  onSave: (patch: { frame: FrameGrid; states: PetStates }) => Promise<void>;
  onCancel: () => void;
};

/** Drafts are held as text so a field can be empty mid-typing without snapping back to 0. */
const readNumber = (text: string, fallback: number, low: number, high: number): number => {
  const parsed = Number.parseFloat(text);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(high, Math.max(low, parsed));
};

const toGrid = (draft: GridDraft, fallback: FrameGrid): FrameGrid => ({
  width: Math.round(readNumber(draft.width, fallback.width, 1, 4096)),
  height: Math.round(readNumber(draft.height, fallback.height, 1, 4096)),
  columns: Math.round(readNumber(draft.columns, fallback.columns, 1, 256)),
  rows: Math.round(readNumber(draft.rows, fallback.rows, 1, 256)),
  fps: readNumber(draft.fps, fallback.fps, 0.5, 60),
});

const toStateDrafts = (states: PetStates, columns: number): Record<PetStateName, StateDraft> => {
  const entries = PET_STATE_NAMES.map((name) => {
    const range = states[name];
    if (!range) return [name, { enabled: false, row: 0, count: String(columns) }] as const;
    return [name, {
      enabled: true,
      row: Math.floor(range.start / Math.max(1, columns)),
      count: String(range.end - range.start + 1),
    }] as const;
  });

  return Object.fromEntries(entries) as Record<PetStateName, StateDraft>;
};

const toStates = (drafts: Record<PetStateName, StateDraft>, grid: FrameGrid): PetStates => {
  const lastFrame = grid.columns * grid.rows - 1;

  const build = (draft: StateDraft) => {
    const start = Math.min(lastFrame, draft.row * grid.columns);
    const count = Math.round(readNumber(draft.count, grid.columns, 1, lastFrame - start + 1));
    return { start, end: Math.min(lastFrame, start + count - 1) };
  };

  const states: PetStates = { idle: build(drafts.idle) };
  for (const name of PET_STATE_NAMES) {
    if (name === 'idle' || !drafts[name].enabled) continue;
    states[name] = build(drafts[name]);
  }
  return states;
};

/* Paired with `data-tails-part="input"` on every field that uses it — fill,
   border and radius come from the theme, so only layout survives here. */
const FIELD_CLASS = 'w-full px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-ring';

const GRID_FIELDS = [
  { key: 'width', label: 'Cell width', hint: 'px' },
  { key: 'height', label: 'Cell height', hint: 'px' },
  { key: 'columns', label: 'Columns', hint: 'cells across' },
  { key: 'rows', label: 'Rows', hint: 'cells down' },
  { key: 'fps', label: 'Speed', hint: 'frames / sec' },
] as const;

export function FrameGridEditor({ pet, onSave, onCancel }: FrameGridEditorProps) {
  const original = pet.definition.frame;

  const [draft, setDraft] = useState<GridDraft>(() => ({
    width: String(original.width),
    height: String(original.height),
    columns: String(original.columns),
    rows: String(original.rows),
    fps: String(original.fps),
  }));

  const grid = toGrid(draft, original);

  const [stateDrafts, setStateDrafts] = useState(
    () => toStateDrafts(pet.definition.states, original.columns),
  );
  const [previewState, setPreviewState] = useState<PetStateName>('idle');
  const [rowUsage, setRowUsage] = useState<number[] | null>(null);
  const [measureNote, setMeasureNote] = useState<string | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const states = toStates(stateDrafts, grid);
  const previewRange = states[previewState] ?? states.idle;
  const fitWarning = describeRangeFit(grid, previewRange);

  const setField = (key: keyof GridDraft, value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const setStateField = (name: PetStateName, patch: Partial<StateDraft>) =>
    setStateDrafts((current) => ({ ...current, [name]: { ...current[name], ...patch } }));

  /**
   * Measures the real grid from the sprite's pixels.
   *
   * The browser can do what the server cannot — decode the image — so this is a
   * measurement rather than another guess, and it is what turned an
   * undocumented format into a known one in the first place.
   */
  const runMeasurement = async () => {
    setMeasuring(true);
    setError(null);
    try {
      const measured = await measureGrid(pet.spriteUrl);
      setDraft((current) => ({
        ...current,
        width: String(measured.grid.width),
        height: String(measured.grid.height),
        columns: String(measured.grid.columns),
        rows: String(measured.grid.rows),
      }));
      setRowUsage(measured.rowUsage);
      setMeasureNote(measured.note);
    } catch (measureError) {
      setMeasureNote(null);
      setError(measureError instanceof Error ? measureError.message : 'The sheet could not be measured.');
    } finally {
      setMeasuring(false);
    }
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave({ frame: grid, states });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'That did not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-tails-part="card" className="space-y-4 p-3">
      <div>
        <h4 className="text-sm font-semibold">Frame layout</h4>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Codex spritesheets do not record how they are cut up, so this grid was inferred. If the
          preview slides or shows half a pet, correct it here.
        </p>
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-card p-3">
          <SpritePreview
            spriteUrl={pet.spriteUrl}
            grid={grid}
            range={previewRange}
            height={104}
          />
          <select
            value={previewState}
            onChange={(event) => setPreviewState(event.target.value as PetStateName)}
            aria-label="Preview which animation"
            className="rounded-md border border-border bg-background px-1.5 py-0.5 text-xs"
          >
            {PET_STATE_NAMES.filter((name) => states[name]).map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </div>

        <div className="grid min-w-[16rem] flex-1 grid-cols-2 gap-2 sm:grid-cols-3">
          {GRID_FIELDS.map((field) => (
            <label key={field.key} className="block">
              <span className="block text-[11px] font-medium text-muted-foreground">
                {field.label}
              </span>
              <input
                type="number"
                inputMode="decimal"
                min={field.key === 'fps' ? 0.5 : 1}
                value={draft[field.key]}
                onChange={(event) => setField(field.key, event.target.value)}
                data-tails-part="input"
                className={FIELD_CLASS}
              />
              <span className="mt-0.5 block text-[10px] text-muted-foreground">{field.hint}</span>
            </label>
          ))}

          <div className="col-span-2 flex items-end sm:col-span-1">
            <button
              type="button"
              onClick={() => void runMeasurement()}
              disabled={measuring}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-xs transition-colors duration-quick hover:bg-accent disabled:opacity-60"
            >
              {measuring
                ? <Loader2 className="size-3.5 animate-spin" />
                : <Scan className="size-3.5" />}
              Measure from image
            </button>
          </div>
        </div>
      </div>

      {measureNote ? (
        <p className="rounded-md bg-positive/10 px-2.5 py-1.5 text-xs text-positive">{measureNote}</p>
      ) : null}

      <div className="space-y-2 border-t border-border pt-3">
        <div>
          <h4 className="text-sm font-semibold">Animations</h4>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Each row of the sheet is one animation, but nothing in the file says which is which.
            Pick the row for each state and how many of its frames are used.
          </p>
        </div>

        {PET_STATE_NAMES.map((name) => {
          const stateDraft = stateDrafts[name];
          const isIdle = name === 'idle';

          return (
            <div key={name} className="flex flex-wrap items-center gap-2 text-xs">
              <label className="flex w-20 items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={isIdle || stateDraft.enabled}
                  disabled={isIdle}
                  onChange={(event) => setStateField(name, { enabled: event.target.checked })}
                  className="size-3.5 accent-primary"
                />
                <span className={cn('capitalize', !isIdle && !stateDraft.enabled && 'text-muted-foreground')}>
                  {name}
                </span>
              </label>

              <select
                value={Math.min(stateDraft.row, grid.rows - 1)}
                disabled={!isIdle && !stateDraft.enabled}
                onChange={(event) => setStateField(name, { row: Number(event.target.value) })}
                aria-label={`Row for ${name}`}
                className="rounded-md border border-border bg-background px-1.5 py-1 disabled:opacity-50"
              >
                {Array.from({ length: grid.rows }, (_unused, row) => (
                  <option key={row} value={row}>
                    Row {row + 1}
                    {rowUsage?.[row] ? ` — ${rowUsage[row]} frames` : ''}
                  </option>
                ))}
              </select>

              <label className="flex items-center gap-1.5">
                <span className="text-muted-foreground">frames</span>
                <input
                  type="number"
                  min={1}
                  max={grid.columns * grid.rows}
                  value={stateDraft.count}
                  disabled={!isIdle && !stateDraft.enabled}
                  onChange={(event) => setStateField(name, { count: event.target.value })}
                  aria-label={`Frame count for ${name}`}
                  data-tails-part="input"
                  className="w-16 px-1.5 py-1 disabled:opacity-50"
                />
              </label>

              {rowUsage?.[Math.min(stateDraft.row, grid.rows - 1)] ? (
                <button
                  type="button"
                  onClick={() => setStateField(name, {
                    count: String(rowUsage[Math.min(stateDraft.row, grid.rows - 1)]),
                  })}
                  className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
                >
                  use measured
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      {fitWarning ? (
        <p className="rounded-md bg-warning/10 px-2.5 py-1.5 text-xs text-warning">{fitWarning}</p>
      ) : null}

      {error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border px-2.5 py-1.5 text-xs transition-colors duration-quick hover:bg-accent"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={saving}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-transform duration-instant ease-emphasis active:scale-95 disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'Save layout'}
        </button>
      </div>
    </div>
  );
}
