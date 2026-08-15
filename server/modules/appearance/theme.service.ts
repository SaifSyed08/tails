import { randomUUID } from 'node:crypto';

import { themesRepository, type StoredTheme, type ThemeScope } from '@/db/themes.repository.js';
import { deriveTokens } from '@/modules/appearance/derive.js';
import { validateFreeformCss } from '@/modules/appearance/freeform-css.js';
import { THEME_PRESETS } from '@/modules/appearance/presets.js';
import { serializeStylesheet } from '@/modules/appearance/serialize.js';
import { upgradeSpec, themeSpecSchema, type ThemeSpec } from '@/modules/appearance/theme-spec.js';
import { appBroadcast } from '@/shared/broadcast.js';
import { AppError, createMessage } from '@/shared/utils.js';

/**
 * How many themes one user may keep.
 *
 * Rejecting at the cap rather than evicting is deliberate twice over: an agent
 * in a loop must not be able to fill the database, and a look the user saved
 * must not disappear because the agent generated eleven variants.
 */
const MAX_THEMES = 100;

/**
 * Whether the freeform CSS layer is available at all.
 *
 * On by default, and the reasoning is worth recording because the safer default
 * is tempting. Everything the declarative spec produces has been solved for
 * contrast and cannot name a URL; freeform CSS is validated to the same
 * standard, but that is validation rather than construction, and the two are
 * not the same promise.
 *
 * What makes the weaker promise acceptable here is that the layer is
 * ephemeral — never written to the database, gone on reload — so the worst
 * outcome of a hostile or merely bad stylesheet is "reload the window" rather
 * than "the app opens broken and the thing that would let you fix it is the
 * thing that is broken". The out-of-process panic key is the backstop beneath
 * that, deliberately outside the renderer so no stylesheet can reach it.
 *
 * Set `TAILS_FREEFORM_CSS=0` to take the declarative spec alone.
 */
const FREEFORM_CSS_ENABLED = process.env.TAILS_FREEFORM_CSS !== '0';

export type ThemeSummary = {
  id: string;
  name: string;
  summary: string;
  spec: ThemeSpec;
  builtIn: boolean;
};

export type ResolvedAppearance = {
  themeId: string;
  name: string;
  css: string;
  /** Set when the theme pins a colour mode, disabling the user's toggle. */
  pinnedMode: 'light' | 'dark' | null;
  scope: ThemeScope | 'builtin';
};

/** Built-in presets are addressed as `preset:<id>` so ids never collide with UUIDs. */
const PRESET_PREFIX = 'preset:';

const readPresetSpec = (themeId: string): ThemeSpec | null => {
  if (!themeId.startsWith(PRESET_PREFIX)) return null;
  return THEME_PRESETS[themeId.slice(PRESET_PREFIX.length)] ?? null;
};

/** Formats validation failures the way the widget schema does: dotted paths. */
const toValidationError = (issues: { path: PropertyKey[]; message: string }[]): AppError =>
  new AppError('The theme did not match the schema.', {
    code: 'THEME_INVALID',
    statusCode: 422,
    details: issues.map((issue) => ({
      path: issue.path.map(String).join('.') || 'root',
      message: issue.message,
    })),
  });

export const themeService = {
  /** Built-in presets plus the user's saved themes. */
  listThemes(): ThemeSummary[] {
    const presets: ThemeSummary[] = Object.entries(THEME_PRESETS).map(([id, spec]) => ({
      id: `${PRESET_PREFIX}${id}`,
      name: spec.name,
      summary: spec.summary,
      spec,
      builtIn: true,
    }));

    const saved: ThemeSummary[] = themesRepository.listThemes().map((theme) => ({
      id: theme.id,
      name: theme.name,
      summary: theme.summary ?? '',
      spec: theme.spec,
      builtIn: false,
    }));

    return [...presets, ...saved];
  },

  /**
   * Validates and derives a spec without storing anything.
   *
   * The preview path. Returns the stylesheet so the caller can apply it
   * immediately and the contrast report so the model learns what was adjusted.
   */
  compile(rawSpec: unknown) {
    const parsed = themeSpecSchema.safeParse(rawSpec);
    if (!parsed.success) throw toValidationError(parsed.error.issues);

    const derived = deriveTokens(parsed.data);
    return {
      spec: parsed.data,
      derived,
      css: serializeStylesheet(derived),
      contrast: {
        target: upgradeSpec(parsed.data).surface.contrastTarget,
        minRatio: Math.round(derived.minRatio * 100) / 100,
        // Dotted paths into the spec, not prose. The model corrects a path; it
        // argues with a sentence.
        adjusted: derived.adjusted,
      },
    };
  },

  /**
   * Shows a theme without storing or binding it.
   *
   * The ephemeral layer, above every persisted binding: it lives only in the
   * renderer and disappears on reload. This is what makes "let me try
   * something" free — nothing to undo, nothing to clean up.
   */
  previewTheme(rawSpec: unknown, sessionId = '') {
    const compiled = this.compile(rawSpec);

    appBroadcast.publish(createMessage('appearance_changed', sessionId, {
      appearance: {
        layer: 'theme',
        scope: 'preview',
        scopeKey: sessionId,
        themeId: 'preview',
        name: compiled.spec.name,
        css: compiled.css,
        pinnedMode: compiled.spec.mode === 'adaptive' ? null : compiled.spec.mode,
      },
    }));

    return compiled;
  },

  /** Stores a theme, returning it with its derived tokens. */
  saveTheme(rawSpec: unknown, origin: 'generated' | 'saved' = 'generated'): StoredTheme {
    const { spec, derived } = this.compile(rawSpec);

    if (themesRepository.countThemes() >= MAX_THEMES) {
      throw new AppError(
        `You already have ${MAX_THEMES} saved looks. Delete one before saving another.`,
        { code: 'THEME_LIMIT_REACHED', statusCode: 409 },
      );
    }

    return themesRepository.saveTheme({ id: randomUUID(), spec, tokens: derived, origin });
  },

  /**
   * Binds a theme to a scope and tells every open window.
   *
   * The broadcast rather than the return value is the delivery mechanism, so
   * the settings UI, the agent tool, and a preset click all travel the same
   * path and cannot drift apart.
   */
  applyTheme(themeId: string, scope: ThemeScope, scopeKey = ''): ResolvedAppearance {
    // Resolve before binding so a bad id fails loudly instead of leaving a
    // dangling binding that silently falls through to the default.
    const resolved = this.resolveThemeId(themeId, scope);
    themesRepository.setBinding(scope, scopeKey, themeId);

    appBroadcast.publish(createMessage('appearance_changed', scopeKey, {
      // Spread first so the explicit binding scope wins over the resolved one.
      appearance: { ...resolved, layer: 'theme', scope, scopeKey },
    }));

    return resolved;
  },

  /** Turns a theme id into renderable CSS, whether it is a preset or saved. */
  resolveThemeId(themeId: string, scope: ThemeScope | 'builtin' = 'global'): ResolvedAppearance {
    const presetSpec = readPresetSpec(themeId);
    if (presetSpec) {
      const derived = deriveTokens(presetSpec);
      return {
        themeId,
        name: presetSpec.name,
        css: serializeStylesheet(derived),
        pinnedMode: presetSpec.mode === 'adaptive' ? null : presetSpec.mode,
        scope,
      };
    }

    const stored = themesRepository.getTheme(themeId);
    if (!stored) {
      throw new AppError('That look no longer exists.', { code: 'THEME_NOT_FOUND', statusCode: 404 });
    }

    return {
      themeId,
      name: stored.name,
      // Rendered from the cached tokens, not re-derived, so a schema change
      // never retroactively restyles something the user saved.
      css: serializeStylesheet(stored.tokens),
      pinnedMode: stored.spec.mode === 'adaptive' ? null : stored.spec.mode,
      scope,
    };
  },

  /**
   * The precedence ladder: session binding, then global, then the built-in base.
   *
   * A deleted theme falls through rather than erroring — the conversation must
   * still open — and its orphaned binding is swept on the way past.
   */
  resolveAppearance(sessionId?: string): ResolvedAppearance | null {
    const candidates: { scope: ThemeScope; key: string }[] = [
      ...(sessionId ? [{ scope: 'session' as const, key: sessionId }] : []),
      { scope: 'global' as const, key: '' },
    ];

    for (const candidate of candidates) {
      const themeId = themesRepository.getBinding(candidate.scope, candidate.key);
      if (!themeId) continue;

      try {
        return this.resolveThemeId(themeId, candidate.scope);
      } catch {
        themesRepository.clearBinding(candidate.scope, candidate.key);
      }
    }

    // Nothing bound: the stylesheet in index.css is the floor, and needs no
    // override to be correct.
    return null;
  },

  /**
   * Removes a binding and tells the windows what to fall back to.
   *
   * An empty `css` is the signal to drop the override entirely and let the
   * built-in stylesheet show through — the floor needs no rules of its own.
   */
  unbind(scope: ThemeScope, scopeKey = ''): void {
    themesRepository.clearBinding(scope, scopeKey);
    const fallback = this.resolveAppearance();

    appBroadcast.publish(createMessage('appearance_changed', scopeKey, {
      appearance: {
        ...(fallback ?? {
          themeId: 'builtin', name: 'Default', css: '', pinnedMode: null, scope: 'builtin' as const,
        }),
        layer: 'theme',
        scope,
        scopeKey,
      },
    }));
  },

  /**
   * Renames a saved look and promotes it to a keeper.
   *
   * This is how a theme the agent generated becomes one of the user's own:
   * flipping `origin` to `saved` marks it as deliberately kept rather than a
   * by-product of a conversation, which is what any future cleanup of
   * generated themes must not touch.
   */
  renameTheme(themeId: string, name: string): StoredTheme {
    const stored = themesRepository.getTheme(themeId);
    if (!stored) {
      throw new AppError('That look no longer exists.', { code: 'THEME_NOT_FOUND', statusCode: 404 });
    }

    const trimmed = name.trim().slice(0, 40);
    if (!trimmed) {
      throw new AppError('A preset needs a name.', { code: 'THEME_NAME_REQUIRED', statusCode: 400 });
    }

    return themesRepository.saveTheme({
      id: stored.id,
      spec: { ...stored.spec, name: trimmed },
      tokens: stored.tokens,
      origin: 'saved',
    });
  },

  /**
   * Applies an author-written stylesheet as a layer above the theme.
   *
   * Ephemeral by design. It lives in the renderer until the window reloads and
   * is never written to the database, which makes the worst outcome of a bad
   * stylesheet "reload the window" rather than "the app opens broken and the
   * thing that would let you fix it is the thing that is broken". Persisting it
   * would need a recovery path, and a recovery path nobody has ever exercised
   * is not a recovery path.
   *
   * The CSS handed to the renderer is the validator's output, never the input.
   */
  applyFreeformCss(rawCss: unknown, sessionId = ''): { css: string; bytes: number } {
    if (!FREEFORM_CSS_ENABLED) {
      throw new AppError(
        'Freeform theme CSS is switched off on this install (TAILS_FREEFORM_CSS=0). Use the declarative theme spec instead — it covers everything that can be guaranteed safe.',
        { code: 'THEME_CSS_DISABLED', statusCode: 403 },
      );
    }

    if (typeof rawCss !== 'string') {
      throw new AppError('Provide the stylesheet as a string.', {
        code: 'THEME_CSS_INVALID',
        statusCode: 422,
        details: [{ path: 'css', message: 'Expected a string.' }],
      });
    }

    const result = validateFreeformCss(rawCss);
    if (!result.ok) {
      throw new AppError('The stylesheet was rejected.', {
        code: 'THEME_CSS_INVALID',
        statusCode: 422,
        details: result.issues,
      });
    }

    appBroadcast.publish(createMessage('appearance_changed', sessionId, {
      appearance: {
        layer: 'css',
        scope: 'preview',
        scopeKey: sessionId,
        themeId: 'freeform',
        name: 'Custom CSS',
        css: result.css,
        pinnedMode: null,
      },
    }));

    return { css: result.css, bytes: Buffer.byteLength(result.css, 'utf8') };
  },

  /** Drops the freeform layer, leaving the theme underneath untouched. */
  clearFreeformCss(sessionId = ''): void {
    appBroadcast.publish(createMessage('appearance_changed', sessionId, {
      appearance: {
        layer: 'css',
        scope: 'preview',
        scopeKey: sessionId,
        themeId: 'freeform',
        name: 'Custom CSS',
        css: '',
        pinnedMode: null,
      },
    }));
  },

  deleteTheme(themeId: string): { id: string } {
    if (!themesRepository.deleteTheme(themeId)) {
      throw new AppError('That look no longer exists.', { code: 'THEME_NOT_FOUND', statusCode: 404 });
    }
    return { id: themeId };
  },
};
