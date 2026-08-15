import { generate, parse, type CssNode, type List } from 'css-tree';

/**
 * The escape hatch: author-supplied CSS, parsed, validated and rebuilt.
 *
 * Three rules make the price of running an author's stylesheet payable.
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
 * ---
 *
 * **What this file used to be, and why it is not that any more.**
 *
 * It shipped with a property allowlist of two hundred names, an opacity floor,
 * ranges on `brightness()` and `contrast()`, a minimum scale, a z-index cap, a
 * pseudo-element allowlist, a three-feature media allowlist, a ban on
 * `!important` and a ban on negative margins. Almost all of that existed to
 * prevent an *ugly* result rather than an unsafe one, and preventing ugly
 * results is not worth the cost of preventing good ones: every rule of that
 * shape also blocked a look nobody had thought of, which is the only kind of
 * look this feature exists to produce.
 *
 * So the aesthetic rules are gone and the judgement they encoded is written
 * down instead — in this file as comments, and in the tool descriptions the
 * model actually reads. What survives is a short list that is not about taste:
 *
 * 1. **`url()` is refused everywhere**, in every spelling, including inside
 *    custom properties and including the functions that name a resource under
 *    another name. A stylesheet that can name a remote URL can report what the
 *    user is doing to whoever owns it, and CSS has no way to ask permission
 *    first. `@import` is refused for the same reason and not a separate one:
 *    its string form fetches without ever writing `url(`.
 * 2. **`[data-tails-critical]` cannot be named by any selector.** Permission
 *    prompts and the plan-approval row carry it. The guarantee is precisely
 *    "cannot be targeted", not "cannot be affected" — inheritance from `:root`
 *    reaches everything and always did — and targeting is the half that
 *    matters, because it is the half that lets a stylesheet make *yes* look
 *    like *no*.
 * 3. **A theme cannot write text.** `content` is limited to `""` and `none`.
 *    This is kept for the same reason as (2) rather than as a style rule:
 *    generated text reads to the user as the application's own words, and a
 *    stylesheet that can put "Safe to approve" next to a button is a deception
 *    primitive whatever else it is.
 *
 * The two rules the renderer and the service hold up, which are not visible
 * here but are what make the rest of this affordable: the layer is **never
 * persisted**, so a reload always clears it, and the **panic key is handled in
 * the Electron main process**, where no stylesheet and no renderer bug can
 * reach it. That pair is why the worst case of a bad stylesheet is "reload the
 * window" rather than "the app opens broken and the thing that would fix it is
 * the thing that is broken" — and it is why a hidden control is now a bad idea
 * the author is trusted not to have, rather than a blocked one.
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
 *
 * `nesting` is generous now that `@supports`, `@scope` and `@container` are
 * allowed: each of those costs a level, so the old depth of three would have
 * made a perfectly ordinary conditional rule unreachable.
 */
export const FREEFORM_BUDGETS = {
  bytes: 32 * 1024,
  rules: 200,
  declarations: 1500,
  nesting: 8,
} as const;

/**
 * Functions a value may not call.
 *
 * A denylist, and a short one, because it is not a taste rule: every entry is
 * either a way to name a resource — which is `url()` wearing a different name —
 * or a way to read the DOM into a value, which is the other half of an
 * exfiltration primitive. Anything not listed here is allowed, including the
 * ones nobody has invented yet, which is the correct trade now that the *only*
 * thing being defended is the network boundary rather than the whole look.
 */
const DENIED_FUNCTIONS = new Map<string, string>([
  ['url', 'url() is not allowed anywhere, including inside custom properties.'],
  ['image-set', 'image-set() names a resource, which is url() by another spelling.'],
  ['-webkit-image-set', '-webkit-image-set() names a resource, which is url() by another spelling.'],
  ['image', 'image() names a resource, which is url() by another spelling.'],
  ['src', 'src() names a resource, which is url() by another spelling.'],
  ['element', 'element() paints another part of the page into this one, which reaches markup the theme was not given.'],
  ['attr', 'attr() reads the DOM into a value. Combined with anything that leaves the machine that is an exfiltration primitive, so it is refused on its own.'],
]);

/** Every function name is tested lower-cased, so the map keys must be too. */
const RESOURCE_HINT = 'Every image, font and texture is app-owned: select a texture by name in the theme spec, or draw it with a gradient.';

/** Pseudo-classes and pseudo-elements are unrestricted; this is the one attribute that is not. */
const CRITICAL_ATTRIBUTE = 'data-tails-critical';

/**
 * At-rules a theme may not use.
 *
 * One entry, and it is the network rule rather than a fourth policy:
 * `@import "https://…"` fetches a stylesheet using a string, so the `url()` ban
 * does not see it. Everything else — `@supports`, `@layer`, `@container`,
 * `@scope`, `@font-face`, `@counter-style`, `@view-transition`, `@page` — is
 * allowed. `@font-face` is safe *because* of the url() ban: `src: local(…)` can
 * only name a face already on the machine, and `src: url(…)` never parses past
 * this file.
 */
const DENIED_AT_RULES = new Map<string, string>([
  ['import', '@import fetches a stylesheet over the network, and its string form does it without ever writing url(). Nothing in a theme may reach off the machine.'],
]);

/** `@property` descriptors. Not a restriction — these are the only three that exist. */
const ALLOWED_PROPERTY_DESCRIPTORS = new Set(['syntax', 'inherits', 'initial-value']);

const children = (list: List<CssNode> | undefined | null): CssNode[] =>
  (list ? list.toArray() : []);

/**
 * A CSS identifier with its escapes resolved, lower-cased.
 *
 * This is the difference between the `url()` ban holding and merely appearing
 * to. `u\72 l("https://…")` is a perfectly ordinary function call to a browser —
 * `\72` is `r` — and css-tree hands it over as a `Function` whose `name` is the
 * literal escaped text, which matches no denylist entry written the obvious
 * way. It is also the case the whole "parse, never pattern-match" rule was
 * written for, and it would have been quietly reintroduced by swapping the
 * function allowlist for a denylist: an allowlist refuses the unrecognised
 * spelling for free, and a denylist has to go and recognise it.
 *
 * Both escape forms are handled: `\` plus one to six hex digits with an
 * optional trailing space, and `\` plus any single character.
 */
const decodeIdentifier = (name: string): string =>
  name.replace(
    /\\(?:([0-9a-fA-F]{1,6})[ \t\r\n\f]?|(.))/gs,
    (_, hex: string | undefined, literal: string | undefined) =>
      (hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : literal ?? ''),
  ).toLowerCase();

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

/**
 * Every node in a subtree, flattened.
 *
 * Walks named node properties as well as `children`, because css-tree hangs
 * some of the tree off named slots — a media query's condition, an attribute
 * selector's name, the selector list inside `:is()` — and a traversal that only
 * follows `children` silently sees an empty `@media` prelude. Missing a node is
 * the failure mode a validator cannot afford: what it does not visit, it
 * implicitly allows.
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

/**
 * Checks a parsed value for the things that are still refused.
 *
 * Shared with `validateTokenValue` below rather than reimplemented there:
 * `theme_controls` writes custom properties straight onto `:root` at runtime
 * and never passes through this file's rule walk, so a second, weaker copy of
 * this check would be a hole through the one rule that has no aesthetic
 * component at all.
 */
function checkValueNodes(node: CssNode, property: string, path: string, log: IssueLog): void {
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
      log.add(path, `${DENIED_FUNCTIONS.get('url')} ${RESOURCE_HINT}`);
      continue;
    }
    if (child.type !== 'Function') continue;

    // An escaped function name is never something a theme author meant to
    // write, and it is exactly what an attempt to smuggle `url()` past a name
    // check looks like. Refused on sight as well as after decoding, so the ban
    // does not rest on this file's escape decoder being complete.
    if (child.name.includes('\\')) {
      log.add(path, `"${child.name}()" is written with character escapes. Function names must be spelled literally — an escaped name is how a banned function gets past a check that reads it as text.`);
      continue;
    }

    const denied = DENIED_FUNCTIONS.get(decodeIdentifier(child.name));
    if (denied) log.add(path, `${denied} ${RESOURCE_HINT}`);
  }

  // Generated text reads as the application's own words. See the header: this
  // is the deception rule, not a style rule, which is why it outlived the
  // property allowlist it used to sit beside.
  if (property === 'content') {
    const parts = children(('children' in node ? node.children : null) as List<CssNode> | null)
      .filter((child) => child.type !== 'WhiteSpace');
    const allowed = parts.length === 1
      && ((parts[0].type === 'String' && parts[0].value === '')
        || (parts[0].type === 'Identifier' && parts[0].name.toLowerCase() === 'none'));
    if (!allowed) {
      log.add(path, 'content may only be "" or none. A decoration is yours to draw; the words on screen are the application\'s, and a stylesheet that can write next to a permission prompt can lie about what it says.');
    }
  }
}

/**
 * Validates one complex selector.
 *
 * There is one rule left. Type selectors, `#id`, `*`, arbitrary attributes,
 * `:has()` and every pseudo-element are all allowed now — the requirement that
 * a rule be "rooted" in the theme namespace was ownership etiquette rather than
 * safety, and it made whole categories of look (a styled caret, a themed
 * selection, an ambient layer on the page itself) impossible to express.
 *
 * The flatten-then-scan shape matters: `:not()`, `:is()`, `:where()` and
 * `:has()` carry selector lists of their own, and a walk that only inspected
 * the top level would let `[data-tails-critical]` back in one nesting level
 * down.
 */
function checkSelector(selector: CssNode, path: string, log: IssueLog): void {
  for (const part of flatten(selector)) {
    if (part.type !== 'AttributeSelector') continue;
    // Decoded, for the same reason function names are: `[data-tails-critic\61 l]`
    // selects the attribute a plain string comparison would say it does not.
    if (decodeIdentifier(part.name.name) !== CRITICAL_ATTRIBUTE) continue;
    log.add(path, `[${CRITICAL_ATTRIBUTE}] marks the parts of the interface a theme may never target — permission prompts, the plan-approval row, the destructive-action confirm. It is unreachable by design, including from inside :not(), :is() and :has().`);
  }
}

/** Counts as it goes, so budget failures are reported with the rest. */
type Counters = { rules: number; declarations: number };

function checkDeclarations(
  block: CssNode,
  path: string,
  descriptors: Set<string> | null,
  counters: Counters,
  log: IssueLog,
  depth: number,
): void {
  if (block.type !== 'Block') return;

  for (const [index, node] of children(block.children).entries()) {
    if (node.type === 'Rule' || node.type === 'Atrule') {
      // CSS nesting, which is now the ordinary way to write a theme rather than
      // an exception. Depth is still capped, because a theme nested eight deep
      // is one nobody can reason about — including the model that wrote it.
      checkNode(node, `${path}[${index}]`, counters, log, depth + 1);
      continue;
    }

    if (node.type !== 'Declaration') {
      log.add(`${path}[${index}]`, `Unsupported node "${node.type}" inside a rule.`);
      continue;
    }

    counters.declarations += 1;
    const property = node.property.toLowerCase();
    const declarationPath = `${path}.${property}`;

    if (descriptors && !descriptors.has(property)) {
      log.add(declarationPath, `"${property}" is not a valid @property descriptor. The only three are: ${[...descriptors].join(', ')}.`);
    }

    checkValueNodes(node.value, property, declarationPath, log);
  }
}

function checkNode(
  node: CssNode,
  path: string,
  counters: Counters,
  log: IssueLog,
  depth: number,
): void {
  if (depth > FREEFORM_BUDGETS.nesting) {
    log.add(path, `Nesting deeper than ${FREEFORM_BUDGETS.nesting} levels is not allowed.`);
    return;
  }

  if (node.type === 'Rule') {
    counters.rules += 1;

    if (node.prelude.type === 'Raw') {
      log.add(`${path}.selector`, 'The selector could not be parsed.');
      return;
    }

    // Keyframe selectors (`from`, `to`, `50%`) run through the same walk and
    // pass it trivially, which is the point of having exactly one selector
    // rule: there is no longer a context in which a selector means something
    // different, so there is no longer a special case to get wrong.
    for (const selector of children(node.prelude.children)) {
      checkSelector(selector, `${path}.selector`, log);
    }

    checkDeclarations(node.block, path, null, counters, log, depth);
    return;
  }

  if (node.type === 'Atrule') {
    const name = decodeIdentifier(node.name);
    const denied = DENIED_AT_RULES.get(name);
    if (denied) {
      log.add(`${path}.@${name}`, denied);
      return;
    }

    // Media, container and supports conditions are unrestricted. A viewport or
    // resolution query used to be refused as a fingerprinting risk; without
    // url() there is nothing for a fingerprint to be reported *to*, so all the
    // rule ever did was stop a theme from adapting to the window it is in.
    if (node.block) {
      if (name === 'property') {
        checkDeclarations(node.block, `${path}.@property`, ALLOWED_PROPERTY_DESCRIPTORS, counters, log, depth);
        return;
      }

      // A declaration directly inside `@media` or `@scope` is legal nested CSS,
      // and `checkDeclarations` already recurses into any rules beside it — so
      // the presence of one declaration decides how the whole block is walked
      // rather than being handled per child, which would report the second
      // declaration in a mixed block as "outside a rule".
      const body = children(node.block.children);
      if (body.some((child) => child.type === 'Declaration')) {
        checkDeclarations(node.block, `${path}.@${name}`, null, counters, log, depth);
        return;
      }

      for (const [index, child] of body.entries()) {
        checkNode(child, `${path}.@${name}[${index}]`, counters, log, depth + 1);
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
    checkNode(node, `rule[${index}]`, counters, log, 1);
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

/**
 * Validates one custom-property value, returning the text the renderer may set.
 *
 * The live-controls path never goes through a stylesheet: a slider writes its
 * value onto `:root` with `setProperty`, so nothing above would ever see it.
 * That is fine for every rule that became guidance and fatal for the one that
 * did not — a colour picker whose value was `url(https://…)` would reopen the
 * exfiltration hole from the one place nobody thinks to look. So the value is
 * parsed and walked with the same code, and the caller gets back the
 * *re-serialised* text for the same reason `validateFreeformCss` does.
 */
export function validateTokenValue(value: string, path = 'value'): FreeformResult {
  const log = new IssueLog();

  if (value.length > 512) {
    return { ok: false, issues: [{ path, message: 'A control value may not exceed 512 characters. A control sets one token, not a stylesheet.' }] };
  }

  let ast: CssNode;
  try {
    ast = parse(value, {
      context: 'value',
      positions: false,
      onParseError: (error) => log.add(path, `Parse error: ${error.message}`),
    });
  } catch (error) {
    return {
      ok: false,
      issues: [{ path, message: `The value could not be parsed: ${error instanceof Error ? error.message : String(error)}` }],
    };
  }

  // `--x` rather than a real property name: the empty-value and `content`
  // checks are property-specific and neither applies to a token.
  checkValueNodes(ast, '--x', path, log);

  if (log.issues.length > 0) return { ok: false, issues: log.issues };
  return { ok: true, css: generate(ast) };
}
