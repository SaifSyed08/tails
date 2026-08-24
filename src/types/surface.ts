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

/**
 * The icons a widget may name.
 *
 * Mirrors `server/modules/surface/icons.ts`, which is the authority and carries
 * the reasoning for why the list is a curated hundred rather than the library's
 * five thousand. Restated here so the renderer's mapping can be a total record
 * over it — a name the server can send and this side cannot draw is then a
 * compile error rather than a gap in a panel.
 */
export const WIDGET_ICONS = [
  'check', 'x', 'triangle-alert', 'circle-alert', 'circle-check', 'circle-x',
  'info', 'circle-help', 'ban', 'clock', 'hourglass', 'trending-up',
  'trending-down', 'arrow-up', 'arrow-down', 'arrow-right', 'minus', 'plus',
  'code', 'terminal', 'git-branch', 'git-commit-horizontal', 'git-merge', 'git-pull-request',
  'bug', 'package', 'box', 'layers', 'database', 'server',
  'cpu', 'hard-drive', 'cloud', 'cloud-off', 'file', 'file-text',
  'file-code', 'folder', 'folder-open', 'save', 'download', 'upload',
  'trash2', 'copy', 'mail', 'message-square', 'bell', 'bell-off',
  'send', 'share2', 'user', 'users', 'user-check', 'heart',
  'star', 'thumbs-up', 'thumbs-down', 'dollar-sign', 'credit-card', 'receipt',
  'wallet', 'coins', 'calendar', 'timer', 'history', 'refresh-cw',
  'play', 'pause', 'square', 'skip-forward', 'globe', 'link',
  'search', 'filter', 'eye', 'eye-off', 'lock', 'unlock',
  'key', 'shield', 'zap', 'flame', 'sparkles', 'wand2',
  'lightbulb', 'target', 'flag', 'map-pin', 'compass', 'gauge',
  'activity', 'chart-bar', 'chart-pie', 'list', 'grid3x3', 'settings',
  'sliders-horizontal', 'wrench', 'rocket', 'coffee', 'moon', 'sun',
  'cloud-rain', 'leaf', 'music', 'image', 'camera', 'mic',
  'volume2', 'bookmark', 'pin', 'tag', 'inbox', 'archive',
  'external-link',
] as const;

export type WidgetIcon = typeof WIDGET_ICONS[number];

export type Widget =
  | {
    kind: 'stat';
    label: string;
    value: string;
    delta?: string;
    hint?: string;
    tone?: Tone;
    icon?: WidgetIcon;
  }
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
    items: { label: string; done: boolean; tone?: Tone; icon?: WidgetIcon }[];
  }
  | {
    kind: 'timeline';
    title?: string;
    events: { label: string; at?: string; detail?: string; tone?: Tone; icon?: WidgetIcon }[];
  }
  | { kind: 'progress'; label: string; fraction: number; detail?: string; tone?: Tone }
  | { kind: 'note'; title?: string; body: string; tone?: Tone; icon?: WidgetIcon }
  | {
    kind: 'monitor';
    label: string;
    status: MonitorStatus;
    detail?: string;
    matches?: string[];
    /*
      A monitor may also carry a `watch`, which is what keeps it updating after
      the turn ends. It is deliberately not declared here: the client never
      renders it and never sends it, and a field in this type is a claim that
      something on this side reads it. The server owns watching entirely — what
      arrives here is only ever the result.
    */
  };

/** A widget once the server has given it an identity. Ids are never generated here. */
export type IdentifiedWidget = Widget & { id: string };

export type Surface = {
  title: string;
  widgets: IdentifiedWidget[];
  /** Increments on every write, so a redraw can be told from a repeat. */
  revision: number;
};
