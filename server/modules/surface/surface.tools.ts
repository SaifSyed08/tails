import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { surfaceService } from '@/modules/surface/surface.service.js';
import { LIMITS, MONITOR_STATUSES, TONES } from '@/modules/surface/widget-spec.js';
import { AppError } from '@/shared/utils.js';

/**
 * Letting the agent build a panel instead of describing one.
 *
 * The schemas here are the documentation. A model never reads this file and
 * reads every `.describe()` in it, which is the same bet `appearance.tools.ts`
 * makes — and the failure mode it names applies twice over here: a capability
 * the model is not told the shape of is a capability it will answer with prose.
 *
 * Nothing here can start a turn or run a command. A surface is data the app
 * already knows how to draw — see `widget-spec.ts` for why there is no freeform
 * widget and never will be one. The single exception to "it only draws" is a
 * monitor's `watch`, which polls a loopback address or a file on a timer; both
 * are read-only, and `bindings.ts` says why the obvious third source is absent.
 */

const textResult = (payload: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

/**
 * Formats a rejection so the model can correct it inside the same turn.
 *
 * The dotted-path issues rather than a sentence, so a generation with four bad
 * fields costs one revision rather than four round trips.
 */
const failureResult = (error: unknown) => {
  if (error instanceof AppError) {
    return textResult({ ok: false, error: error.message, issues: error.details }, true);
  }
  return textResult(
    { ok: false, error: error instanceof Error ? error.message : String(error) },
    true,
  );
};

const tone = z.enum(TONES).optional()
  .describe('What the value means, never what colour it is: neutral, positive, warning, danger, accent. It resolves to the user\'s current theme, so a widget stays readable in whatever look they are running.');

/*
  The widget shapes, restated for the tool boundary.

  Duplicated from `widget-spec.ts` on purpose. That file is the guard — it runs
  on every write, including from the HTTP route — and this one is the teaching
  surface, where every field carries the sentence that tells a model when to
  reach for it. Merging them would mean either a validator carrying prose or a
  tool description carrying none, and the second is how a capability goes unused.
*/
const widget = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('stat'),
    label: z.string().describe('What the number is, e.g. "Tests passing".'),
    value: z.string().describe('The figure, already formatted: "1,284", "3.2 s", "£11.40". You know the unit and the precision; the app does not.'),
    delta: z.string().optional().describe('A change worth showing beside it, e.g. "+12 today".'),
    hint: z.string().optional().describe('One line under the value, for the caveat a number needs.'),
    tone,
  }),
  z.object({
    kind: z.literal('chart'),
    title: z.string().optional(),
    series: z.array(z.object({
      label: z.string(),
      value: z.number(),
      tone,
    })).describe('Drawn as horizontal bars, scaled to the largest value. For comparing a handful of things, not for a time series with hundreds of points.'),
    unit: z.string().optional().describe('Shown after each value, e.g. "ms".'),
  }),
  z.object({
    kind: z.literal('table'),
    title: z.string().optional(),
    columns: z.array(z.string()),
    rows: z.array(z.array(z.string())).describe('One array per row, in column order. Ragged rows are allowed; short ones are drawn blank.'),
  }),
  z.object({
    kind: z.literal('checklist'),
    title: z.string().optional(),
    items: z.array(z.object({ label: z.string(), done: z.boolean(), tone })),
  }).describe('Progress through named steps. This is for showing state, not for collecting it — the user cannot tick these.'),
  z.object({
    kind: z.literal('timeline'),
    title: z.string().optional(),
    events: z.array(z.object({
      label: z.string(),
      at: z.string().optional().describe('Free text: "14:02", "two minutes ago". Displayed exactly as written and never parsed.'),
      detail: z.string().optional(),
      tone,
    })),
  }),
  z.object({
    kind: z.literal('progress'),
    label: z.string(),
    fraction: z.number().describe('Between 0 and 1. Out of range is refused rather than clamped.'),
    detail: z.string().optional(),
    tone,
  }),
  z.object({
    kind: z.literal('note'),
    title: z.string().optional(),
    body: z.string().describe('Plain text, drawn as text. Not markdown, and not a place to reproduce something the transcript already says better.'),
    tone,
  }),
  z.object({
    kind: z.literal('monitor'),
    label: z.string().describe('What is being watched, e.g. "Listings under £400".'),
    status: z.enum(MONITOR_STATUSES).describe('idle before you start, watching while you look, match when you find something — which flashes the panel and chimes — and error when you cannot carry on.'),
    detail: z.string().optional().describe('Where the search has got to, e.g. "checked 40 of 120".'),
    matches: z.array(z.string()).optional().describe('What you have found so far.'),
    watch: z.discriminatedUnion('source', [
      z.object({
        source: z.literal('http'),
        url: z.string().describe('A loopback address only — localhost or 127.0.0.1. Anything else is refused, the same as the preview pane.'),
        expect: z.string().optional().describe('A phrase to look for in the response. Finding it flips the monitor to "match", which flashes the panel and chimes.'),
        everyMs: z.number().optional().describe('How often to look, 2000 to 300000. Defaults to 5000.'),
      }),
      z.object({
        source: z.literal('file'),
        path: z.string().describe('A file or folder. It matches when the thing changes, not merely because it exists.'),
        everyMs: z.number().optional().describe('How often to look, 2000 to 300000. Defaults to 5000.'),
      }),
    ]).optional().describe('Keeps this monitor updating itself after your turn ends. Without it you can only redraw the panel while you are running, so a monitor would freeze at exactly the moment the user walked away. Two sources, both read-only: there is no way to run a command on a timer, so do not try to express one as a URL.'),
  }).describe('The one widget that raises its voice. Use it for anything the user asked you to keep an eye on while they do something else — and give it a `watch` if the answer can be found by looking at a local address or a file, so it keeps working once you have stopped.'),
]);

const surfaceShape = {
  sessionId: z.string().describe('The conversation this panel belongs to. It appears beside that chat and no other.'),
  title: z.string().describe(`A short name for the panel, at most ${LIMITS.title} characters.`),
  widgets: z.array(widget).describe(`The panel, top to bottom. At most ${LIMITS.widgets}. Sending them again replaces the whole panel — there is no partial update, so include every widget each time.`),
};

export const SURFACE_ALLOWED_TOOLS = [
  'mcp__tails-surface__surface_show',
  'mcp__tails-surface__surface_close',
];

export function createSurfaceServer(sessionId: string) {
  const showTool = tool(
    'surface_show',
    [
      'Build a panel beside the conversation, out of parts the app draws for you.',
      // Phrased as an expectation, for the reason `preview_open` is: a
      // capability the model treats as optional is a capability nobody sees.
      'Reach for this whenever the answer is structured and prose would flatten it — a comparison, a set of figures, a run of steps, a table of findings, anything you are watching on the user\'s behalf. Text is still right for explanation and for anything short. A panel is not a summary of your reply; it is the part of the answer that is worth looking at rather than reading.',
      'Sending it again replaces the whole panel, so this is also how you update one: rebuild it with the new numbers. Keep the ids out of it — the app assigns those.',
      'You cannot write HTML, CSS, or code here, and there is no widget for "anything else". If what you need is genuinely not in the list, say which kind is missing rather than approximating it with a table.',
    ].join(' '),
    surfaceShape,
    async (input) => {
      try {
        const surface = surfaceService.show(input.sessionId || sessionId, {
          title: input.title,
          widgets: input.widgets,
        });
        return textResult({
          ok: true,
          revision: surface.revision,
          widgets: surface.widgets.length,
        });
      } catch (error) {
        return failureResult(error);
      }
    },
  );

  const closeTool = tool(
    'surface_close',
    'Take the panel down. Do this when what it showed is finished with, rather than leaving a stale one beside a conversation that has moved on.',
    { sessionId: z.string() },
    async (input) => {
      surfaceService.close(input.sessionId || sessionId);
      return textResult({ ok: true });
    },
  );

  return createSdkMcpServer({
    name: 'tails-surface',
    version: '1.0.0',
    tools: [showTool, closeTool],
  });
}
