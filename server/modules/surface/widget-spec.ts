import { z } from 'zod';

import { AppError } from '@/shared/utils.js';

/**
 * What the agent may put on a surface.
 *
 * The appearance module lets the agent change how everything in this app
 * *looks*. Nothing lets it change what anything *does* — every result it
 * produces is either prose in the transcript, a preview pane it cannot see, or
 * a terminal it cannot reach. "Watch this and tell me when it changes" comes
 * back as a paragraph promising to watch.
 *
 * A surface is the missing third thing: a small panel the agent composes out of
 * parts this app already knows how to draw.
 *
 * ## The security model in one line
 *
 * **The agent names a widget kind; the app decides what that kind draws.**
 *
 * The same doctrine as the theme spec, and for the same reason — but note where
 * the two deliberately diverge. Appearance has a freeform escape hatch, because
 * CSS can be parsed, walked, and re-serialised from its own AST until nothing
 * of the model's bytes survives. **There is no freeform widget.** Markup cannot
 * be made harmless that way: a stylesheet that tries to impersonate a
 * permission prompt is stopped by refusing selectors that name
 * `[data-tails-critical]`, and no rule of that shape stops a *convincing
 * replica* of one built out of divs. So if a kind is missing, the right answer
 * is to say which — the same answer `theme_list` insists on for a missing
 * primitive.
 *
 * Concretely:
 *
 * - `WidgetKind` is a closed union, and the renderer registry is keyed by the
 *   same union, so adding a kind without a renderer is a compile error rather
 *   than a blank panel.
 * - Tone is an enum mapped to theme tokens, never a colour. A widget therefore
 *   inherits whatever look the appearance system last invented, and cannot
 *   break its own contrast or escape the user's colour-mode choice.
 * - Text is stripped of control characters and bidirectional overrides. Markup
 *   characters are left alone on purpose: the renderer sets text through React
 *   children and never `innerHTML`, so `<` is a character. The defence is the
 *   renderer, not the escaping.
 * - Ids are assigned server-side, so a generated widget cannot collide with or
 *   masquerade as one already on the surface.
 *
 * ## Limits reject, they do not truncate
 *
 * Every cap below fails loudly, and validation reports **every** bad field in
 * one pass with dotted paths. An agent that overshoots should learn that it
 * overshot; silently losing half a table is worse than an error it can correct,
 * and one error per round trip is worse than one round trip.
 *
 * ## Deliberately absent for now
 *
 * - **`form`** and any other widget that sends something back. Interaction
 *   means a widget can start a turn, which is a different capability with a
 *   different set of questions, and bolting it onto a read-only contract is how
 *   it would get answered by accident.
 * - **`gallery`**. Remote images are the point of a gallery and this app refuses
 *   remote content elsewhere on purpose — see `preview.tools.ts`, which will not
 *   even frame a non-loopback URL, partly because the app promises that voice
 *   never leaves the machine. Loading pictures from the internet into the app
 *   window is a real decision about network egress and beacons, and it should be
 *   made deliberately rather than inherited from a widget list.
 */

/** Every kind the app can draw. Adding one here means adding a renderer. */
export const WIDGET_KINDS = [
  'stat', 'chart', 'table', 'checklist', 'timeline', 'progress', 'note', 'monitor',
] as const;
export type WidgetKind = typeof WIDGET_KINDS[number];

/**
 * Meaning, not colour.
 *
 * The renderer maps each of these to theme tokens. A widget that could name a
 * colour would be a widget that looks wrong in every look the user asks for
 * after the one it was written in.
 */
export const TONES = ['neutral', 'positive', 'warning', 'danger', 'accent'] as const;
export type Tone = typeof TONES[number];

/** What a monitor is currently reporting. `match` is the one that celebrates. */
export const MONITOR_STATUSES = ['idle', 'watching', 'match', 'error'] as const;

export const LIMITS = {
  widgets: 12,
  title: 60,
  label: 80,
  text: 500,
  rows: 100,
  columns: 8,
  items: 50,
  series: 24,
} as const;

/**
 * Removes what text should never carry, and nothing else.
 *
 * Control characters break layout and logs. Bidirectional overrides are the
 * interesting one: they let a string render in an order its characters do not
 * have, which is how a label can read as one thing on screen and be another in
 * the data. Tabs and newlines survive, because a note is allowed to have lines.
 */
function cleanText(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex -- removing them is the point
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
    .trim();
}

const text = (max: number) => z.string().max(max).transform(cleanText);
const title = text(LIMITS.title).optional();
const tone = z.enum(TONES).optional();

const statWidget = z.object({
  kind: z.literal('stat'),
  label: text(LIMITS.label),
  /**
   * A string, always — including for numbers.
   *
   * The agent knows how the figure should read ("1,284", "3.2 s", "£11.40") and
   * the app does not. Taking a number here would mean this app choosing a
   * locale, a unit and a precision for every value anything ever reports.
   */
  value: text(LIMITS.label),
  /** A change worth showing beside the value, e.g. "+12 today". */
  delta: text(LIMITS.label).optional(),
  hint: text(LIMITS.text).optional(),
  tone,
});

const chartWidget = z.object({
  kind: z.literal('chart'),
  title,
  /** Drawn as bars. Values are relative to the largest, so units are free. */
  series: z.array(z.object({
    label: text(LIMITS.label),
    value: z.number().finite(),
    tone,
  })).min(1).max(LIMITS.series),
  /** Shown beside each value, e.g. "ms". Never parsed. */
  unit: text(16).optional(),
});

const tableWidget = z.object({
  kind: z.literal('table'),
  title,
  columns: z.array(text(LIMITS.label)).min(1).max(LIMITS.columns),
  rows: z.array(z.array(text(LIMITS.text)).max(LIMITS.columns)).max(LIMITS.rows),
});

const checklistWidget = z.object({
  kind: z.literal('checklist'),
  title,
  items: z.array(z.object({
    label: text(LIMITS.text),
    done: z.boolean(),
    tone,
  })).min(1).max(LIMITS.items),
});

const timelineWidget = z.object({
  kind: z.literal('timeline'),
  title,
  events: z.array(z.object({
    label: text(LIMITS.label),
    /** Free text, e.g. "14:02" or "two minutes ago". Displayed, never parsed. */
    at: text(40).optional(),
    detail: text(LIMITS.text).optional(),
    tone,
  })).min(1).max(LIMITS.items),
});

const progressWidget = z.object({
  kind: z.literal('progress'),
  label: text(LIMITS.label),
  /** 0 to 1. Out of range is refused rather than clamped: a bar past its end is a bug worth reporting. */
  fraction: z.number().min(0).max(1),
  detail: text(LIMITS.text).optional(),
  tone,
});

const noteWidget = z.object({
  kind: z.literal('note'),
  title,
  /** Plain text. Rendered as text — this is not a markdown or HTML slot. */
  body: text(LIMITS.text),
  tone,
});

const monitorWidget = z.object({
  kind: z.literal('monitor'),
  label: text(LIMITS.label),
  status: z.enum(MONITOR_STATUSES),
  detail: text(LIMITS.text).optional(),
  /** What it has found so far. Newest first is the caller's business. */
  matches: z.array(text(LIMITS.text)).max(LIMITS.items).optional(),
});

const widgetSchema = z.discriminatedUnion('kind', [
  statWidget,
  chartWidget,
  tableWidget,
  checklistWidget,
  timelineWidget,
  progressWidget,
  noteWidget,
  monitorWidget,
]);

export const surfaceSchema = z.object({
  title: text(LIMITS.title),
  widgets: z.array(widgetSchema).min(1).max(LIMITS.widgets),
});

export type Widget = z.infer<typeof widgetSchema>;
export type SurfaceSpec = z.infer<typeof surfaceSchema>;

/** A widget once the server has given it an identity. */
export type IdentifiedWidget = Widget & { id: string };

/** A surface as the client receives it. */
export type Surface = {
  title: string;
  widgets: IdentifiedWidget[];
  /** Increments on every write, so a client can tell a redraw from a repeat. */
  revision: number;
};

/** Formats validation failures as dotted paths, the way the theme spec does. */
function toValidationError(issues: readonly { path: PropertyKey[]; message: string }[]): AppError {
  return new AppError('The surface did not match the schema.', {
    code: 'SURFACE_INVALID',
    statusCode: 422,
    details: issues.map((issue) => ({
      path: issue.path.map(String).join('.') || 'root',
      message: issue.message,
    })),
  });
}

/**
 * Validates a surface, reporting everything wrong with it at once.
 *
 * Throws rather than returning a result, because every caller — the tool and
 * the route — wants the same `AppError` and the alternative was each of them
 * building it from a `success: false` in a slightly different way.
 */
export function readSurfaceSpec(input: unknown): SurfaceSpec {
  const result = surfaceSchema.safeParse(input);
  if (!result.success) throw toValidationError(result.error.issues);
  return result.data;
}
