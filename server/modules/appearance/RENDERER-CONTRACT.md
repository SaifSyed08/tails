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
  layer: 'theme' | 'css',
  scope: 'global' | 'session' | 'preview' | 'builtin',
  scopeKey: string,
  themeId: string,
  name: string,
  css: string,                       // '' means "drop this layer"
  pinnedMode: 'light' | 'dark' | null,
}
```

`layer: 'theme'` and `layer: 'css'` are **two independent adopted stylesheets**,
in that order. The theme layer is derived and safe by construction; the CSS
layer is author-written, validated and re-serialised (§7). They must be separate
`CSSStyleSheet` objects so dropping one never disturbs the other.

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

**Scalars** — complete CSS values. The five marked **NEW-CONSUMER** were emitted
by v1 and read by nobody; wiring them up is part of this contract.

| token | grammar | who must consume it |
| --- | --- | --- |
| `--radius` | `<length>` e.g. `10px` | already used via Tailwind `borderRadius` |
| `--border-width` | `<length>` | **NEW-CONSUMER** — the `* { border-color }` rule in `index.css` should become `* { border-color: hsl(var(--border)); border-width: 0 }` and any `border` utility should resolve its width from this token |
| `--space-unit` | `<length>` | **NEW-CONSUMER** — feed Tailwind `spacing` as `calc(var(--space-unit) * N)` |
| `--font-size-base` | `<length>` | **NEW-CONSUMER** — set on `body` as `font-size` |
| `--letter-spacing-base` | `<length>` / `em` | **NEW-CONSUMER** — set on `body` as `letter-spacing` |
| `--display-weight` | `<number>` 400–900 | **NEW-CONSUMER** — `.font-display` / headings use `font-weight: var(--display-weight)` |
| `--line-height-base` | `<number>` | set on `body` as `line-height` |
| `--measure` | `<length>` or `none` | `.prose-tails { max-inline-size: var(--measure) }` |
| `--font-sans` `--font-serif` `--font-mono` `--font-display` | font stack | already mapped |
| `--duration-instant/quick/settle/reflow` | `<time>` | already mapped |
| `--ease-enter/exit/standard/emphasis` | easing | already mapped |

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
| `--t-ink-shadow` | `<shadow>` or `none` — the terminal glow |
| `--t-accent-on` | `<color>` — accent-coloured text that is legible on *this* surface |

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

This is the complete set. Two pseudo-elements, three paint layers, no extra DOM.

```css
[data-tails-part] {
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

  position: relative;   /* the paint layer below is absolutely positioned */
  isolation: isolate;   /* keeps mix-blend-mode inside this surface */
}

/* Texture and overlay share one pseudo-element as two background layers. */
[data-tails-part]::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  border-radius: inherit;
  corner-shape: inherit;
  background-image: var(--t-texture-image), var(--t-overlay-image);
  background-size: var(--t-texture-size), auto;
  background-repeat: repeat, no-repeat;
  background-blend-mode: var(--t-texture-blend), var(--t-overlay-blend);
}

/* ::after is unused by the theme layer and is yours. */

[data-tails-surface] {
  background-color: var(--t-fill-color);
  color: var(--t-ink);
}
```

Content inside a surface must sit above `::before`; give the surface's children
`position: relative; z-index: 1` or render them inside a wrapper that has it.

`corner-shape` degrades to a plain rounded corner where it is unsupported, which
is correct — Electron 38 is Chromium 140 and supports it.

`--t-accent-on` is the colour for links and accent-coloured icons **inside** a
surface. Using `--primary` there is wrong on a glass popover or an accent-filled
bubble, because `--primary` is solved against the page, not against that
surface.

---

## 8. The freeform CSS layer

Available unless `TAILS_FREEFORM_CSS=0`, and never auto-allowed — the
`theme_css` tool is deliberately absent from `APPEARANCE_ALLOWED_TOOLS`, so
every use goes through the permission prompt. It reaches the renderer as
`layer: 'css'`, from `POST /api/appearance/css` or the `theme_css` tool. It is
ephemeral by design: it is never persisted, so a reload always clears it, and
that is the recovery path.

The renderer must adopt it as a **separate stylesheet after the theme sheet**,
and must not cache it in `localStorage`.

Everything the server sends has been parsed, checked against allowlists, and
re-serialised from the AST — the bytes are generated, not forwarded. Relevant
guarantees the renderer can rely on:

- no `url()` anywhere, including inside custom properties;
- every selector is rooted at `[data-tails-part]`, `[data-tails-surface]`,
  `.t-*`, `.prose-tails` or `:root`;
- nothing reaches `[data-tails-critical]`;
- no layout, sizing, visibility or interaction properties;
- `position` / `inset` / `z-index` only inside `::before` / `::after`, with
  `z-index <= 5`;
- only `@keyframes`, `@property`, and `@media` on `prefers-color-scheme`,
  `prefers-reduced-motion` or `forced-colors`;
- no `!important`.

`.t-*` is the class namespace reserved for theme authors. If the renderer wants
a hook a theme can target, name it `t-something`; every other class name is an
implementation detail the validator refuses to let a theme depend on.

---

## 9. Compatibility

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
