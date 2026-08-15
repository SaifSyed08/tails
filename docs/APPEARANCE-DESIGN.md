# Appearance — what the agent is allowed to be

## The mistake this document exists to correct

The engine shipped with a `liquidGlass` preset. Then "make it liquid glass" was
used to test whether the engine could produce glass. It passed, and the pass
meant nothing: the answer had been written into the question.

That is the failure mode to design against, and it is subtler than one bad
preset. Any system that offers a model a list of finished looks and a way to
apply one has made preset-picking the cheapest correct-looking action available.
The model is not cheating when it picks; it is doing the obvious thing with the
affordances it was handed. If we want composition, composition has to be the
easy path and the only path.

Three consequences, applied:

1. **`liquidGlass` is deleted as a preset.** Glass is not a style the app knows;
   it is what you get from a translucent fill, a wide backdrop blur with
   saturation, a bright specular ring on the light-facing edge, and a soft
   ambient shadow. Those are primitives. If the primitives cannot produce glass,
   that is a real gap and a preset would only have hidden it.

2. **The remaining presets are reference, not answers.** They exist so the model
   can read *how* a look is constructed — which knobs move together to make
   something feel brutalist rather than neumorphic. They are shown to the user
   in Settings as starting points. They are not a menu the model picks from in
   response to an aesthetic request.

3. **The test of the engine is a look no preset resembles.** "Rose gold with
   slowly drifting clouds behind the chat, and a thick blinking terminal
   cursor." If that has to come back as "the closest preset is Bloom", the
   engine has failed regardless of how many presets ship.

## What the agent can reach

| Tool | Purpose |
|---|---|
| `theme_preview` | Compile and show a declarative spec. Contrast-solved, cannot name a URL. |
| `theme_propose` | Show two or three candidates side by side as live miniatures, before anything is applied. |
| `theme_apply` | Bind a spec to the session or globally. |
| `theme_css` | Write an actual stylesheet. The escape hatch from the spec's vocabulary. |
| `theme_controls` | Publish live controls for the look just made. See below. |
| `theme_list` | Read the guide and the reference presets. Reading only — it is not an apply path. |

All five are auto-allowed. `theme_css` and `theme_apply` used to fall through to
the permission prompt; what that produced was a modal in the middle of a design
conversation the user had themselves started, for changes that are ephemeral
(CSS) or contrast-solved and reversible (apply). Asking permission to do the
thing you were just asked to do is not consent, it is friction.

**What was actually stranded**, since the diagnosis in this document was half
right. `theme_css` *was* registered on the MCP server, so it was reachable
through the permission prompt — but it was named nowhere the model would see it:
not in the allowed-tools list, and not in the system prompt, which described a
three-step `list → preview → apply` workflow and stopped there. A tool nothing
mentions and that costs a modal to try is a tool that never gets tried. Both
holes are closed.

A second, quieter stranding of the same shape was found next to it: five global
tokens — `--font-size-base`, `--letter-spacing-base`, `--line-height-base`,
`--display-weight`, `--measure` — were derived, serialised, and read by nobody.
Five of the eight typographic knobs a model can set validated and then changed
nothing. Two more, `--border-width` and `--space-unit`, are still unconsumed and
are named as open work in the renderer contract rather than left to be
rediscovered.

**Where the guidance lives.** In `server/modules/appearance/guide.ts`, returned
by `theme_list`. It is markdown, and it deliberately does not live in `docs/`:
the agent's working directory is the folder the conversation is about, almost
never this repository, so a `Read docs/…` never resolves and the guidance never
enters context. A design doc nobody loads is decoration. This file remains the
rationale, for humans; the guide is the operative text, for the model, at the
moment it needs it.

## Controls the agent invents

The strongest idea in the product, and the one that separates this from a
theme picker: **after the agent makes a look, it publishes the knobs for that
look.** Not a fixed settings page — the controls are chosen by whoever built the
thing, because only they know what is worth adjusting.

Glass gets *transparency*, *blur*, *ring thickness*. A terminal look gets
*cursor width*, *whether the cursor blinks*, *scanline intensity*. A background
image gets *how faint*. A mouse trail gets *how much*. Drifting clouds get *how
fast*. None of those belong in a general settings panel, because none of them
exist until the look that needs them exists.

The rule is that a control must be **live** — dragging it repaints immediately,
with no confirm step and no round trip to the model. A slider that requires the
agent to re-derive the theme is not a control, it is a very slow prompt.

Shape of a published control:

```ts
{
  id: 'glass.blur',
  label: 'Blur',
  kind: 'slider',          // slider | toggle | colour | select
  min: 0, max: 60, step: 1, unit: 'px',
  value: 20,
  binds: '--t-backdrop-blur' // a CSS custom property, written directly
}
```

Binding to a custom property rather than to a spec field is what makes it
instant: the renderer already reads every `--t-*` through `var()`, so setting
one on `:root` repaints without deriving, validating, or asking anyone.

## How much freedom

The instruction is that the agent should have room to work, with judgement
expressed as guidance rather than as a wall. That is right for aesthetics and
wrong for exactly one thing, so the line is drawn there and nowhere else.

**Guidance, not enforcement** — these are things the agent is told to be
careful about, and is trusted with:

- Legibility. Body text wants to stay readable; a 0.2 opacity paragraph is a
  bad idea, not a blocked one.
- Motion budget. Ambient movement should be slow and peripheral. Honour
  `prefers-reduced-motion`.
- Density. Padding in the assistant's output is what makes long answers
  readable; tight is a choice, cramped is a bug.
- Performance. A backdrop blur on a hundred elements will cost frames.

**Enforced, and not negotiable** — the short list:

- **`url()` is refused everywhere.** Not aesthetics: a stylesheet that can name
  a remote URL can report what you are doing to whoever owns it. Textures and
  images are app-owned and selected by name. This covers every spelling —
  `image-set()`, `src()`, `image()`, `element()`, `attr()`, `@import`, and
  escaped names like `u\72 l(…)`, which are decoded before the check.
- **`[data-tails-critical]` cannot be named by any selector.** Permission
  prompts and the plan-approval row carry it. A stylesheet that can restyle the
  thing asking "may I run this command" can make yes look like no. The
  guarantee is precisely "cannot be *targeted*", not "cannot be affected" —
  inheritance from `:root` reaches everything and always did.
- **A theme cannot write text.** `content` is limited to `""` and `none`. This
  one was not in the original list and was added while building: it belongs
  beside the rule above rather than beside the aesthetic rules, because
  generated text reads to the user as the application's own words, and a
  stylesheet that can put "Safe to approve" next to a button is a deception
  primitive whatever else it is.
- **Nothing may be persisted that the app cannot boot without.** Freeform CSS,
  live control values and proposals all live in the renderer until reload. This
  is what makes the worst case "reload the window" instead of "the app opens
  broken and the thing that would fix it is the thing that is broken."
- **The panic key stays out of process.** `Ctrl+Alt+Shift+T` is handled in the
  Electron main process, where no stylesheet and no renderer bug can reach it.
  Control values are written into `adoptedStyleSheets` specifically so that the
  main process's reset — which empties that array — clears them too.

The last two are asserted in `server/modules/appearance/tests/safety.test.ts`,
against the source, because neither can be tested by calling a function: one is
the *absence* of a database write and the other lives in another process. A
guarantee nobody checks is a guarantee that quietly stops holding, and these two
are what the entire loosening below rests on.

Everything else that used to be enforced — the opacity floor, the filter ranges,
the scale minimum, the property allowlist, the rooted-selector requirement, the
pseudo-element allowlist, the `z-index` cap, the three-feature media allowlist,
the duration ceilings, the ban on negative margins, the ban on `!important` — is
guidance now. Those rules were written to prevent an *ugly* result, and
preventing ugly results is not worth the cost of preventing good ones.

The consequence, stated plainly so nobody has to discover it: **a freeform
stylesheet can now break the app's layout.** That is accepted, not overlooked.
Where a rule was removed the validator carries a comment saying what the author
should be careful about instead, and the same cautions are in the tool
description and the guide — which is where the model will actually read them.

## Why the primitives should be enough

If a request cannot be built, the honest response is to name the missing
primitive rather than approximate with the nearest preset.

**Gaps closed:**

- **Animated backgrounds.** `surfaces.<part>.ambient` — `drift`, `clouds`,
  `grid`, `pulse` — with hue, strength, speed and scale. It paints on `::after`
  and on `body::after`, so "drifting clouds behind the chat" is now a thing the
  spec can say. The keyframes are app-owned; a theme chooses a motion, it does
  not author one. Cycle time rides `var(--t-ambient-speed, 1)` so a published
  control can retime it live.
- **Cursor and selection.** The top-level `interaction` group: caret colour and
  shape (`block` and `underscore` included — Chromium 139+), selection fill and
  ink, and the mouse cursor over the app body.
- **Mouse-following effects.** `--pointer-x` / `--pointer-y` (percentages) and
  `--pointer-px` / `--pointer-py` (pixels) are published on `:root` and follow
  the pointer, rAF-coalesced, and only while something reads them. A spotlight
  is `radial-gradient(circle at var(--pointer-x) var(--pointer-y), …)`.
  Deliberately two numbers as well as the built-in effects below: coordinates in
  the cascade are every effect anyone can compose from a gradient, a shadow or a
  transform.
- **A custom cursor and a trail.** `interaction.pointer` — `halo`, `ring`, `dot`
  — plus `trail` as `comet` or `ribbon`. Not an imported image, because
  `cursor: url(...)` is refused and always will be: a stylesheet that can name a
  remote resource can report where the user is pointing at the resolution of
  every hover. So it is a gradient the app draws and moves.

  Three things about it are deliberate. The default is a *companion* rather than
  a replacement — a drawn cursor is painted by the page and therefore lands a
  frame after the pointer event, which is invisible on a large soft halo and
  obviously broken on a small hard dot, so `replace` is an opt-in for authors
  who have chosen a shape that survives it. The native cursor always returns
  over text fields, contenteditable regions and `[data-tails-critical]`, which
  is the `cursor` property's version of the selector ban. And the trail is
  spaced by *distance travelled* rather than by time, so it is frame-rate
  independent and retracts to nothing when the pointer stops, instead of pooling
  into a blob under a stationary cursor.

**Gaps still open**, named rather than quietly left:

- **An imported cursor image** is not coming. `cursor: url(...)` is the one
  thing the validator will not yield on, so the drawn shapes are the ceiling.
- **Caret blink rate and width** are the operating system's, not CSS's.
  `caret-shape: block` gets the fat terminal cursor; "make it blink faster" is
  not reachable and would need a custom caret in a contenteditable, which is a
  different and much larger feature.
- **`--border-width` and `--space-unit`** are derived and consumed by nobody, so
  `density` moves nothing and a theme's border width only reaches elements
  carrying `data-tails-part`. Both need `tailwind.config.js` changes that touch
  every border and every padding in the app.
- **Per-element ambient targeting.** Ambient inherits like texture, so setting
  it on `default` puts it behind every card as well as the page. A part that
  should stay still needs its own `ambient: { kind: "none" }`. Workable, but it
  is a default that surprises people.

A gap named is a feature request. A gap papered over with a preset is a lie
about what the system can do.

## Seeing it before it happens

For a **substantial** change the agent shows two readings of the request — one
drastic, one conservative — as live miniatures of the real app chrome, and then
asks which with `AskUserQuestion`. Substantial means the change alters
structure: fills, shadows, borders, corners, backdrops, ambient motion, or
pinning the colour mode. A hue rotation, a font swap or a density change is not,
and putting one of those behind a comparison modal is its own kind of bad job.

The miniatures are the candidate's **real derived stylesheet**, scoped to a
class, painting a scaled mock of the sidebar, header, chat rows and composer.
Not a generated image: an image would be an approximation of something the
engine can already render exactly, it would have to come from somewhere (and
nothing here may name a URL), and it would go stale the moment the spec moved.

## The invariant, and why it needed one

> Applying appearance state X must produce a rendering indistinguishable from a
> fresh app that has only ever had X applied. No residue from anything applied
> before it.

Three bugs got to users before this was written down. A cursor glow, layered in
through `theme_css`, outlived the theme that created it — it survived switching
preset and survived *reset appearance*, so it read as a permanent app feature
with no switch. A background texture did the same. A `.dark` class set by a
pinned theme survived the adaptive theme after it, loading a light ramp with
every `dark:` utility still on the dark branch.

Each was found and fixed on its own, and that was the mistake: they are one bug.
Appearance is six or seven layers, each was applied by whichever path produced
it, and none of them was cleared by anything except the path that had set it.
Patching instances of that is how you get a fourth.

The fix is structural rather than diligent. `layer-state.ts` holds the whole
appearance state in one value and a theme event **replaces** it rather than
merging into it, so everything not carried by the event returns to its empty
value in the same expression that sets the new theme. `commitAppearance` then
writes every layer it owns unconditionally, with no "if this changed" anywhere.
There is no teardown to forget, because there is no accumulation to tear down.

`tests/layer-state.test.ts` asserts it over every ordering of every layer, and
`RENDERER-CONTRACT.md` §1.2 enumerates the layers with what clears each. Adding
a layer means adding a field to `AppearanceState` first — otherwise it cannot be
reset, and it will accumulate exactly like the three above.

One casualty worth naming: a `theme_css` layer no longer survives the next theme
application. The alternative was a rule distinguishing "the agent is still
composing" from "the user switched looks", and that special case is precisely
what let the texture through.

## Getting back

Every appearance change — a theme, a stylesheet, a control drag — puts **save as
preset**, **undo** and **reset to default** on screen. Before this, a look
landed and the only way back was knowing to reload the window, which is
knowledge the app never gave anyone.

Undo walks a short in-memory stack of prior states rather than jumping to the
default: "back one step" and "back to the beginning" are different requests, and
when you are iterating on a look the interesting previous state is almost never
the built-in ramp. Reset goes onto that stack too, so it is itself undoable.

Save exists because preview is deliberately not persisted. Without it the only
route from "I like that" to "it is mine" was asking the agent to make it again —
and that is not the same operation, because the spec is deterministic and the
model is not. What the user saw is what gets saved.

Reset is now `theme_reset` on the agent's side and one button in Settings, both
calling `themeService.resetAppearance` — every binding in both scopes, every
ephemeral layer, in one call. The Settings button used to unbind only the global
theme, which left a hand-written CSS layer and a set of published controls on
screen; "reset" meaning "reset some of it" is how a user learns not to trust the
button.

## The floor has exactly one design decision in it

The built-in look is meant to be the absence of a design — if every layer above
it fails to resolve, the app still looks like itself. It now carries one
deliberate exception: a very faint glow that follows the cursor, at roughly 7%
alpha over a 160px circle, because it was asked for directly.

The tension is real and worth recording rather than smoothing over. The
justification is that it costs nothing to remove (any theme setting
`pointer.kind: "system"` takes it away, which is the correct default — a theme
replaces the built-in look rather than inheriting pieces of it) and that it is
subtle enough to read as the screen being faintly aware of where you are rather
than as an effect. If it ever needs defending harder than that, it should go.

It does mean the pointer writer runs by default, which is only affordable
because of the gating: four custom-property writes on one animation frame, and
only while the mouse is actually moving.
