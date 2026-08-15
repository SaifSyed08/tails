# Renderer contract — appearance v2

What the appearance module emits, and what the renderer must do with it. This
file is the interface between `server/modules/appearance/` and `src/`. Nothing
in here is advisory: a token the renderer does not consume is a spec field the
model can set that changes nothing, which is the exact defect v2 was built to
remove.

---

## 1. Delivery

Themes arrive as a **stylesheet string**, over the existing `appearance_changed`
broadcast and from `GET /api/appearance/resolve`. The payload:

```ts
{
  layer: 'theme' | 'css' | 'controls' | 'proposal',
  scope: 'global' | 'session' | 'preview' | 'builtin',
  scopeKey: string,
  themeId: string,
  name: string,
  css: string,                       // '' means "drop this layer"
  pinnedMode: 'light' | 'dark' | null,

  controls?: AppearanceControl[],    // layer: 'controls' only, see §10
  variants?: ProposalVariant[],      // layer: 'proposal' only, see §11
}
```

`layer: 'theme'` and `layer: 'css'` are **two independent adopted stylesheets**,
in that order. The theme layer is derived and safe by construction; the CSS
layer is author-written, validated and re-serialised (§8). They must be separate
`CSSStyleSheet` objects so dropping one never disturbs the other.

`layer: 'controls'` and `layer: 'proposal'` adopt no stylesheet of their own and
always carry `css: ''`. Controls write individual custom properties as the user
drags them (§10); a proposal renders scoped miniatures and changes nothing about
the running app (§11).

The last two are **ephemeral, like the CSS layer**: never written to the
database, never returned from `/resolve`, gone on reload. That is not an
oversight to be tidied up later — it is what makes "reload the window" a
complete recovery path, and the loosened freeform validator (§8) depends on it.

Never write theme tokens as inline styles on `documentElement`. Inline styles
outrank every selector, so a theme applied that way silently defeats the `.dark`
overrides and breaks dark mode.

---

## 2. Selectors the stylesheet emits

```
:root                                   global tokens + the `default` surface
[data-tails-part="<name>"]              per-part surface tokens
[data-tails-surface="<tone>"]           per-tone overrides
.dark, .dark [data-tails-part="..."], .dark [data-tails-surface="..."]
```

Custom properties inherit, so any element carrying `data-tails-part` receives a
complete surface token set, and its descendants inherit it until another part
resets it. Every part emits every token — there are no partial sets to fall
through.

---

## 3. `data-tails-part` — which thing this is

Put the attribute on the element that owns the surface. Exactly these values
exist; anything else is inert.

| value | put it on |
| --- | --- |
| *(none)* | the `:root` set is the fallback for anything unmarked |
| `card` | panels, tool rows, plan/question cards |
| `sidebar` | the conversation list rail |
| `popover` | menus, dropdowns, floating panels |
| `header` | the app title bar |
| `input` | text fields and the composer shell |
| `button` | primary and secondary buttons |
| `code` | code blocks, terminal output, tool arguments |
| `scrim` | the dimming layer behind a modal |
| `bubbleUser` | the user's chat message bubble |
| `bubbleAssistant` | the assistant's chat message bubble |

## 4. `data-tails-surface` — what state this thing is in

A second, orthogonal axis. It overrides only `--t-fill-color` and `--t-ink`, so
it composes with any part.

| value | meaning |
| --- | --- |
| `flush` | sits on the page, no lift |
| `raised` | selected / hovered / active |
| `sunken` | pressed, or an inset well |
| `inverted` | maximum-contrast block |
| `accent` | filled with the primary colour |

Use it instead of hard-coding `bg-muted` for state. A literal utility class stops
following the theme; this does not.

## 5. `data-tails-critical` — the escape from theming

Put `data-tails-critical` on anything that must stay usable no matter what:
permission prompts, error banners, the destructive-action confirm. The freeform
CSS validator refuses any selector that mentions this attribute, so an author
stylesheet cannot reach it. The renderer should also skip `data-tails-part` on
those elements, so they keep the built-in ramp.

---

## 6. Tokens

### 6.1 Global (`:root` / `.dark`)

**Colours** — bare `H S% L%`, so Tailwind can compose `hsl(var(--x) / <alpha>)`.
Unchanged from v1; the Tailwind config already maps all of them.

```
--background --foreground --card --card-foreground --popover --popover-foreground
--primary --primary-foreground --secondary --secondary-foreground
--muted --muted-foreground --accent --accent-foreground
--destructive --destructive-foreground --positive --positive-foreground
--warning --warning-foreground --border --input --ring
```

**Scalars** — complete CSS values.

| token | grammar | who consumes it |
| --- | --- | --- |
| `--radius` | `<length>` e.g. `10px` | Tailwind `borderRadius` |
| `--border-width` | `<length>` | **STILL UNCONSUMED** — see the note below |
| `--space-unit` | `<length>` | **STILL UNCONSUMED** — see the note below |
| `--font-size-base` | `<length>` | `body { font-size }` |
| `--letter-spacing-base` | `<length>` / `em` | `body { letter-spacing }` |
| `--display-weight` | `<number>` 400–900 | `.prose-tails h1`, `.prose-tails h2` |
| `--line-height-base` | `<number>` | `body { line-height }` |
| `--measure` | `<length>` or `none` | `.prose-tails { max-inline-size }` |
| `--font-sans` `--font-serif` `--font-mono` `--font-display` | font stack | Tailwind `fontFamily` |
| `--duration-instant/quick/settle/reflow` | `<time>` | Tailwind `transitionDuration` |
| `--ease-enter/exit/standard/emphasis` | easing | Tailwind `transitionTimingFunction` |

Five of these were emitted by the derivation and read by nobody, which meant
`type.scale`, `type.letterSpacing`, `type.lineHeight`, `type.measure` and
`type.displayWeight` — five of the eight typographic knobs a model can set —
validated and then changed nothing. Exactly the v1 defect, surviving in the half
of the contract that lives in `src/index.css`. They are wired now.

Two are still not, and are recorded here rather than quietly left:

- **`--border-width`** needs `tailwind.config.js` to resolve border utilities
  from the token, which is a global change to every border in the app.
- **`--space-unit`** needs Tailwind's `spacing` scale fed as
  `calc(var(--space-unit) * N)`, which changes every padding and gap.

Both are real and both belong to whoever owns the Tailwind config. Until then,
`density` moves nothing and a theme's `border.width` only reaches elements that
carry `data-tails-part`.

**Interaction** — caret, selection and pointer, solved per ramp because every
default is a colour.

| token | grammar | who consumes it |
| --- | --- | --- |
| `--t-caret-color` | `<color>` | `body { caret-color }` |
| `--t-caret-shape` | `auto \| bar \| block \| underscore` | `body { caret-shape }` — Chromium 139+ |
| `--t-selection-fill` | `<color>` | `::selection { background-color }` |
| `--t-selection-ink` | `<color>` or `currentColor` | `::selection { color }` |
| `--t-cursor` | `<cursor>` keyword | `body { cursor }` |

**Renderer-owned, never emitted by the derivation.** These are defined in
`index.css` and written at runtime; a theme reads them, it does not set them.

| token | written by | for |
| --- | --- | --- |
| `--font-smoothing` | `index.css`, default `auto` | `body { -webkit-font-smoothing }` |
| `--pointer-x` `--pointer-y` | `pointerTokens.ts`, percentages | mouse-following gradients |
| `--pointer-px` `--pointer-py` | `pointerTokens.ts`, pixels | mouse-following transforms and shadows |

`--font-smoothing` exists because `-webkit-font-smoothing: antialiased` used to
be hard-coded on `body`. That is a macOS idiom; on Windows it switches Chromium
off DirectWrite subpixel rendering and onto grayscale, which at 13–15px is the
"the fonts look pixelated" complaint. It defaults to `auto` now and a theme that
genuinely wants the thinner rendering can ask.

### 6.2 Per-surface (`:root` and every `[data-tails-part]`)

Every one of these is emitted for every part, always, with a valid value —
`none`, `transparent`, `0` or `normal` when the recipe does not use it. The
renderer never needs a fallback in `var()`.

| token | grammar |
| --- | --- |
| `--t-fill-color` | `<color>` or `transparent` |
| `--t-fill-image` | `<image>#` or `none` |
| `--t-fill-blend` | `<blend-mode>#`, one per fill layer |
| `--t-fill-clip` | `<box>#`, one per fill layer |
| `--t-fill-origin` | `<box>#`, one per fill layer |
| `--t-border-width` | four lengths, `top right bottom left` |
| `--t-border-style` | `none \| solid \| dashed \| dotted \| double` |
| `--t-border-color` | `<color>` (`transparent` when a gradient ring is used) |
| `--t-radius` | `<length>` |
| `--t-corner-shape` | `round \| superellipse(4) \| bevel \| scoop \| notch` |
| `--t-shadow` | `<shadow>#` or `none` |
| `--t-backdrop` | `<filter-function-list>` or `none` |
| `--t-texture-image` | `<image>#` or `none`, alpha baked in |
| `--t-texture-size` | `<bg-size>` or `auto` |
| `--t-texture-opacity` | `0` or `1` — presence flag, **not** the strength |
| `--t-texture-blend` | `<blend-mode>` |
| `--t-overlay-image` | `<image>` or `none`, alpha baked in |
| `--t-overlay-opacity` | `0` or `1` — presence flag, **not** the strength |
| `--t-overlay-blend` | `<blend-mode>` |
| `--t-ink` | `<color>` — body text on this surface, contrast-solved |
| `--t-ink-muted` | `<color>` — secondary text, still above the AA floor |
| `--t-ambient-image` | `<image>#` or `none` — the moving background, alpha baked in |
| `--t-ambient-size` | `<bg-size>#` or `auto`, one per ambient layer |
| `--t-ambient-blend` | `<blend-mode>` |
| `--t-ambient-animation` | `<animation>` shorthand or `none` |
| `--t-ink-shadow` | `<shadow>` or `none` — the terminal glow |
| `--t-accent-on` | `<color>` — accent-coloured text that is legible on *this* surface |

**The ambient layer is the one token group that animates.** Its
`animation-name` refers to an app-owned `@keyframes` block that the serializer
prepends to the stylesheet, and only when some surface actually uses one — a
theme with no ambience carries no keyframes. The keyframes touch nothing but
`background-position` and `transform`, both compositor-only, so an ambient layer
running for a whole session costs no layout and no paint.

Its cycle time is emitted as `calc(60s * var(--t-ambient-speed, 1))`, and
`--t-backdrop-scale` multiplies every blur inside `--t-backdrop` the same way.
Neither property is ever *declared* — they resolve to their fallbacks until a
published control sets one on `:root`, which is what lets "how fast" and "how
blurred" be live knobs on a derived theme rather than a re-derivation (§10).

**Strengths are baked into the images.** `texture.opacity` and
`overlay.strength` are already in the pixels of `--t-texture-image` and the
colour stops of `--t-overlay-image`. The `*-opacity` tokens are `0` or `1`, so
`opacity: var(--t-overlay-opacity)` remains correct as an on/off switch and can
never double-apply the strength. This is what lets texture and overlay ride as
two background layers on a single pseudo-element.

**The gradient ring needs no pseudo-element and emits no token of its own.**
`border-image` squares off corners, so the ring is emitted as the *last layer of
`--t-fill-image`*, clipped to `border-box` while the fill layers clip to
`padding-box`, with `--t-border-color: transparent`. Setting `background-clip`
and `background-origin` from the two list tokens is all that is required, and it
follows `border-radius` and `corner-shape` correctly — which the
`mask-composite` construction on a pseudo-element does not, and which
`border-image` cannot.

That is what frees the third paint box: the ring lives on the element, texture
and overlay share `::before`, and **`::after` is unused by the theme layer.**

**Backdrop refraction emits no token of its own either.** `backdrop.refraction`
is not dropped — it drives two things that are already in the contract: a
`contrast()` term inside `--t-backdrop`, and an inset specular rim prepended to
`--t-shadow`. There is no `--t-refraction`; a scalar the renderer would have to
turn into a shadow itself would be a second, worse copy of a decision the
derivation already made.

---

## 7. The consumption rules

Two pseudo-elements, four paint layers, no extra DOM.

### 7.1 Specificity: what wins, and the one thing that deliberately loses

Every rule below is written at **(0,2,0)** — the attribute selector doubled,
`[data-tails-part][data-tails-part]` — so it outranks the Tailwind utility of
the same name. A part's appearance belongs to the theme, and a `bg-card` left on
the element must not quietly win. (Tailwind v3's `@layer` is a build-time
grouping, not a real cascade layer, so specificity is what decides.)

**`position` is the single exception, and it loses on purpose.** It sits alone
in an undoubled `[data-tails-part]` rule at (0,1,0). Folded in with the rest it
outranked Tailwind's `.fixed` and `.absolute`, so any element carrying both a
part attribute and a positioning utility was forced back to `relative` and its
`inset` / `top` / `left` stopped applying. That one line produced three separate
bug reports — the Settings panel laying itself out below the fold and reading as
"the Settings button does nothing", the sidebar's context menu, and the
composer's slash palette. The contract loses nothing by yielding: any positioned
value anchors the `::before` and `::after` paint layers equally well, and
`relative` is simply the floor for a part that would otherwise be `static`.

**The consequence to know about, which is the same trap from the other side:**
because the contract owns `box-shadow` at (0,2,0), a Tailwind `shadow-*` or
`ring-*` utility on a tagged element silently never renders. Use `outline`,
put the utility on a wrapper, or set the shadow through `--t-shadow`. The same
applies to `background-*`, `border-*`, `border-radius`, `color` and
`backdrop-filter`.

### 7.2 The rules

```css
/* Undoubled and alone — see 7.1. A utility must be able to beat this. */
[data-tails-part] {
  position: relative;
}

[data-tails-part][data-tails-part] {
  background-color: var(--t-fill-color);
  background-image: var(--t-fill-image);
  background-blend-mode: var(--t-fill-blend);
  background-clip: var(--t-fill-clip);
  background-origin: var(--t-fill-origin);
  background-repeat: no-repeat;

  border-width: var(--t-border-width);
  border-style: var(--t-border-style);
  border-color: var(--t-border-color);
  border-radius: var(--t-radius);
  corner-shape: var(--t-corner-shape);        /* progressive; Chromium 140+ */

  box-shadow: var(--t-shadow);
  backdrop-filter: var(--t-backdrop);
  -webkit-backdrop-filter: var(--t-backdrop);

  color: var(--t-ink);
  text-shadow: var(--t-ink-shadow);

  isolation: isolate;   /* keeps mix-blend-mode inside this surface */
}

/* Texture and overlay share one pseudo-element as two background layers. */
[data-tails-part][data-tails-part]::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  border-radius: inherit;
  corner-shape: inherit;
  background-image: var(--t-texture-image), var(--t-overlay-image);
  background-size: var(--t-texture-size), cover;
  background-repeat: repeat, no-repeat;
  background-blend-mode: var(--t-texture-blend), var(--t-overlay-blend);
}

/* ::after is the ambient layer. It is no longer yours — see below. */
[data-tails-part][data-tails-part]::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -2;                /* below the texture, above the fill */
  pointer-events: none;
  border-radius: inherit;
  corner-shape: inherit;
  background-image: var(--t-ambient-image);
  background-size: var(--t-ambient-size);
  background-repeat: no-repeat;
  mix-blend-mode: var(--t-ambient-blend);
  animation: var(--t-ambient-animation);
}

/* The page-wide ambient field. `:root` carries the `default` surface's tokens,
   so this is what makes "drifting clouds behind the chat" expressible. */
body::after {
  content: "";
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background-image: var(--t-ambient-image);
  background-size: var(--t-ambient-size);
  background-repeat: no-repeat;
  mix-blend-mode: var(--t-ambient-blend);
  animation: var(--t-ambient-animation);
}

[data-tails-surface][data-tails-surface] {
  background-color: var(--t-fill-color);
  color: var(--t-ink);
}
```

Content inside a surface must sit above the paint layers; give the surface's
children `position: relative; z-index: 1` or render them inside a wrapper that
has it.

**`::after` is no longer free.** It used to be, and that was recorded here as a
promise to the renderer; the ambient layer took it, because the alternative was
a third background layer on `::before` and that pseudo-element's single
`animation` would then have had to drive a moving layer and two still ones. A
renderer that needs a generated element on a themed part should use a wrapper.

**Reduced motion needs no rule of its own.** The global
`@media (prefers-reduced-motion: reduce)` block already collapses every
animation in the app to `0.01ms` and one iteration, which leaves the ambient
gradient painted and perfectly still. That is the right degradation: the colour
field was always the look and the drift was always the garnish.

`corner-shape` degrades to a plain rounded corner where it is unsupported, which
is correct — Electron 38 is Chromium 140 and supports it.

`--t-accent-on` is the colour for links and accent-coloured icons **inside** a
surface. Using `--primary` there is wrong on a glass popover or an accent-filled
bubble, because `--primary` is solved against the page, not against that
surface.

---

## 8. The freeform CSS layer

Available unless `TAILS_FREEFORM_CSS=0`, and **auto-allowed**. It reaches the
renderer as `layer: 'css'`, from `POST /api/appearance/css` or the `theme_css`
tool. It is ephemeral by design: never persisted, so a reload always clears it,
and that is the recovery path.

The renderer must adopt it as a **separate stylesheet after the theme sheet**,
and must not cache it in `localStorage`.

Everything the server sends has been parsed, walked and re-serialised from the
AST — the bytes are generated, not forwarded. What that walk still refuses is
now a short list, and **the renderer must not assume anything beyond it**:

- **no `url()` anywhere**, in any spelling, including inside custom properties,
  and including `image-set()`, `-webkit-image-set()`, `src()`, `image()`,
  `element()`, `attr()` and `@import`. Function names are decoded before the
  check, so `u\72 l(…)` is refused too;
- **no selector naming `[data-tails-critical]`**, including from inside
  `:not()`, `:is()`, `:where()` or `:has()`, and including escaped spellings of
  the attribute name;
- **`content` may only be `""` or `none`**.

That is the whole list. Everything else the validator used to enforce — the
property allowlist, the rooted-selector requirement, the opacity floor, the
filter ranges, the scale minimum, the pseudo-element allowlist, the `z-index`
cap, the three-feature media allowlist, the duration ceilings, the ban on
negative margins and on `!important` — is gone. Those rules existed to prevent
an *ugly* result, and every one of them also prevented a good one nobody had
thought of.

**So a freeform stylesheet can now break the app's layout**, and that is an
accepted outcome rather than an overlooked one. What makes it acceptable is the
pair of guarantees underneath: the layer is never written to disk, so reloading
the window always clears it, and `Ctrl+Alt+Shift+T` is handled in the Electron
main process where no stylesheet can reach it. Both are asserted in
`tests/safety.test.ts`. If either ever stops being true, this section has to be
rewritten before the next rule is relaxed.

The `[data-tails-critical]` guarantee is specifically **"cannot be targeted"**,
not "cannot be affected": a rule on `:root` inherits into everything and always
did. Targeting is the half that matters, because it is the half that can make
*yes* look like *no*.

`.t-*` remains the class namespace reserved for theme authors, but it is a
convention now rather than an enforced boundary — a stylesheet can name any
class. If the renderer wants a stable hook, `t-something` is still the name to
give it, because every other class name is an implementation detail that will
move.

---

## 10. Live controls

`layer: 'controls'` carries a `controls` array and no stylesheet. Each entry:

```ts
{
  id: 'glass.blur',
  label: 'Blur',
  kind: 'slider',            // slider | toggle | colour | select
  binds: '--glass-blur',     // a CSS custom property, written on :root
  value: 20,
  min: 0, max: 60, step: 1, unit: 'px',   // slider
  on: '1px', off: '0',                    // toggle
  options: [{ label, value }],            // select
  help: 'How far the pane blurs what is behind it.',
}
```

The renderer writes `binds` → value into a **constructed stylesheet held in
`document.adoptedStyleSheets`, appended last**, under a `:root:root` selector.
Three things about that are load-bearing:

- **Not inline styles on `documentElement`.** Inline styles outrank every
  selector, so a knob written that way would also outrank the theme's `.dark`
  block, and the first dark-mode toggle would strand every touched control on
  its light value. Same trap as §1's warning about the theme layer.
- **`:root:root`, doubled.** The theme scopes surface tokens to
  `[data-tails-part="popover"]` at (0,1,0); a bare `:root` ties with that and
  loses on source order for anything the theme also set per part. Doubling means
  dragging "Blur" moves every glass surface, which is what the user expects.
- **Appended on every write.** `applyTheme.ts` rebuilds `adoptedStyleSheets`
  when it first creates a layer and only re-appends *its* sheets, which would
  leave the control sheet ordered before the theme it overrides.

Living in `adoptedStyleSheets` is also what puts the layer inside the panic
key's reach for free: the main process resets by emptying that array.

Two properties the derived theme already reads, so a control can bind them with
no `theme_css` layer at all: **`--t-backdrop-scale`** (multiplies every backdrop
blur) and **`--t-ambient-speed`** (multiplies every ambient cycle time). For
anything else the look has to introduce the property itself —
`blur(var(--glass-blur, 20px))` rather than `blur(20px)`.

## 11. Proposals

`layer: 'proposal'` carries a `variants` array and no stylesheet of its own:

```ts
{ label, note, className, name, summary, css }
```

Each `css` is the variant's real derived stylesheet with `:root` swapped for
`.<className>` and `.dark` for `.dark .<className>`, produced by
`serializeScoped`. The renderer injects each one and paints a scaled mock of the
app chrome inside a container with that class, so the user is looking at the
look itself rather than a picture of it.

This is deliberately not a generated image. An image would be an approximation
of something this module can render exactly, it would have to be fetched or
synthesised (and nothing here may name a URL), and it would go stale the moment
the spec was tweaked.

Nothing is applied and nothing is bound. The choice is made in the chat, through
`AskUserQuestion`, and the agent applies the winner — so the proposal UI has no
"use this" button, because a second answer channel the model cannot observe
would leave it waiting on a question the user had already answered by clicking.

---

## 12. Compatibility

A theme saved under spec v1 is replayed from its **cached token blob**, which
has no `surfaces` or `tones` groups. The serializer omits those rules rather
than emitting empty ones, so a v1 theme produces exactly the v1 stylesheet it
always did and no `--t-*` token is defined. Every `--t-*` consumption rule
therefore needs to survive the property being unset:

- an unset custom property makes the whole declaration
  [invalid at computed-value time](https://drafts.csswg.org/css-variables/#invalid-at-computed-value-time),
  which resolves to the property's *inherited or initial* value;
- for `background-image`, `box-shadow`, `backdrop-filter` and `text-shadow` that
  is `none` — correct;
- for `color` it is **inherit**, which is also correct;
- for `background-color` it is `transparent` — correct.

So the rules in §7 are safe to apply unconditionally. They simply do nothing for
a v1 theme, which is the desired behaviour.
