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
"make it feel like a rainy Tokyo evening" is "the closest preset is Neon", the
system has failed, and so have you. Build the thing that was asked for.

If it genuinely cannot be built, name the missing primitive. That is a useful
answer. "Here is the nearest shipped look" is not.

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
- **\`ambient\`** on a surface gives slow background motion — \`drift\`,
  \`clouds\`, \`grid\`, \`pulse\` — with hue, strength, speed and scale. It
  inherits like texture, so setting it on \`default\` puts it behind the whole
  app, and a part that should stay still needs \`ambient: { kind: "none" }\`.
- **\`interaction\`** covers the caret (colour, and \`block\` / \`underscore\`
  shapes), the text selection, and the mouse cursor. A phosphor-green block
  caret is most of what sells a terminal.

## Then publish the knobs

After the look is applied, call **\`theme_controls\`** with the three or four
things worth adjusting *for that look*. Glass wants transparency, blur and ring
thickness; a CRT wants scanline intensity and glow; clouds want speed. Dragging
one repaints instantly.

A control binds a CSS custom property, so it only works if something reads that
property through \`var()\`. Two properties the derived theme already reads:

- \`--t-backdrop-scale\` — multiplies every backdrop blur in the app.
- \`--t-ambient-speed\` — multiplies every ambient cycle time.

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
