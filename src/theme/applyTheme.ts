import { prefersReducedMotion } from '@/theme/motion';

/** Cached so a cold start can paint the last look before the bundle runs. */
const THEME_CSS_KEY = 'tails.themeCss';

/**
 * The two stylesheets the appearance system owns, in cascade order.
 *
 * `theme` carries derived tokens; `css` carries an author-written stylesheet
 * that must be able to override them, which is the whole reason it exists.
 * Order is load order here — `css` is adopted after `theme` and never before,
 * so a freeform rule wins ties without needing `!important` everywhere.
 */
export type AppearanceLayer = 'theme' | 'css';

const LAYER_ORDER: AppearanceLayer[] = ['theme', 'css'];

const sheets = new Map<AppearanceLayer, CSSStyleSheet>();
const fallbackElements = new Map<AppearanceLayer, HTMLStyleElement>();

const supportsConstructable = (): boolean =>
  typeof CSSStyleSheet !== 'undefined'
  && 'replaceSync' in CSSStyleSheet.prototype
  && 'adoptedStyleSheets' in Document.prototype;

/**
 * Installs a layer's stylesheet, keeping the layers in a defined order.
 *
 * A constructed stylesheet in `adoptedStyleSheets` is one atomic object we can
 * rewrite wholesale, and — critically — it carries real `:root` / `.dark`
 * selectors. Writing tokens as inline styles on the root element instead is
 * the obvious first implementation and is wrong: inline styles outrank every
 * selector, so the `.dark` overrides stop working and dark mode silently
 * breaks.
 *
 * The adopted list is rebuilt rather than appended to, because appending would
 * order the layers by whichever happened to be written first — which for a
 * freeform sheet applied before its theme is exactly backwards.
 */
function ensureSheet(layer: AppearanceLayer = 'theme'): { write: (css: string) => void } {
  if (typeof document === 'undefined') return { write: () => {} };

  if (supportsConstructable()) {
    if (!sheets.has(layer)) {
      sheets.set(layer, new CSSStyleSheet());

      const ours = new Set(sheets.values());
      document.adoptedStyleSheets = [
        ...document.adoptedStyleSheets.filter((sheet) => !ours.has(sheet)),
        ...LAYER_ORDER.map((name) => sheets.get(name)).filter((sheet): sheet is CSSStyleSheet => !!sheet),
      ];
    }
    return { write: (css) => sheets.get(layer)?.replaceSync(css) };
  }

  if (!fallbackElements.has(layer)) {
    const element = document.createElement('style');
    element.id = `tails-${layer}`;
    document.head.appendChild(element);
    fallbackElements.set(layer, element);
  }
  return {
    write: (css) => {
      const element = fallbackElements.get(layer);
      if (element) element.textContent = css;
    },
  };
}

/**
 * Applies an author-written stylesheet above the theme.
 *
 * Deliberately not wrapped in a View Transition and deliberately never cached:
 * this layer is ephemeral by contract — it lives until the window reloads —
 * so the worst outcome of a stylesheet that hides something important is
 * "reload the window" rather than "the app now opens broken". The server
 * validates it; this function only installs what came back.
 */
export function applyFreeformCss(css: string): void {
  ensureSheet('css').write(css);
}

/** Fonts referenced by a theme, so we can wait for them before swapping. */
function readFontFamilies(css: string): string[] {
  return [...css.matchAll(/--font-[a-z]+:\s*([^;]+);/g)]
    .flatMap((match) => match[1].split(','))
    .map((family) => family.trim().replace(/^['"]|['"]$/g, ''))
    .filter((family) => family.length > 0 && !family.includes('-ui') && family !== 'sans-serif');
}

/**
 * Loads a theme's fonts before it is applied.
 *
 * The highest-value flash defence: swapping tokens before the display face has
 * loaded produces one jump to fallback metrics and a second when the real font
 * arrives. Waiting turns two visible jumps into one deliberate change. Bounded,
 * because a missing font must not block the restyle forever.
 */
async function preloadFonts(css: string, budgetMs = 600): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return;

  const families = readFontFamilies(css).slice(0, 6);
  if (families.length === 0) return;

  const loads = families.map((family) =>
    document.fonts.load(`16px "${family}"`).catch(() => undefined),
  );

  await Promise.race([
    Promise.all(loads),
    new Promise((resolve) => setTimeout(resolve, budgetMs)),
  ]);
}

export type AppearancePayload = {
  themeId: string;
  name: string;
  css: string;
  pinnedMode: 'light' | 'dark' | null;
  scope?: string;
};

/**
 * Applies a theme to the running app.
 *
 * No reload, because nothing about a theme is a class name or a component —
 * every themed value is read through a CSS custom property, so a change is a
 * variable swap. The View Transition wraps that swap so the browser
 * cross-fades the whole document in one compositor pass instead of flickering
 * element by element.
 */
/**
 * Drops the stylesheet `index.html` injects before the bundle runs.
 *
 * That script paints the last look from `localStorage` so a cold start does not
 * flash the built-in ramp — but it does it with a plain `<style>` element in
 * `<head>`, and nothing used to take it away. Every other layer lives in
 * `adoptedStyleSheets`, which the appearance state replaces wholesale, so the
 * teardown that resets everything else could not see this one at all: resetting
 * unbound the theme, emptied the adopted sheet, and left the pre-paint element
 * still applying the old preset. The result was an app that came back partly
 * reset and could not be talked out of it, because the thing holding the old
 * look was invisible to every mechanism designed to clear it.
 *
 * Removed on the first real apply, by which point the sheet it exists to cover
 * for has been written.
 */
function dropPrebootStyle(): void {
  document.getElementById('tails-theme-preboot')?.remove();
}

export async function applyTheme(payload: AppearancePayload): Promise<void> {
  const { write } = ensureSheet();

  await preloadFonts(payload.css);

  const commit = () => {
    write(payload.css);
    dropPrebootStyle();

    // A pinned single-mode theme owns the class as well as the tokens;
    // otherwise every `dark:` utility would stay on the wrong branch.
    if (payload.pinnedMode === 'dark') document.documentElement.classList.add('dark');
    if (payload.pinnedMode === 'light') document.documentElement.classList.remove('dark');

    try {
      // Only the persisted default is worth caching for the next cold start;
      // an ephemeral preview should not survive a reload.
      if (payload.scope !== 'preview') {
        localStorage.setItem(THEME_CSS_KEY, payload.css);
      }
    } catch {
      // A full or blocked localStorage costs a flash on next boot, nothing more.
    }
  };

  const canTransition = typeof document !== 'undefined'
    && 'startViewTransition' in document
    && !prefersReducedMotion();

  if (!canTransition) {
    commit();
    return;
  }

  await (document as Document & {
    startViewTransition: (callback: () => void) => { finished: Promise<void> };
  }).startViewTransition(commit).finished.catch(() => undefined);
}

/** Drops any generated theme, revealing the built-in ramp underneath. */
export function clearTheme(): void {
  ensureSheet('theme').write('');
  ensureSheet('css').write('');
  dropPrebootStyle();

  try {
    localStorage.removeItem(THEME_CSS_KEY);
  } catch {
    // Nothing to recover from; the sheets are already cleared.
  }
}
