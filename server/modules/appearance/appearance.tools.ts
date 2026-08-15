import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

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
  'List the available looks: the built-in reference presets and anything the user has saved. Call this before designing a new look. The presets are worked examples of well-formed v2 specs and they deliberately span the range — glass, brutalist, neumorphic, terminal, editorial — so reading them is how you learn what the surface vocabulary can express. Copy the structure of the nearest one and then change it; do not copy its palette and call that a new theme.',
  {},
  async () => {
    try {
      return textResult({ ok: true, themes: themeService.listThemes() });
    } catch (error) {
      return failureResult(error);
    }
  },
);

const themePreviewTool = tool(
  'theme_preview',
  'Validate a theme and show it to the user immediately, without saving it. Use this first whenever you design a look. It returns any schema problems as dotted paths and reports every value the contrast solver had to move, so you can refine before committing. Nothing is persisted and nothing needs undoing.',
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
  'Save a look and apply it. Scope "conversation" changes only the current chat; scope "default" changes the whole app permanently and will ask the user for permission. Prefer "conversation" unless the user explicitly asked to change their default.',
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

const themeCssTool = tool(
  'theme_css',
  [
    'Layer hand-written CSS over the current theme. This is a last resort: reach for the theme spec first, and only come here for something the spec genuinely cannot express. Calling it always asks the user for permission, and it can be switched off entirely, so treat it as expensive.',
    'The stylesheet is parsed, checked against allowlists and rebuilt from the parse tree, so what reaches the app is generated rather than forwarded. It is rejected outright, never silently cleaned up, and you get dotted-path issues back for every problem at once.',
    'The rules worth knowing before you write anything: url() is banned everywhere including inside custom properties, so select textures by name in the theme spec instead; every selector must start at [data-tails-part="..."], [data-tails-surface="..."], a .t-* class, .prose-tails or :root; layout, sizing, visibility and interaction properties are not themeable; position/inset/z-index work only inside ::before and ::after; only @keyframes, @property and @media (prefers-color-scheme | prefers-reduced-motion | forced-colors) are allowed.',
    'The layer is temporary: it disappears when the window reloads.',
  ].join(' '),
  {
    css: z.string().max(64 * 1024)
      .describe('The stylesheet. Read the tool description before writing it — nearly every rejection is one of the listed rules, and the validator reports all of them in one response so you can fix them in a single revision. Pass an empty string to remove the layer.'),
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

/** The MCP server merged into the runtime's `mcpServers` option. */
export const appearanceMcpServer = createSdkMcpServer({
  name: 'tails-appearance',
  version: '2.0.0',
  tools: [themeListTool, themePreviewTool, themeApplyTool, themeCssTool],
});

/**
 * Tools the agent may call without asking.
 *
 * Listing and previewing are reversible and visible, so they are auto-allowed.
 * `theme_apply` is deliberately absent: permanently changing how the user's app
 * looks is a decision they should make, and leaving it off this list routes it
 * through the permission prompt.
 *
 * `theme_css` is absent for a stronger reason. Everything the spec produces was
 * constructed by the app; freeform CSS was merely *checked* by it, and a check
 * is only as good as the list behind it. Two gates — a feature switch and a
 * permission prompt — is the right price for the difference.
 */
export const APPEARANCE_ALLOWED_TOOLS = [
  'mcp__tails-appearance__theme_list',
  'mcp__tails-appearance__theme_preview',
];
