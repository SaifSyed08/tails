import { prefersReducedMotion } from '@/theme/motion';

/** Cached so a cold start can paint the last look before the bundle runs. */
const THEME_CSS_KEY = 'tails.themeCss';

let themeSheet: CSSStyleSheet | null = null;
let fallbackStyleElement: HTMLStyleElement | null = null;

/**
 * Installs the single stylesheet all generated themes are written into.
 *
 * A constructed stylesheet in `adoptedStyleSheets` is one atomic object we can
 * rewrite wholesale, and — critically — it carries real `:root` / `.dark`
 * selectors. Writing tokens as inline styles on the root element instead is
 * the obvious first implementation and is wrong: inline styles outrank every
 * selector, so the `.dark` overrides stop working and dark mode silently
 * breaks.
 */
function ensureSheet(): { write: (css: string) => void } {
  if (typeof document === 'undefined') return { write: () => {} };

  const supportsConstructable = typeof CSSStyleSheet !== 'undefined'
    && 'replaceSync' in CSSStyleSheet.prototype
    && 'adoptedStyleSheets' in Document.prototype;

  if (supportsConstructable) {
    if (!themeSheet) {
      themeSheet = new CSSStyleSheet();
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, themeSheet];
    }
    return { write: (css) => themeSheet?.replaceSync(css) };
  }

  if (!fallbackStyleElement) {
    fallbackStyleElement = document.createElement('style');
    fallbackStyleElement.id = 'tails-theme';
    document.head.appendChild(fallbackStyleElement);
  }
  return { write: (css) => { if (fallbackStyleElement) fallbackStyleElement.textContent = css; } };
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
export async function applyTheme(payload: AppearancePayload): Promise<void> {
  const { write } = ensureSheet();

  await preloadFonts(payload.css);

  const commit = () => {
    write(payload.css);

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
  ensureSheet().write('');
  try {
    localStorage.removeItem(THEME_CSS_KEY);
  } catch {
    // Nothing to recover from; the sheet is already cleared.
  }
}
