import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { controlsPayloadSchema } from '@/modules/appearance/controls.js';
import { APPEARANCE_GUIDE } from '@/modules/appearance/guide.js';
import { themeService } from '@/modules/appearance/theme.service.js';
import { themeSpecV2Schema } from '@/modules/appearance/theme-spec.js';

/**
 * The appearance tools exposed to the running agent.
 *
 * An in-process MCP server rather than structured output: `outputFormat`
 * constrains a whole run, which would break every other capability the moment
 * theming is possible. A tool is also a timestamped event, which is what the
 * two-phase "preparing → applying" transition hangs off — the tool-use frame
 * *is* the moment the app knows a restyle is coming.
 *
 * Running in-process means the handlers call `themeService` directly rather
 * than authenticating back into their own HTTP API.
 *
 * The schemas here are the documentation. A model never reads this file, but it
 * reads every `.describe()` in the spec, and the difference between "corner
 * radius" and "0 reads technical, 24+ reads friendly, and radius is what shape
 * sculpts" is the difference between a model that permutes presets and one that
 * designs. Field descriptions are written as instructions, with the tradeoff
 * named, because that is the only channel through which the system can teach.
 */

const textResult = (payload: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

/**
 * Formats a validation failure so the model can correct it in-turn.
 *
 * Returning the dotted-path issues rather than a prose error is what makes a
 * bad generation cost one revision instead of a round trip per mistake.
 */
const failureResult = (error: unknown) => {
  if (error && typeof error === 'object' && 'details' in error) {
    return textResult({
      ok: false,
      error: error instanceof Error ? error.message : 'Rejected.',
      issues: (error as { details: unknown }).details,
    }, true);
  }
  return textResult(
    { ok: false, error: error instanceof Error ? error.message : String(error) },
    true,
  );
};

const themeListTool = tool(
  'theme_list',
  [
    'Read the reference presets and the user\'s saved looks. This is a reading tool, not an apply path.',
    'The presets exist so you can study *how* a look is constructed — which primitives move together to make something read as brutalist rather than neumorphic, why a convincing glass edge is a gradient ring and not a border colour, what a hard zero-blur offset shadow does that a soft one cannot. Read them the way you would read source, then build your own thing.',
    'They are not a menu. Answering "make it feel like a sunset over water" with "the closest preset is Bloom" is the one failure mode this whole system is built to avoid: the presets are the looks somebody already thought of, and the request is for one they did not. If a request cannot be built from the primitives, say which primitive is missing — do not substitute the nearest shipped look.',
    'The one legitimate way to hand a preset to the user is as an explicit starting point they asked for ("show me what you have"), or as a base you then change structurally.',
    'It also returns the appearance guide: how looks are built out of the primitives, which knobs move together to make each family of look, what the live-control layer needs from you, and the three things that are actually refused. Read the guide before you design anything.',
  ].join(' '),
  {},
  async () => {
    try {
      // The guide rides on this response rather than living in `docs/`, because
      // the agent's working directory is the folder the conversation is about
      // and almost never this repository — a document it cannot open is a
      // document it never reads. See `guide.ts`.
      return textResult({ ok: true, guide: APPEARANCE_GUIDE, themes: themeService.listThemes() });
    } catch (error) {
      return failureResult(error);
    }
  },
);

const themePreviewTool = tool(
  'theme_preview',
  [
    'Compile a theme and show it to the user immediately, without saving it. Use this first whenever you design a look: nothing is persisted, nothing needs undoing, and iterating is free.',
    'Design by composition. A look lives in the `surfaces` map — fills, borders, corners, shadows, backdrops, textures, overlays, ambient motion, per-surface ink — and the palette is chosen to suit it, not the other way round. Two themes with the same palette and different surfaces are two different products; two themes with different palettes and no surfaces are the same product in two colours.',
    'The shadow stack is the highest-leverage primitive in the system and it is worth naming what it can do, because none of these is an enum anywhere: a hard zero-blur offset is brutalism; a mirrored light/dark blurred pair is neumorphism; a wide soft dark layer under a tight inset light one is clay; an inset light hairline plus a wide ambient drop is glass; a zero-offset wide accent layer is neon.',
    'It returns schema problems as dotted paths and reports every value the contrast solver had to move, so an empty `adjusted` means you authored the look legibly rather than being rescued.',
  ].join(' '),
  {
    spec: themeSpecV2Schema
      .describe('The theme to preview. Design the `surfaces` map first — that is where a look lives — then pick the palette to suit it.'),
    sessionId: z.string().optional()
      .describe('The conversation this preview belongs to, so the right window updates.'),
  },
  async (args) => {
    try {
      const compiled = themeService.previewTheme(args.spec, args.sessionId ?? '');
      return textResult({
        ok: true,
        preview: true,
        name: compiled.spec.name,
        // Reporting what the solver changed teaches the model which choices
        // were near the contrast floor, so the next spec is better. An empty
        // `adjusted` means the theme was authored legibly rather than rescued.
        contrast: compiled.contrast,
      });
    } catch (error) {
      return failureResult(error);
    }
  },
);

const themeApplyTool = tool(
  'theme_apply',
  [
    'Save a look and bind it. Scope "conversation" changes only the current chat; scope "default" changes the whole app and survives a restart. Prefer "conversation" unless the user explicitly asked to change their default — a look they were shown once is not a look they asked to keep.',
    'Apply what you composed. Passing a `themeId` from theme_list is for the case where the user picked a shipped look by name, not for answering an aesthetic request with the nearest match.',
  ].join(' '),
  {
    spec: themeSpecV2Schema.optional()
      .describe('A new theme to save and apply. Provide this or themeId, not both.'),
    themeId: z.string().optional()
      .describe('An existing theme id from theme_list, to apply without redesigning it.'),
    scope: z.enum(['conversation', 'default'])
      .describe('"conversation" affects only this chat; "default" changes the app everywhere.'),
    sessionId: z.string().optional()
      .describe('The conversation to bind to. Required when scope is "conversation".'),
  },
  async (args) => {
    try {
      if (!args.spec && !args.themeId) {
        return textResult({
          ok: false,
          issues: [{ path: 'spec', message: 'Provide either spec or themeId.' }],
        }, true);
      }
      if (args.scope === 'conversation' && !args.sessionId) {
        return textResult({
          ok: false,
          issues: [{ path: 'sessionId', message: 'sessionId is required for conversation scope.' }],
        }, true);
      }

      const themeId = args.themeId ?? themeService.saveTheme(args.spec, 'generated').id;
      const resolved = themeService.applyTheme(
        themeId,
        args.scope === 'conversation' ? 'session' : 'global',
        args.scope === 'conversation' ? args.sessionId ?? '' : '',
        // The agent is mid-composition: a `theme_css` layer it wrote a moment
        // ago is part of the look it is now applying, not a leftover from a
        // previous one. The user switching theme in Settings means the opposite,
        // which is why that path (the /apply route) does not pass this.
        { keepFreeformLayer: true },
      );

      return textResult({
        ok: true,
        themeId: resolved.themeId,
        name: resolved.name,
        scope: args.scope,
        pinnedMode: resolved.pinnedMode,
      });
    } catch (error) {
      return failureResult(error);
    }
  },
);

const themeProposeTool = tool(
  'theme_propose',
  [
    'Show two or three candidate looks side by side, as live miniatures of the real app — sidebar, header, chat rows, composer — each rendered in its own candidate theme. Nothing is applied and nothing is saved; this is the "let me see it first" step.',
    'Use it for a **substantial** change, and pair it with AskUserQuestion to find out which the user wants. Substantial means the change alters structure: fills, shadows, borders, corners, backdrops, ambient motion, or pinning the colour mode. A hue rotation, a font swap, a density change or a radius nudge is not substantial — preview those and get on with it, because asking someone to choose between two mockups of a font swap is its own kind of bad job.',
    'When the request is ambiguous — "make it nicer", "freshen it up" — the two variants should be a real choice rather than two shades of the same idea: one drastic reading and one conservative one. Say which is which in the labels, and put the actual difference in the note.',
    'The miniatures are rendered from the same derivation the real app uses, scoped to a container, so what the user sees is the look itself rather than a picture of it. It updates the instant you call this again.',
  ].join(' '),
  {
    variants: z.array(z.object({
      label: z.string().min(1).max(24)
        .describe('Two or three words the user picks between: "Bolder", "Closer to now". Not "Option A".'),
      note: z.string().max(140).optional()
        .describe('One sentence on what this variant actually changes, in the user\'s terms rather than in token names.'),
      spec: themeSpecV2Schema.describe('The candidate theme, composed the same way as for theme_preview.'),
    }).strict()).min(2).max(3)
      .describe('Two variants is almost always right. Three is the limit; four choices is a survey, not a decision.'),
    sessionId: z.string().optional()
      .describe('The conversation to show the comparison in.'),
  },
  async (args) => {
    try {
      const proposed = themeService.proposeVariants(args.variants, args.sessionId ?? '');
      return textResult({
        ok: true,
        shown: true,
        // The contrast report per variant, so a shortfall can be fixed before
        // the user is asked to choose rather than after they have chosen.
        variants: proposed.variants,
        next: 'Ask which one with AskUserQuestion, then theme_apply the winner.',
      });
    } catch (error) {
      return failureResult(error);
    }
  },
);

const themeCssTool = tool(
  'theme_css',
  [
    'Layer hand-written CSS over the current theme. This is the escape hatch from the spec\'s vocabulary, and it is a real one: you may write essentially any CSS, against any selector, using any property, at-rule, pseudo-element or media query. Reach for the theme spec first because it solves contrast for you and survives a reload — but when a look needs something the spec has no word for, write it here rather than approximating.',
    'The stylesheet is parsed, walked and rebuilt from the parse tree, so what reaches the app is generated rather than forwarded. It is rejected outright, never silently cleaned up, and you get dotted-path issues back for every problem at once.',
    'Three things are refused, and only three. (1) url() anywhere, in any spelling, including inside custom properties, plus image-set(), src(), image(), element(), attr() and @import — a stylesheet that can name a remote resource can report what the user is doing to whoever owns it. Textures are app-owned and selected by name in the theme spec; gradients and data-free SVG-free drawing are all yours. (2) Any selector naming [data-tails-critical], including from inside :not(), :is() or :has() — that attribute marks permission prompts and the plan-approval row, and a stylesheet that can restyle the thing asking "may I run this command" can make yes look like no. (3) `content` may only be "" or none, because words on screen read as the application\'s own.',
    'Everything that used to be enforced beyond that is now your judgement, and worth exercising: body text below about 0.4 opacity stops being readable; ambient motion should be slow and peripheral and should be switched off under @media (prefers-reduced-motion: reduce); padding in the assistant\'s output is what makes a long answer readable, so tight is a choice and cramped is a bug; a backdrop-filter on a hundred elements will cost frames, and any element carrying one loses subpixel text antialiasing, so keep wide blurs on chrome rather than under paragraphs; !important works and will beat the app\'s own styles, which is sometimes what you want and is never what you want by accident.',
    'The layer is temporary by design: it is never written to disk, so reloading the window always clears it. That is the recovery path, and it is why you have this much room.',
  ].join(' '),
  {
    css: z.string().max(64 * 1024)
      .describe('The stylesheet. The validator reports every problem in one response, so a rejection costs one revision rather than one round trip per mistake. Pass an empty string to remove the layer.'),
    sessionId: z.string().optional()
      .describe('The conversation to apply the layer to.'),
  },
  async (args) => {
    try {
      if (args.css.trim() === '') {
        themeService.clearFreeformCss(args.sessionId ?? '');
        return textResult({ ok: true, cleared: true });
      }

      const applied = themeService.applyFreeformCss(args.css, args.sessionId ?? '');
      return textResult({ ok: true, bytes: applied.bytes, ephemeral: true });
    } catch (error) {
      return failureResult(error);
    }
  },
);

const themeControlsTool = tool(
  'theme_controls',
  [
    'Publish live controls for the look you just made. This is the part of the system that makes a generated theme feel like a thing the user owns rather than a thing that happened to them: after you build a look, you publish the knobs *for that look*, and dragging one repaints instantly — no confirm step, no round trip back to you, no re-derivation.',
    'The knobs are yours to choose, because only you know what is worth adjusting. Glass wants transparency, blur and ring thickness. A CRT wants scanline intensity and glow. Drifting clouds want speed and how faint. A mouse-trail wants how much. None of those belong in a general settings panel, because none of them exist until the look that needs them exists.',
    'A control binds a CSS custom property and writes it on :root. That is what makes it instant, and it is also the constraint: publish a control only for a property something in the current look actually reads through var(). If the theme spec does not expose the knob you want, introduce the property yourself in a theme_css layer first — write blur(var(--glass-blur, 20px)) rather than blur(20px) — and then bind it. A slider wired to a property nobody reads moves and changes nothing, which is worse than no slider.',
    'Three or four controls is a good panel. Twelve is the limit and is almost never right: every extra knob makes the ones that matter harder to find. Publish once, after the look is applied, and republish the whole set if it changes. An empty array removes the panel.',
    'Controls are ephemeral like the CSS layer — a reload clears them.',
  ].join(' '),
  {
    title: controlsPayloadSchema.shape.title,
    controls: controlsPayloadSchema.shape.controls,
    sessionId: z.string().optional()
      .describe('The conversation these controls belong to, so the right window shows them.'),
  },
  async (args) => {
    try {
      const published = themeService.publishControls(
        { title: args.title, controls: args.controls },
        args.sessionId ?? '',
      );
      return textResult({ ok: true, ...published, ephemeral: true });
    } catch (error) {
      return failureResult(error);
    }
  },
);

/** The MCP server merged into the runtime's `mcpServers` option. */
export const appearanceMcpServer = createSdkMcpServer({
  name: 'tails-appearance',
  version: '2.0.0',
  tools: [
    themeListTool,
    themePreviewTool,
    themeProposeTool,
    themeApplyTool,
    themeCssTool,
    themeControlsTool,
  ],
});

/**
 * Tools the agent may call without asking.
 *
 * All five, now, and the reason the list ever had two on it is worth recording
 * because it was the single largest cause of the feature feeling limited.
 *
 * `theme_css` was implemented, validated, tested — and then reachable only
 * through a permission prompt, with nothing in the system prompt telling the
 * model it existed. A tool the model is never told about and that costs a modal
 * to try is a tool that never gets tried, so in practice the entire freeform
 * layer was dead code. The gate was justified on the grounds that spec output
 * is *constructed* while freeform CSS is merely *checked*; that difference is
 * real, but it is answered by the layer being ephemeral — a reload clears it —
 * and by the panic key living in the Electron main process, not by making the
 * capability unreachable.
 *
 * `theme_apply` was held back so that "changing how your app looks permanently"
 * would be the user's call. What that actually produced was a modal in the
 * middle of a design conversation the user had themselves started, for a change
 * that is contrast-solved by construction, visibly announced by the restyling
 * chip, and reversible from Settings and from `Ctrl+Alt+Shift+T`. Asking
 * permission to do the thing you were just asked to do is not consent, it is
 * friction.
 *
 * What still guards the user is unchanged and is not on this list: freeform CSS
 * is never persisted, the panic key is handled out of process, and no
 * stylesheet or control can name `[data-tails-critical]`.
 */
export const APPEARANCE_ALLOWED_TOOLS = [
  'mcp__tails-appearance__theme_list',
  'mcp__tails-appearance__theme_preview',
  'mcp__tails-appearance__theme_propose',
  'mcp__tails-appearance__theme_apply',
  'mcp__tails-appearance__theme_css',
  'mcp__tails-appearance__theme_controls',
];
