/**
 * The appearance guide, as the model receives it.
 *
 * It lives here, in the module, rather than in `docs/` — and that is the whole
 * point of the file. The user's complaint was that the generative UI "is doing
 * a really bad job, maybe it would do better with complete freedom instead of
 * all these presets, but maybe an md guide would help", and both halves of that
 * are right. What a document in `docs/` cannot do is *be read*: the agent's
 * working directory is whatever folder the conversation is about, almost never
 * this repository, so `Read docs/APPEARANCE-GUIDE.md` fails and the guidance
 * never enters context. A design doc nobody loads is decoration.
 *
 * So the guide is returned by `theme_list`, which the tool descriptions already
 * point at as the thing to read before designing. That also reframes
 * `theme_list` into what it should have been all along: not a menu of finished
 * looks to pick from, but the reading step — here is how looks are built, and
 * here are some worked examples of the format.
 *
 * It is markdown because markdown is what it is for. The `docs/` files remain
 * the rationale — why the system is shaped this way, for humans — and this is
 * the operative text, for the model, at the moment it needs it.
 */
export const APPEARANCE_GUIDE = `
# Designing a look for T.A.I.L.S.

You are restyling the application you are running inside. You have close to
complete freedom. What follows is how to use it well, not what you are allowed
to do — the short list of things that are actually refused is at the bottom.

## The one rule that matters

**Compose. Do not pick.** The presets returned alongside this guide are worked
examples of the format, kept because reading how a look is *constructed* is the
fastest way to learn the vocabulary. They are not a menu. If the answer to
"make it feel like a rainy Tokyo evening" is "the closest preset is Bloom", the
system has failed, and so have you. Build the thing that was asked for.

If it genuinely cannot be built, name the missing primitive. That is a useful
answer. "Here is the nearest shipped look" is not.

## The shape of a session

\`theme_list\` (this) to read → compose a spec → \`theme_preview\` to show it
and get the contrast report → \`theme_propose\` if the change is substantial,
then ask → \`theme_apply\` to bind it → \`theme_controls\` to publish the knobs.
\`theme_css\` slots in wherever the spec runs out of vocabulary.

**\`theme_reset\` puts everything back to the built-in look** — every binding,
any CSS layer, any published controls, any knob the user dragged. Reach for it
the moment a change goes wrong or the user asks to go back, and before trying a
genuinely different direction so the previous attempt is not underneath the new
one. It is cheap and complete, and far better than composing a theme that tries
to undo whatever the last one did.

Preview is free and nothing needs undoing, so iterate there rather than
reasoning in your head about what a spec will look like.

## Two things every look owes the user

**The sidebar must read as a different plane from the chat.** They are the two
largest surfaces on screen and if they share a fill the app looks like one
undifferentiated slab. Give the rail its own \`sidebar\` recipe with a fill a
tier or two along the \`surface\` role — that role is direction-free, so one
recipe separates correctly in both ramps. A test asserts a minimum measured
separation for every shipped preset, so this is a floor rather than a
suggestion.

**A look has to be leaveable.** If the user does not like it, \`theme_reset\`
is one call and puts everything back. Do not make someone live with the third of
three looks they disliked because going back was awkward.

## Where a look actually lives

Not in the palette. Two themes with the same palette and different \`surfaces\`
are two different products; two themes with different palettes and no
\`surfaces\` are the same product in two colours. Design the \`surfaces\` map
first and choose the palette to suit it.

Within \`surfaces\`, the **shadow stack** is the highest-leverage primitive in
the system, and none of these is an enum anywhere — each is what you get by
composing:

| look | how it is built |
|---|---|
| brutalist | zero blur, zero spread, large offset — the shadow is a second copy of the shape |
| neumorphic | a mirrored pair: light up-left, shadow down-right, both blurred, fill the same colour as the page |
| clay | wide soft dark drop, tight contact shadow, inset light on the top edge |
| glass | translucent fill + backdrop blur *with saturation* + a gradient-ring border + a wide ambient drop |
| neon | zero offset, wide blur, accent-coloured, plus a 1px spread ring |
| editorial | no shadow at all; separation by a single hairline rule on one side |

None of those six ships as a preset. They are recipes, not options — the table
is there so you can build any of them, or something none of them describes.

Glass is worth dwelling on because it is the one people reach for a preset for.
It is four things and the third is the one that gets forgotten: a fill whose
stops carry alpha around 0.5–0.7; \`backdrop: { blur, saturate }\` where
**saturate is what stops it reading as fog**; \`border.variant:
"gradient-ring"\` with a bright stop at 0–20% and a shadow stop at 60–100%; and
a soft wide ambient shadow so it floats. Add \`refraction\` for the edge.

## Reaching further than the spec

- **\`theme_css\`** layers hand-written CSS over the derived theme. Use it
  without apology for anything the spec has no word for. Selectors, properties,
  at-rules, pseudo-elements, media queries — effectively all of CSS is
  available.
- **\`--pointer-x\` / \`--pointer-y\`** (percentages) and **\`--pointer-px\` /
  \`--pointer-py\`** (pixels) are published on \`:root\` and follow the mouse.
  A spotlight is
  \`radial-gradient(circle at var(--pointer-x) var(--pointer-y), …)\`.
- **\`surfaces.<part>.ambient\`** gives slow background motion — \`drift\`,
  \`clouds\`, \`grid\`, \`pulse\` — with \`hue\`, \`strength\`, \`speed\` and
  \`scale\`. It inherits like texture, so setting it on \`default\` puts it
  behind the whole app *including every card*, and a part that should stay still
  needs \`ambient: { kind: "none" }\` of its own. Keep \`speed\` at 60–120
  seconds: ambient means the user senses the screen is alive without ever
  catching it moving.
- **\`interaction\`** covers the caret — \`caretColor\` and \`caretShape\`,
  where \`block\` is the fat terminal cursor and \`underscore\` the DOS one —
  plus \`selectionFill\` / \`selectionInk\` and \`cursor\`, which picks from the
  shapes the OS already draws. An amber block caret is most of what sells a
  terminal. \`caretCycle\` takes two to four colour refs and steps the caret
  through them; use it sparingly, it is a strong effect on a very small object.

## Colour roles you can name

\`surface\`, \`ink\`, \`foreground\`, \`border\`, \`accent\`, \`support\`, and
the two depth poles \`shadow\` and \`light\` — never assume black for a shadow,
\`shadow\` already *is* the theme-correct dark pole.

Also \`positive\`, \`warning\` and \`destructive\`: the semantic colours the
theme already publishes, solved against the page. Reach for those rather than
approximating with the accent when you want the theme's own green or red.

The accent is solved to be readable **as text on the page**, not merely as a
button fill — \`text-primary\` colours links in the assistant's own output, so
3:1 was never the right bar for it. That means a very light accent hue (amber,
yellow, lime) will come back darker than you asked in a light ramp: the hue you
choose is honoured, the lightness is not negotiable. If you want the vivid
version of a light hue, put it on a dark ground.

Inside a surface, use \`--t-accent-on\` rather than the accent itself for
accent-coloured text. It is the same colour re-solved against *that* surface,
which is the only version that stays legible on a glass popover or a filled
bubble.

\`tier\` is direction-free — tier 2 is "two steps more contrasty than the page"
in a light theme and a dark one alike — which is why it is the role to use when
a surface has to separate in **both** ramps. \`light\` and \`shadow\` each run
out of headroom at one end.

## The cursor

\`cursor: url(...)\` is refused and always will be, so a custom cursor is never
an imported image. Two things are available instead, and they compose.

**\`interaction.cursor\`** picks a native shape: \`auto\`, \`default\`,
\`crosshair\`, \`cell\`, \`copy\`, \`progress\`, \`help\`. It inherits, so
anything but \`auto\` changes the pointer over every surface that has not set
its own. A crosshair everywhere is a committed choice and a slightly hostile
one.

**\`interaction.pointer\`** is a shape the app draws and moves with the mouse:

\`\`\`
pointer: {
  kind: 'halo',        // system | halo | ring | dot
  size: 72,            // px
  opacity: 0.35,
  blend: 'screen',     // screen on dark grounds, multiply on light
  replace: false,
  trail: { kind: 'comet', length: 10, size: 14, opacity: 0.4 },
}
\`\`\`

\`kind\` picks the shape: \`halo\` is a soft glow and the one that reads as
atmosphere rather than as a replacement pointer; \`ring\` is a hollow circle;
\`dot\` is a filled disc; \`system\` draws nothing.

Read this before setting \`replace\`. A drawn cursor is painted by the page, so
it lands **one frame after** the pointer event, while the real cursor is
composited by the OS and never lags. On a large soft \`halo\` that offset is
invisible. On a small hard \`dot\` standing in for the actual pointer it is
immediately obvious and feels broken. The default is a *companion* — the drawn
shape rides along with the real cursor still visible — and that is the version
you should reach for. \`replace: true\` is for a large soft shape, deliberately
chosen.

The native cursor comes back over text fields, contenteditable regions and
anything marked \`[data-tails-critical]\` no matter what you set. Those are the
places where the pointer's shape or exact position is carrying information, and
that is not a style decision. Elements with their own \`cursor\` — resize
handles and the like — keep it too.

\`trail.kind\` is \`comet\`, which tapers each segment toward nothing, or
\`ribbon\`, which keeps the width and lets opacity do all the work.

\`click: { kind: 'ripple', size, seconds }\` expands a ring from wherever the
pointer went down. It is independent of the drawn cursor — a look can want click
feedback without wanting to replace the pointer — and like the trail it is off
entirely under reduced motion and adds no listener when the kind is \`none\`.

\`trail\` is autonomous motion: it is switched off entirely under
\`prefers-reduced-motion\`, and it runs no animation frame loop while the
pointer is still. Segments are spaced by **distance travelled**, not by time, so
a fast flick draws a long trail and a slow drag a short one, and a stationary
cursor retracts the trail to nothing instead of pooling it into a blob.

## Then publish the knobs

After the look is applied, call **\`theme_controls\`** with the three or four
things worth adjusting *for that look*. Glass wants transparency, blur and ring
thickness; a CRT wants scanline intensity and glow; clouds want speed. Dragging
one repaints instantly.

A control binds a CSS custom property, so it only works if something reads that
property through \`var()\`. These the derived theme already reads, so you can
bind them with no \`theme_css\` layer at all:

| property | what dragging it does |
|---|---|
| \`--t-backdrop-scale\` | multiplies every backdrop blur in the app |
| \`--t-ambient-speed\` | multiplies every ambient cycle time |
| \`--t-pointer-scale\` | resizes the drawn cursor |
| \`--t-pointer-opacity\` | how present the drawn cursor is |
| \`--t-trail-opacity\` | how strong the trail is |
| \`--t-trail-length\` | how far the trail reaches — re-shapes it live |
| \`--t-trail-taper\` | 1 tapers to a comet, 0 keeps a ribbon's width |
| \`--t-selection-fill\`, \`--t-caret-color\` | colour controls that need no setup |

A cursor look almost writes its own panel: *Glow size* on
\`--t-pointer-scale\`, *Glow strength* on \`--t-pointer-opacity\`, *Trail
length* on \`--t-trail-length\`.

For anything else, introduce the property yourself in a \`theme_css\` layer —
write \`blur(var(--glass-blur, 20px))\` rather than \`blur(20px)\` — and then
bind it.

## Showing your work before committing

For a **substantial** change, call **\`theme_propose\`** with two variants — one
bold, one restrained — before applying anything. The user sees both rendered as
live miniatures of the real app chrome, then you ask with \`AskUserQuestion\`
which they want.

Substantial means the change alters *structure*: fills, shadows, borders,
corners, backdrops, ambient motion, or pinning the colour mode. A hue rotation,
a font swap, a density change or a radius nudge is not substantial — preview it
and get on with it. Asking about a font swap is its own kind of bad job.

## Judgement, which is now yours

The validator used to enforce these. It does not any more, because every rule
that prevented an ugly result also prevented a good one nobody had thought of.
They are still true:

- **Legibility.** Body text below about 0.4 opacity stops being readable. The
  contrast solver protects the declarative path; it cannot protect CSS you wrote
  by hand.
- **Motion budget.** Ambient movement should be slow and peripheral — 60 to 120
  seconds a cycle. The moment the user watches it instead of the text it has
  failed. Honour \`@media (prefers-reduced-motion: reduce)\`.
- **Density.** Padding in the assistant's output is what makes a long answer
  readable. Tight is a choice; cramped is a bug.
- **Performance.** A backdrop blur on a hundred elements costs frames, and any
  element carrying one loses subpixel text antialiasing. Keep wide blurs on
  chrome, not under paragraphs.
- **Type.** No fonts are bundled; every family is a preference list resolved
  against what the machine has. Trust the named stacks rather than assuming a
  particular face rendered.

## What is actually refused

Three things, and none of them is about taste:

1. **\`url()\`, in every spelling** — including \`image-set()\`, \`src()\`,
   \`image()\`, \`element()\`, \`attr()\` and \`@import\`. A stylesheet that can
   name a remote resource can report what the user is doing to whoever owns it.
   Textures are app-owned and chosen by name; gradients are unlimited.
2. **Any selector naming \`[data-tails-critical]\`**, including from inside
   \`:not()\`, \`:is()\` or \`:has()\`. That attribute marks permission prompts
   and the plan-approval row.
3. **\`content\` may only be \`""\` or \`none\`.** Words on screen read as the
   application's own.

The freeform CSS layer is never written to disk, so a reload always clears it,
and \`Ctrl+Alt+Shift+T\` resets appearance from outside the renderer. That pair
is why you have this much room.
`.trim();
