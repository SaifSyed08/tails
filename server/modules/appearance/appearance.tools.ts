import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { themeService } from '@/modules/appearance/theme.service.js';
import { themeSpecSchema } from '@/modules/appearance/theme-spec.js';

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
    return textResult({ ok: false, issues: (error as { details: unknown }).details }, true);
  }
  return textResult(
    { ok: false, error: error instanceof Error ? error.message : String(error) },
    true,
  );
};

const themeListTool = tool(
  'theme_list',
  'List the available looks: the built-in reference presets and anything the user has saved. Call this before designing a new look — the presets are worked examples of well-formed specs and show the range the system supports.',
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
  'Validate a theme and show it to the user immediately, without saving it. Use this first whenever you design a look: it reports any schema problems and any contrast adjustments the app had to make, so you can refine before committing.',
  {
    spec: themeSpecSchema,
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
        // were near the contrast floor, so the next spec is better.
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
    spec: themeSpecSchema.optional()
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
        return textResult({ ok: false, error: 'Provide either spec or themeId.' }, true);
      }
      if (args.scope === 'conversation' && !args.sessionId) {
        return textResult({ ok: false, error: 'sessionId is required for conversation scope.' }, true);
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

/** The MCP server merged into the runtime's `mcpServers` option. */
export const appearanceMcpServer = createSdkMcpServer({
  name: 'tails-appearance',
  version: '1.0.0',
  tools: [themeListTool, themePreviewTool, themeApplyTool],
});

/**
 * Tools the agent may call without asking.
 *
 * Listing and previewing are reversible and visible, so they are auto-allowed.
 * `theme_apply` is deliberately absent: permanently changing how the user's app
 * looks is a decision they should make, and leaving it off this list routes it
 * through the permission prompt.
 */
export const APPEARANCE_ALLOWED_TOOLS = [
  'mcp__tails-appearance__theme_list',
  'mcp__tails-appearance__theme_preview',
];
