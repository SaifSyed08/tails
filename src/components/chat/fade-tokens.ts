/**
 * Making streamed text arrive rather than appear.
 *
 * ## Why this is a rehype plugin and not a CSS transition
 *
 * The reply is rendered as markdown *while it streams*, so the thing on screen
 * is a live tree that is re-rendered every flush. There is no element whose
 * "new text" could be transitioned: the paragraph that gains three words is the
 * same paragraph element it was before, and animating it would fade the words
 * already being read along with the new ones.
 *
 * What is genuinely new on each flush is a *word*. So each word becomes its own
 * element. React reconciles them by position, which means an existing word
 * keeps its element and its finished animation, and a word that has just
 * arrived mounts fresh and plays one. The effect is words easing in at the
 * leading edge while everything behind them stays put.
 *
 * ## Only while streaming
 *
 * A span per word is cheap for one message and wasteful for a transcript of
 * two hundred, so the plugin is applied to the streaming row alone. When the
 * turn finishes, the row is replaced by the settled message and renders as
 * ordinary markdown — with no visual change, because every animation has
 * already ended at full opacity.
 *
 * ## What it must not touch
 *
 * Code. Whitespace inside `pre`/`code` is significant and a highlighter's
 * output is a structure of its own; splitting text nodes in there changes what
 * the user is being shown. Everything under those elements is left alone.
 */

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

/** Elements whose text is left exactly as it is. See the note above. */
const OPAQUE = new Set(['code', 'pre', 'kbd', 'samp', 'math']);

/**
 * Splits on whitespace but *keeps* it.
 *
 * The separators are part of the text, not gaps between it: dropping them and
 * relying on a gap between inline elements collapses runs of spaces, loses the
 * newline inside a wrapped paragraph, and changes where lines break. The
 * capture group is what makes the join lossless.
 */
const WORDS = /(\s+)/;

/**
 * Splits one text node, wrapping only the part inside the tail window.
 *
 * `from` is an offset *within this node*, and it has to be, which cost a
 * measurement to learn: the window was first applied a whole node at a time, and
 * markdown puts an entire paragraph in a single text node — so a one-paragraph
 * reply was wrapped end to end and the bound did nothing. Measured at 235 spans
 * where it should have been about a hundred.
 *
 * The cut is nudged forward to the next space so a word is never split across a
 * plain node and a span, which would show up as a gap the browser is free to
 * break a line inside.
 */
function wrap(node: HastNode, from = 0): HastNode[] {
  const text = node.value ?? '';
  if (!text) return [node];

  if (from > 0) {
    if (from >= text.length) return [node];

    const boundary = (() => {
      const space = text.slice(from).search(/\s/);
      return space < 0 ? text.length : from + space;
    })();

    const head = text.slice(0, boundary);
    const tail = text.slice(boundary);
    if (!tail) return [node];

    return [
      ...(head ? [{ type: 'text', value: head } as HastNode] : []),
      ...wrap({ type: 'text', value: tail }),
    ];
  }

  const parts = text.split(WORDS).filter((part) => part !== '');

  return parts.map((part) => {
    // Whitespace stays a bare text node. A span around a space would animate
    // nothing visible and doubles the element count for no reason.
    if (!part.trim()) return { type: 'text', value: part };

    return {
      type: 'element',
      tagName: 'span',
      properties: { className: ['tails-token'] },
      children: [{ type: 'text', value: part }],
    };
  });
}

/**
 * How much of the tail is worth animating, in characters.
 *
 * Only the leading edge is ever in motion, so wrapping the whole document is
 * work with nothing to show for it — and the cost is not small. A two-thousand
 * word reply is two thousand spans, rebuilt and reconciled on every flush, ten
 * times a second, to animate the nine words at the end. Six hundred characters
 * is roughly a hundred words, which is far more than the eye can follow at any
 * plausible token rate.
 *
 * Text falling out of the window becomes a plain text node again. React
 * remounts it, and it mounts with no animation attached, so nothing flashes:
 * the words are already at full opacity by the time they get that far back.
 */
const TAIL_CHARACTERS = 600;

/** Total length of the text this tree holds, ignoring anything opaque. */
function textLength(node: HastNode): number {
  if (node.type === 'text') return (node.value ?? '').length;
  if (!node.children) return 0;
  if (node.tagName && OPAQUE.has(node.tagName)) return 0;
  return node.children.reduce((sum, child) => sum + textLength(child), 0);
}

/**
 * Walks the tree, wrapping words only near the end of it.
 *
 * `state.offset` is the character position reached so far, in document order,
 * which is what makes "near the end" answerable while descending — the tree is
 * walked once and the boundary is a comparison rather than a second pass over
 * the nodes that matter.
 */
function walk(node: HastNode, from: number, state: { offset: number }): void {
  if (!node.children) return;
  if (node.tagName && OPAQUE.has(node.tagName)) return;

  const next: HastNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text') {
      const start = state.offset;
      const length = (child.value ?? '').length;
      state.offset = start + length;

      if (state.offset <= from) {
        // Entirely behind the window.
        next.push(child);
      } else {
        // Partly or wholly inside it. `from - start` is where the window begins
        // *within this node*, which is zero or negative when the whole node is
        // inside — see `wrap`.
        next.push(...wrap(child, Math.max(0, from - start)));
      }
    } else {
      walk(child, from, state);
      next.push(child);
    }
  }
  node.children = next;
}

/**
 * Wraps every word in a span so that a newly arrived one can fade in.
 *
 * Written against the tree directly rather than with `unist-util-visit`,
 * because it is a dozen lines and the alternative is a dependency in the
 * renderer's hot path for a walk this app already knows how to do.
 */
export function rehypeFadeTokens() {
  return (tree: HastNode): void => {
    const total = textLength(tree);
    walk(tree, Math.max(0, total - TAIL_CHARACTERS), { offset: 0 });
  };
}
