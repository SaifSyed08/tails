/**
 * A generated panel, as the client receives it.
 *
 * Mirrors `server/modules/surface/widget-spec.ts`, which is the authority: it
 * validates, it assigns ids, and it is what refuses a kind the app cannot draw.
 * This file is the same union stated for the renderer, in the same arrangement
 * `src/types/chat.ts` has with the server's message types.
 *
 * Keeping the two in step is not left to care. `WIDGET_KINDS` here and the
 * renderer registry in `Widgets.tsx` are keyed by the same union, so a kind
 * added on the server and forgotten here fails to render *loudly*: the registry
 * lookup is exhaustive and the compiler says which one is missing.
 */

export const WIDGET_KINDS = [
  'stat', 'chart', 'table', 'checklist', 'timeline', 'progress', 'note', 'monitor',
] as const;
export type WidgetKind = typeof WIDGET_KINDS[number];

/**
 * Meaning, resolved to theme tokens by the renderer.
 *
 * Every one of these maps to a colour the appearance pipeline derives and
 * contrast-solves — `--positive`, `--warning`, `--destructive`, `--primary`.
 * That is what makes a widget follow whatever look the agent last invented
 * instead of sitting in it like a foreign object.
 */
export type Tone = 'neutral' | 'positive' | 'warning' | 'danger' | 'accent';

export type MonitorStatus = 'idle' | 'watching' | 'match' | 'error';

export type Widget =
  | { kind: 'stat'; label: string; value: string; delta?: string; hint?: string; tone?: Tone }
  | {
    kind: 'chart';
    title?: string;
    series: { label: string; value: number; tone?: Tone }[];
    unit?: string;
  }
  | { kind: 'table'; title?: string; columns: string[]; rows: string[][] }
  | {
    kind: 'checklist';
    title?: string;
    items: { label: string; done: boolean; tone?: Tone }[];
  }
  | {
    kind: 'timeline';
    title?: string;
    events: { label: string; at?: string; detail?: string; tone?: Tone }[];
  }
  | { kind: 'progress'; label: string; fraction: number; detail?: string; tone?: Tone }
  | { kind: 'note'; title?: string; body: string; tone?: Tone }
  | {
    kind: 'monitor';
    label: string;
    status: MonitorStatus;
    detail?: string;
    matches?: string[];
  };

/** A widget once the server has given it an identity. Ids are never generated here. */
export type IdentifiedWidget = Widget & { id: string };

export type Surface = {
  title: string;
  widgets: IdentifiedWidget[];
  /** Increments on every write, so a redraw can be told from a repeat. */
  revision: number;
};
