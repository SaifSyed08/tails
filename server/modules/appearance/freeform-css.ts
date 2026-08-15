import { generate, parse, type CssNode, type List } from 'css-tree';

/**
 * The escape hatch: author-supplied CSS, parsed, validated and rebuilt.
 *
 * Off by default and behind its own tool, because everything here is a
 * concession. The declarative spec covers the looks the system knows how to
 * guarantee; this covers the ones it does not, and the price is that a
 * stylesheet is a program.
 *
 * Three rules make that price payable.
 *
 * **Parse, never pattern-match.** A regex over CSS is a guess about a grammar
 * with comments, escapes, nested functions and four ways to write a string. The
 * bypasses are not exotic — `u\72 l(...)` defeats a naive `url(` check — and a
 * validator that can be fooled is worse than none, because it is trusted.
 *
 * **Re-serialise from the AST.** Author bytes never reach the renderer. What
 * ships is generated from the tree we finished inspecting, so anything the
 * parser did not understand cannot survive the round trip, and there is no gap
 * between "what we validated" and "what we sent".
 *
 * **Reject, never repair.** No clamping, no stripping, no "we removed the bad
 * bits". A caller that gets `ok: true` knows every byte was allowed, and a
 * caller that gets issues can fix them — silently rewriting someone's CSS
 * teaches them nothing and hides what the system actually does.
 *
 * The single highest-value rule is the total ban on `url()`. It removes the
 * whole CSS-exfiltration class in one line: no background image, no font fetch,
 * no `@import`, no cursor, no `image-set`, nothing that can turn a style into a
 * network request carrying whatever the selector matched. It costs the author
 * nothing because every texture, filter and gradient the app supports is
 * app-owned and selected by name (see `textures.ts`).
 */

export type FreeformIssue = { path: string; message: string };

export type FreeformResult =
  | { ok: true; css: string }
  | { ok: false; issues: FreeformIssue[] };

/**
 * Size limits.
 *
 * Not security boundaries — a 40KB stylesheet is no more dangerous than a 30KB
 * one — but a stylesheet this size is almost always a model that has lost the
 * thread, and failing loudly at a stated number is kinder than shipping
 * something nobody will read.
 */
export const FREEFORM_BUDGETS = {
  bytes: 32 * 1024,
  rules: 200,
  declarations: 1500,
  nesting: 3,
} as const;

/**
 * Properties a theme may set.
 *
 * An allowlist, so a property nobody considered is denied rather than allowed.
 * What is missing is the point: `display`, `visibility`, `position`, the inset
 * properties, `z-index`, every sizing property, `overflow`, `pointer-events`,
 * `user-select`, `order`, `direction`, `float`, `contain`, `all` and `zoom` are
 * all absent, because those are the properties that let a stylesheet remove the
 * permission prompt from the screen rather than restyle it. A theme decides how
 * the app looks; it does not decide what the app shows.
 *
 * `clip-path` and the mask properties are absent for the same reason `opacity`
 * has a floor: they hide content, and a hidden control is a removed control.
 */
const ALLOWED_PROPERTIES = new Set([
  // Paint
  'color', 'background', 'background-color', 'background-image', 'background-position',
  'background-position-x', 'background-position-y', 'background-size', 'background-repeat',
  'background-clip', 'background-origin', 'background-attachment', 'background-blend-mode',
  'mix-blend-mode', 'isolation', 'opacity', 'accent-color', 'caret-color', 'color-scheme',
  'forced-color-adjust', 'print-color-adjust',
  // Border and outline
  'border', 'border-width', 'border-style', 'border-color',
  'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-block', 'border-inline', 'border-block-start', 'border-block-end',
  'border-inline-start', 'border-inline-end',
  'border-radius', 'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-left-radius', 'border-bottom-right-radius',
  'border-image', 'border-image-source', 'border-image-slice', 'border-image-width',
  'border-image-outset', 'border-image-repeat', 'corner-shape',
  'outline', 'outline-color', 'outline-style', 'outline-width', 'outline-offset',
  // Depth
  'box-shadow', 'text-shadow', 'filter', 'backdrop-filter', '-webkit-backdrop-filter',
  // Type
  'font', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'font-variant-numeric', 'font-variant-ligatures', 'font-feature-settings',
  'font-variation-settings', 'font-stretch', 'font-optical-sizing', 'font-synthesis',
  'font-kerning', 'text-rendering', '-webkit-font-smoothing', '-moz-osx-font-smoothing',
  'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-align-last',
  'text-transform', 'text-decoration', 'text-decoration-color', 'text-decoration-line',
  'text-decoration-style', 'text-decoration-thickness', 'text-underline-offset',
  'text-underline-position', 'text-indent', 'text-overflow', 'text-wrap', 'white-space',
  'word-break', 'overflow-wrap', 'hyphens', 'vertical-align', 'quotes', 'tab-size',
  'list-style', 'list-style-type', 'list-style-position', 'text-emphasis',
  'text-emphasis-color', 'text-emphasis-style',
  // Spacing
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'padding-block', 'padding-block-start', 'padding-block-end',
  'padding-inline', 'padding-inline-start', 'padding-inline-end',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'margin-block', 'margin-block-start', 'margin-block-end',
  'margin-inline', 'margin-inline-start', 'margin-inline-end',
  'gap', 'row-gap', 'column-gap',
  // Movement
  'transform', 'transform-origin', 'transform-style', 'rotate', 'scale', 'translate',
  'perspective', 'perspective-origin', 'backface-visibility', 'will-change',
  'transition', 'transition-property', 'transition-duration', 'transition-timing-function',
  'transition-delay',
  'animation', 'animation-name', 'animation-duration', 'animation-timing-function',
  'animation-delay', 'animation-iteration-count', 'animation-direction',
  'animation-fill-mode', 'animation-play-state',
  // Odds and ends
  'cursor', 'appearance', 'scrollbar-color', 'scrollbar-width', 'scroll-behavior',
  'box-decoration-break', 'content',
]);

/**
 * Properties permitted only inside a `::before` / `::after` rule.
 *
 * A generated element is a decoration the app never queries and the user never
 * clicks, so positioning one is safe in a way that positioning a real element
 * is not. The `z-index` cap keeps that decoration underneath anything the app
 * floats above the page.
 */
const PSEUDO_ONLY_PROPERTIES = new Set([
  'position', 'inset', 'inset-block', 'inset-inline',
  'top', 'right', 'bottom', 'left', 'z-index',
]);

const MAX_PSEUDO_Z_INDEX = 5;

/**
 * Functions a value may call.
 *
 * An allowlist again, and the reason `url()` cannot come back under another
 * name: `image-set()`, `src()`, `element()` and `-webkit-image-set()` are all
 * ways to name a resource, and none of them is here. `attr()` is absent because
 * it reads the DOM into a value, which is the other half of an exfiltration
 * primitive.
 */
const ALLOWED_FUNCTIONS = new Set([
  'var', 'calc', 'min', 'max', 'clamp', 'round', 'mod', 'rem', 'abs', 'sign',
  'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color',
  'color-mix', 'light-dark',
  'linear-gradient', 'radial-gradient', 'conic-gradient',
  'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient',
  'blur', 'brightness', 'contrast', 'drop-shadow', 'grayscale', 'hue-rotate',
  'invert', 'opacity', 'saturate', 'sepia',
  // Lower-case throughout: membership is tested against `name.toLowerCase()`,
  // so a camel-cased entry here can never match and the function it names
  // silently becomes unusable.
  'translate', 'translatex', 'translatey', 'translatez', 'translate3d',
  'scale', 'scalex', 'scaley', 'scale3d', 'rotate', 'rotatex', 'rotatey', 'rotatez',
  'rotate3d', 'skew', 'skewx', 'skewy', 'matrix', 'matrix3d', 'perspective',
  'cubic-bezier', 'steps', 'linear', 'superellipse', 'inset', 'circle', 'ellipse',
  'fit-content', 'minmax', 'env',
]);

/** Pseudo-classes a selector may use. `:has()` is absent: it reaches upward. */
const ALLOWED_PSEUDO_CLASSES = new Set([
  'root', 'hover', 'focus', 'focus-visible', 'focus-within', 'active', 'visited',
  'disabled', 'enabled', 'checked', 'indeterminate', 'placeholder-shown', 'read-only',
  'first-child', 'last-child', 'only-child', 'first-of-type', 'last-of-type',
  'nth-child', 'nth-last-child', 'nth-of-type', 'empty', 'target',
  'not', 'is', 'where',
]);

/** Pseudo-elements a selector may use. */
const ALLOWED_PSEUDO_ELEMENTS = new Set([
  'before', 'after', 'placeholder', 'selection', 'marker', 'first-letter', 'first-line',
  'backdrop',
]);

/** Attributes a selector may match on. */
const ALLOWED_ATTRIBUTES = new Set([
  'data-tails-part', 'data-tails-surface', 'data-tails-state',
  'data-state', 'aria-expanded', 'aria-selected', 'aria-current', 'disabled',
]);

/** The attribute a theme must never be able to reach. */
const CRITICAL_ATTRIBUTE = 'data-tails-critical';

/** At-rules a theme may use. `@import` and `@font-face` both fetch; neither is here. */
const ALLOWED_AT_RULES = new Set(['keyframes', 'property', 'media']);

/** Media features a theme may query. Anything else fingerprints the device. */
const ALLOWED_MEDIA_FEATURES = new Set([
  'prefers-color-scheme', 'prefers-reduced-motion', 'forced-colors',
]);

/** `@property` descriptors. */
const ALLOWED_PROPERTY_DESCRIPTORS = new Set(['syntax', 'inherits', 'initial-value']);

const MIN_OPACITY = 0.15;
const FILTER_RANGE = { low: 0.5, high: 2 } as const;
/**
 * Duration ceilings, split by what the user is doing while time passes.
 *
 * A transition is the app answering an action — a click, a hover, a focus —
 * so the user is waiting for it, and anything past a few seconds reads as the
 * app being stuck rather than as a slow answer.
 *
 * An animation is ambience. Nothing is pending, so "slow" is a legitimate
 * aesthetic rather than a stall: a sheen drifting across glass, a gradient
 * breathing under a card, an aurora. Those run six to ten seconds by design,
 * and a three-second ceiling makes the entire category unreachable — which is
 * the wrong trade for a feature whose whole purpose is looks the declarative
 * spec cannot express. Still bounded, because a duration in minutes is a typo
 * rather than an intention.
 */
const MAX_TRANSITION_MS = 3000;
const MAX_ANIMATION_MS = 20000;
/** Below this, a transform has scaled its element out of existence. */
const MIN_SCALE = 0.05;

const children = (list: List<CssNode> | undefined | null): CssNode[] =>
  (list ? list.toArray() : []);

/** Collects issues while walking, so one call reports every problem at once. */
class IssueLog {
  readonly issues: FreeformIssue[] = [];

  add(path: string, message: string): void {
    // One report per problem is what makes the output actionable; a hundred
    // copies of the same message is what makes a model give up and re-send the
    // same stylesheet.
    if (this.issues.length < 60) this.issues.push({ path, message });
  }
}

/** Reads a numeric value from a Number or Percentage node, or null. */
function readNumber(node: CssNode): number | null {
  if (node.type === 'Number') return Number.parseFloat(node.value);
  if (node.type === 'Percentage') return Number.parseFloat(node.value) / 100;
  return null;
}

/** Reads a time in milliseconds from a Dimension node, or null. */
function readMilliseconds(node: CssNode): number | null {
  if (node.type !== 'Dimension') return null;
  if (node.unit === 's') return Number.parseFloat(node.value) * 1000;
  if (node.unit === 'ms') return Number.parseFloat(node.value);
  return null;
}

/**
 * Every node in a subtree, flattened.
 *
 * Walks named node properties as well as `children`, because css-tree hangs
 * some of the tree off named slots — a media query's condition, an attribute
 * selector's name — and a traversal that only follows `children` silently sees
 * an empty `@media` prelude. Missing a node is the failure mode a validator
 * cannot afford: what it does not visit, it implicitly allows.
 */
function flatten(node: CssNode): CssNode[] {
  const collected: CssNode[] = [node];

  for (const value of Object.values(node as unknown as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;

    if ('type' in value && typeof (value as { type: unknown }).type === 'string') {
      collected.push(...flatten(value as CssNode));
      continue;
    }
    if (typeof (value as { toArray?: unknown }).toArray === 'function') {
      for (const child of (value as List<CssNode>).toArray()) collected.push(...flatten(child));
    }
  }

  return collected;
}

/** Checks one declaration's value for banned constructs and out-of-range numbers. */
function checkValue(node: CssNode, property: string, path: string, log: IssueLog): void {
  if (node.type === 'Raw') {
    log.add(path, `The value of "${property}" could not be parsed. Rewrite it in plain CSS; unparsed text is never forwarded.`);
    return;
  }

  const nodes = flatten(node);

  // An empty value is a typo the browser drops silently. Saying so costs one
  // line and saves someone an afternoon wondering why their rule does nothing.
  const meaningful = nodes.filter((child) => child !== node && child.type !== 'WhiteSpace');
  if (!property.startsWith('--') && meaningful.length === 0) {
    log.add(path, `"${property}" has no value.`);
  }

  for (const child of nodes) {
    if (child.type === 'Url') {
      log.add(path, 'url() is not allowed anywhere, including inside custom properties. Every image, font and texture is app-owned — select a texture by name in the theme spec instead.');
    }
    if (child.type === 'Function' && !ALLOWED_FUNCTIONS.has(child.name.toLowerCase())) {
      log.add(path, `The function "${child.name}()" is not allowed. Allowed functions are colour, gradient, filter, transform and maths functions plus var()/calc().`);
    }
  }

  if (property === 'opacity') {
    for (const child of nodes) {
      const value = readNumber(child);
      if (value !== null && value < MIN_OPACITY) {
        log.add(path, `opacity ${value} is below the ${MIN_OPACITY} floor. A theme may fade an element; it may not make it invisible.`);
      }
    }
  }

  if (property === 'filter' || property === 'backdrop-filter' || property === '-webkit-backdrop-filter') {
    for (const child of nodes) {
      if (child.type !== 'Function') continue;
      const name = child.name.toLowerCase();
      if (name !== 'brightness' && name !== 'contrast') continue;
      for (const argument of children(child.children)) {
        const value = readNumber(argument);
        if (value !== null && (value < FILTER_RANGE.low || value > FILTER_RANGE.high)) {
          log.add(path, `${name}(${value}) is outside the allowed ${FILTER_RANGE.low}-${FILTER_RANGE.high} range. Beyond it the filter erases what is underneath rather than adjusting it.`);
        }
      }
    }
  }

  if (property.startsWith('transition') || property.startsWith('animation')) {
    const isTransition = property.startsWith('transition');
    const limit = isTransition ? MAX_TRANSITION_MS : MAX_ANIMATION_MS;

    for (const child of nodes) {
      const milliseconds = readMilliseconds(child);
      if (milliseconds !== null && milliseconds > limit) {
        log.add(path, isTransition
          ? `${milliseconds}ms exceeds the ${limit}ms limit for a transition. The user is waiting on a transition, and one that long reads as the app being stuck. If this is ambient decoration rather than a response, use an animation — those may run up to ${MAX_ANIMATION_MS}ms.`
          : `${milliseconds}ms exceeds the ${limit}ms limit for an animation.`);
      }
    }
  }

  if (property === 'scale' || property === 'transform') {
    for (const child of nodes) {
      const isScaleFunction = child.type === 'Function' && child.name.toLowerCase().startsWith('scale');
      const scalars = isScaleFunction
        ? children((child as { children: List<CssNode> }).children)
        : property === 'scale' ? nodes : [];
      for (const scalar of scalars) {
        const value = readNumber(scalar);
        if (value !== null && Math.abs(value) < MIN_SCALE) {
          log.add(path, `A scale of ${value} collapses the element to nothing, which is "display: none" spelled differently.`);
        }
      }
    }
  }

  if (property.startsWith('margin')) {
    for (const child of nodes) {
      const negative = (child.type === 'Dimension' || child.type === 'Number' || child.type === 'Percentage')
        && Number.parseFloat(child.value) < 0;
      if (negative) {
        log.add(path, `Negative margins are not allowed: they let a surface slide over controls it does not own. Use padding, or ask for the layout you need.`);
      }
    }
  }

  if (property === 'content') {
    const meaningful = children(('children' in node ? node.children : null) as List<CssNode> | null)
      .filter((child) => child.type !== 'WhiteSpace');
    const allowed = meaningful.length === 1
      && ((meaningful[0].type === 'String' && meaningful[0].value === '')
        || (meaningful[0].type === 'Identifier' && meaningful[0].name.toLowerCase() === 'none'));
    if (!allowed) {
      log.add(path, 'content may only be "" or none. Generated text is content, and a theme does not get to write content.');
    }
  }
}

/**
 * Validates one complex selector.
 *
 * Reports whether it ends at a generated element and whether it reaches the
 * document root, because two of the property rules depend on which of those is
 * true rather than on the property alone.
 */
function checkSelector(
  selector: CssNode,
  path: string,
  log: IssueLog,
): { pseudoElement: boolean; documentRoot: boolean } {
  const parts = children('children' in selector ? (selector.children as List<CssNode>) : null);
  let pseudoElement = false;
  let rooted = false;
  let documentRoot = false;

  parts.forEach((part, index) => {
    switch (part.type) {
      case 'TypeSelector':
        log.add(path, part.name === '*'
          ? 'The universal selector is not allowed. Root every rule at a [data-tails-part], [data-tails-surface], .t-*, .prose-tails or :root selector.'
          : `Bare type selectors like "${part.name}" are not allowed — they reach markup the theme cannot see. Use a .t-* class or a data-tails-* attribute.`);
        break;

      case 'IdSelector':
        log.add(path, 'ID selectors are not allowed. Themes target roles, not instances.');
        break;

      case 'AttributeSelector': {
        const name = part.name.name.toLowerCase();
        if (name === CRITICAL_ATTRIBUTE) {
          log.add(path, `[${CRITICAL_ATTRIBUTE}] marks the parts of the interface a theme may never restyle — permission prompts and the like. It is unreachable by design.`);
        } else if (!ALLOWED_ATTRIBUTES.has(name)) {
          log.add(path, `[${name}] is not a themeable attribute. Allowed: ${[...ALLOWED_ATTRIBUTES].join(', ')}.`);
        } else if (index === 0 && (name === 'data-tails-part' || name === 'data-tails-surface')) {
          rooted = true;
        }
        break;
      }

      case 'ClassSelector': {
        const isThemeClass = part.name.startsWith('t-') || part.name === 'prose-tails';
        if (!isThemeClass) {
          log.add(path, `".${part.name}" is not a theme class. Only .t-* and .prose-tails are addressable; every other class is an implementation detail that will move.`);
        } else if (index === 0) {
          rooted = true;
        }
        break;
      }

      case 'PseudoClassSelector': {
        const name = part.name.toLowerCase();
        if (!ALLOWED_PSEUDO_CLASSES.has(name)) {
          log.add(path, name === 'has'
            ? ':has() is not allowed: it lets a rule match on descendants, which is how a selector reaches something it was scoped away from.'
            : `":${name}" is not an allowed pseudo-class.`);
          break;
        }
        if (name === 'root') {
          documentRoot = parts.length === 1;
          if (index === 0) rooted = true;
        }
        // `:not()`, `:is()` and `:where()` carry selectors of their own, and an
        // unchecked one is a hole straight through everything above.
        for (const nested of children(part.children as List<CssNode> | null)) {
          if (nested.type === 'SelectorList') {
            for (const inner of children(nested.children)) {
              checkSelector(inner, `${path}:${name}()`, log);
            }
          }
        }
        break;
      }

      case 'PseudoElementSelector': {
        const name = part.name.toLowerCase();
        if (!ALLOWED_PSEUDO_ELEMENTS.has(name)) {
          log.add(path, `"::${name}" is not an allowed pseudo-element.`);
        }
        if (name === 'before' || name === 'after') pseudoElement = true;
        break;
      }

      case 'Combinator':
      case 'NestingSelector':
      case 'Nth':
      case 'AnPlusB':
      case 'Identifier':
      case 'Percentage':
        break;

      default:
        log.add(path, `Unsupported selector fragment "${part.type}".`);
    }
  });

  if (!rooted) {
    log.add(path, 'Every rule must start at [data-tails-part="..."], [data-tails-surface="..."], a .t-* class, .prose-tails, or :root. An unrooted selector styles parts of the app the theme was not given.');
  }

  return { pseudoElement, documentRoot };
}

type RuleContext = { depth: number; inKeyframes: boolean };

/** Counts as it goes, so budget failures are reported with the rest. */
type Counters = { rules: number; declarations: number };

function checkDeclarations(
  block: CssNode,
  path: string,
  options: { pseudoElement: boolean; documentRoot: boolean; descriptors: Set<string> | null },
  counters: Counters,
  log: IssueLog,
  context: RuleContext,
): void {
  if (block.type !== 'Block') return;

  for (const [index, node] of children(block.children).entries()) {
    if (node.type === 'Rule' || node.type === 'Atrule') {
      // CSS nesting. Depth is capped because each level multiplies the
      // specificity surface, and a theme nested four deep is one nobody can
      // reason about — including the model that wrote it.
      checkNode(node, `${path}[${index}]`, counters, log, { ...context, depth: context.depth + 1 });
      continue;
    }

    if (node.type !== 'Declaration') {
      log.add(`${path}[${index}]`, `Unsupported node "${node.type}" inside a rule.`);
      continue;
    }

    counters.declarations += 1;
    const property = node.property.toLowerCase();
    const declarationPath = `${path}.${property}`;

    if (node.important) {
      log.add(declarationPath, '!important is not allowed. It outranks the app\'s own styles, including the ones that keep controls usable.');
    }

    if (options.descriptors) {
      if (!options.descriptors.has(property)) {
        log.add(declarationPath, `"${property}" is not a valid @property descriptor. Allowed: ${[...options.descriptors].join(', ')}.`);
      }
      checkValue(node.value, property, declarationPath, log);
      continue;
    }

    // Fading the root fades the whole application at once, and does it from a
    // selector no component can override. The floor that keeps a single card
    // visible does nothing here, so `:root` gets the property removed outright.
    if (property === 'opacity' && options.documentRoot) {
      log.add(declarationPath, 'opacity on :root fades the entire application from a selector nothing can override. Set it on a specific surface instead.');
    }

    const isCustomProperty = property.startsWith('--');
    if (!isCustomProperty && !ALLOWED_PROPERTIES.has(property)) {
      if (PSEUDO_ONLY_PROPERTIES.has(property)) {
        if (!options.pseudoElement) {
          log.add(declarationPath, `"${property}" is only allowed inside a ::before or ::after rule. On a real element it changes layout, and layout is the app's to decide.`);
        } else if (property === 'z-index') {
          for (const child of flatten(node.value)) {
            const value = readNumber(child);
            if (value !== null && value > MAX_PSEUDO_Z_INDEX) {
              log.add(declarationPath, `z-index ${value} exceeds the ${MAX_PSEUDO_Z_INDEX} cap for decorations. Above it a decoration can cover a control.`);
            }
          }
        }
      } else {
        log.add(declarationPath, `"${property}" is not a themeable property. Layout, sizing, visibility and interaction properties are excluded on purpose — a theme changes how the app looks, not what it shows or whether it can be used.`);
      }
    }

    checkValue(node.value, property, declarationPath, log);
  }
}

function checkNode(
  node: CssNode,
  path: string,
  counters: Counters,
  log: IssueLog,
  context: RuleContext,
): void {
  if (context.depth > FREEFORM_BUDGETS.nesting) {
    log.add(path, `Nesting deeper than ${FREEFORM_BUDGETS.nesting} levels is not allowed.`);
    return;
  }

  if (node.type === 'Rule') {
    counters.rules += 1;

    if (context.inKeyframes) {
      // Keyframe selectors are `from`, `to` and percentages — none of which are
      // element selectors, so the selector rules above would reject all of them.
      checkDeclarations(node.block, path, { pseudoElement: false, documentRoot: false, descriptors: null }, counters, log, context);
      return;
    }

    if (node.prelude.type === 'Raw') {
      log.add(`${path}.selector`, 'The selector could not be parsed.');
      return;
    }

    let pseudoElement = false;
    let documentRoot = false;
    for (const selector of children(node.prelude.children)) {
      const checked = checkSelector(selector, `${path}.selector`, log);
      if (checked.pseudoElement) pseudoElement = true;
      if (checked.documentRoot) documentRoot = true;
    }

    checkDeclarations(node.block, path, { pseudoElement, documentRoot, descriptors: null }, counters, log, context);
    return;
  }

  if (node.type === 'Atrule') {
    const name = node.name.toLowerCase();
    if (!ALLOWED_AT_RULES.has(name)) {
      log.add(`${path}.@${name}`, name === 'import'
        ? '@import fetches a stylesheet over the network. Nothing in a theme may reach off the machine.'
        : name === 'font-face'
          ? '@font-face loads a font file. Pick one of the bundled families in the theme spec instead.'
          : `"@${name}" is not an allowed at-rule. Allowed: @keyframes, @property, and @media limited to prefers-color-scheme, prefers-reduced-motion and forced-colors.`);
      return;
    }

    if (name === 'media') {
      const features = node.prelude && node.prelude.type !== 'Raw'
        ? flatten(node.prelude).filter((child) => child.type === 'Feature')
        : [];
      if (features.length === 0) {
        log.add(`${path}.@media`, '@media must query one of prefers-color-scheme, prefers-reduced-motion or forced-colors. A bare or unparsed query is rejected.');
      }
      for (const feature of features) {
        const featureName = (feature as { name: string }).name.toLowerCase();
        if (!ALLOWED_MEDIA_FEATURES.has(featureName)) {
          log.add(`${path}.@media`, `"${featureName}" is not a queryable media feature. Allowed: ${[...ALLOWED_MEDIA_FEATURES].join(', ')}. Viewport and device queries would let a theme fingerprint the machine.`);
        }
      }
      // A media type such as `screen` or `print` alongside the feature is fine
      // to reject wholesale: it adds nothing a theme needs.
      const mediaTypes = flatten(node.prelude as CssNode)
        .filter((child) => child.type === 'MediaQuery' && (child as { mediaType?: string | null }).mediaType);
      if (mediaTypes.length > 0) {
        log.add(`${path}.@media`, 'Media types are not allowed in a theme query; use the feature on its own, e.g. @media (prefers-reduced-motion: reduce).');
      }
    }

    if (node.block) {
      const descriptors = name === 'property' ? ALLOWED_PROPERTY_DESCRIPTORS : null;
      if (descriptors) {
        checkDeclarations(node.block, `${path}.@property`, { pseudoElement: false, documentRoot: false, descriptors }, counters, log, context);
        return;
      }

      for (const [index, child] of children(node.block.children).entries()) {
        checkNode(child, `${path}.@${name}[${index}]`, counters, log, {
          depth: context.depth + 1,
          inKeyframes: context.inKeyframes || name === 'keyframes',
        });
      }
    }
    return;
  }

  if (node.type === 'Declaration') {
    // A declaration at the top level of a stylesheet is a syntax error the
    // parser recovered from rather than something to style.
    log.add(path, 'A declaration cannot sit outside a rule.');
    return;
  }

  if (node.type === 'Comment' || node.type === 'Raw') return;

  log.add(path, `Unsupported top-level node "${node.type}".`);
}

/**
 * Validates author CSS and returns a stylesheet built from the parsed tree.
 *
 * The success value is deliberately the CSS rather than a boolean: a caller
 * that has to remember to use a *different* string than the one it passed in
 * will eventually forget, and forgetting means author bytes reach the renderer.
 * Making the safe string the only thing you get back removes that mistake from
 * the API.
 */
export function validateFreeformCss(css: string): FreeformResult {
  const log = new IssueLog();

  const bytes = Buffer.byteLength(css, 'utf8');
  if (bytes > FREEFORM_BUDGETS.bytes) {
    log.add('css', `The stylesheet is ${bytes} bytes; the limit is ${FREEFORM_BUDGETS.bytes}. Trim it rather than splitting it across calls.`);
    return { ok: false, issues: log.issues };
  }

  if (css.trim() === '') return { ok: true, css: '' };

  let ast: CssNode;
  try {
    ast = parse(css, {
      positions: false,
      parseCustomProperty: true,
      onParseError: (error) => {
        log.add('css', `Parse error: ${error.message}`);
      },
    });
  } catch (error) {
    return {
      ok: false,
      issues: [{ path: 'css', message: `The stylesheet could not be parsed: ${error instanceof Error ? error.message : String(error)}` }],
    };
  }

  if (ast.type !== 'StyleSheet') {
    return { ok: false, issues: [{ path: 'css', message: 'Expected a stylesheet.' }] };
  }

  const counters: Counters = { rules: 0, declarations: 0 };
  for (const [index, node] of children(ast.children).entries()) {
    checkNode(node, `rule[${index}]`, counters, log, { depth: 1, inKeyframes: false });
  }

  if (counters.rules > FREEFORM_BUDGETS.rules) {
    log.add('css', `${counters.rules} rules exceeds the limit of ${FREEFORM_BUDGETS.rules}.`);
  }
  if (counters.declarations > FREEFORM_BUDGETS.declarations) {
    log.add('css', `${counters.declarations} declarations exceeds the limit of ${FREEFORM_BUDGETS.declarations}.`);
  }

  if (log.issues.length > 0) return { ok: false, issues: log.issues };

  return { ok: true, css: generate(ast) };
}
