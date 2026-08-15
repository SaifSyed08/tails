import { z } from 'zod';

import { validateTokenValue } from '@/modules/appearance/freeform-css.js';

/**
 * Live controls — the knobs the agent invents for the look it just made.
 *
 * The idea this file exists to serve, and the one that separates the appearance
 * engine from a theme picker: a settings panel can only ever expose the knobs
 * someone thought of in advance, and the interesting knobs do not exist until
 * the look that needs them exists. Glass wants *transparency*, *blur* and *ring
 * thickness*. A terminal wants *cursor width* and *scanline intensity*.
 * Drifting clouds want *how fast*. None of those belong in a general settings
 * page, because none of them are general.
 *
 * The hard requirement is that a control is **live**. Dragging it repaints
 * immediately: no confirm step, no round trip to the model, no re-derivation
 * and no re-validation. That is achievable for exactly one reason — a control
 * binds to a **CSS custom property**, and the renderer already reads every
 * themed value through `var()`. Setting one property on `:root` is a paint, not
 * a rebuild. A control that had to re-derive the theme would not be a control,
 * it would be a very slow prompt.
 *
 * Two consequences fall out of that binding, and both are load-bearing:
 *
 * - A control is only useful if **something reads the property it binds**.
 *   Publishing a slider for `--glass-blur` when nothing in the current
 *   stylesheet says `blur(var(--glass-blur))` produces a slider that moves and
 *   changes nothing, which is the same defect — a knob that does nothing — that
 *   the whole v2 rebuild existed to remove. The tool description says so in as
 *   many words.
 * - The value a control writes reaches the document without passing through the
 *   stylesheet validator, so it is checked here with the *same* code. `url()`
 *   is the one rule with no aesthetic component, and a colour picker that could
 *   emit `url(https://…)` would be a hole through it from the one direction
 *   nobody inspects.
 */

/** A control panel with forty sliders is a model that has lost the thread. */
const MAX_CONTROLS = 12;

const identifier = z.string().min(1).max(48).regex(
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
  'An id may contain letters, digits, dots, dashes and underscores.',
);

const binds = z.string().regex(
  /^--[a-zA-Z0-9_-]{1,60}$/,
  'A control must bind a CSS custom property, written in full, e.g. "--glass-blur".',
).describe('The CSS custom property this control writes on :root. It must be one the current look actually reads through var() — a control bound to a property nothing consumes is a slider that moves and changes nothing. If you need a knob the theme spec does not expose, introduce the property yourself in a theme_css layer first, then bind it here.');

const common = {
  id: identifier.describe('A stable id for this control, unique within the set, e.g. "glass.blur". Reused ids replace each other, so publishing the same set twice updates it rather than duplicating it.'),
  label: z.string().min(1).max(32).describe('The control\'s name as the user reads it. Two or three words: "Blur", "Ring thickness", "Cloud speed".'),
  binds,
  help: z.string().max(120).optional()
    .describe('One short sentence shown under the control. Use it for what the knob does to the look, not for what the CSS property is.'),
};

const controlSchema = z.discriminatedUnion('kind', [
  z.object({
    ...common,
    kind: z.literal('slider'),
    min: z.number().describe('Lowest value. Pick a range where every position looks deliberate — a slider whose bottom third is unusable is a slider with the wrong minimum.'),
    max: z.number().describe('Highest value.'),
    step: z.number().positive().default(1).describe('Drag increment. Use a fractional step for a 0-1 opacity or a saturation multiplier.'),
    unit: z.string().max(8).default('').describe('The CSS unit appended to the number: "px", "deg", "s", "%", "em". Leave empty for a bare number such as a saturation multiplier.'),
    value: z.number().describe('The value the look currently has. Set it to what you actually derived, so the panel opens showing the truth rather than a default.'),
  }).strict(),

  z.object({
    ...common,
    kind: z.literal('toggle'),
    on: z.string().min(1).max(120).describe('The CSS value written when the toggle is on, e.g. "1" or "block" or a full shadow list.'),
    off: z.string().min(1).max(120).describe('The CSS value written when the toggle is off. Usually "none", "0" or "transparent".'),
    value: z.boolean().describe('Whether the look currently has this on.'),
  }).strict(),

  z.object({
    ...common,
    kind: z.literal('colour'),
    value: z.string().min(1).max(64).describe('The current colour as a complete CSS colour value. The picker emits hex, so bind a property used as a whole colour rather than one composed into hsl(var(--x) / a).'),
  }).strict(),

  z.object({
    ...common,
    kind: z.literal('select'),
    options: z.array(z.object({
      label: z.string().min(1).max(32).describe('What the user reads.'),
      value: z.string().min(1).max(120).describe('The CSS value written when this option is chosen.'),
    }).strict()).min(2).max(8).describe('Two to eight named alternatives. Use this where a slider would be a lie — corner shape, blend mode, a named easing.'),
    value: z.string().min(1).max(120).describe('The option value currently in effect. Must match one of the options.'),
  }).strict(),
]);

export type AppearanceControl = z.infer<typeof controlSchema>;

export const controlsPayloadSchema = z.object({
  title: z.string().min(1).max(40).default('Adjust')
    .describe('The panel heading. Name the look, not the act: "Liquid glass", "Rose gold", "CRT".'),
  controls: z.array(controlSchema).max(MAX_CONTROLS)
    .describe(`Up to ${MAX_CONTROLS} controls. Publish the three or four knobs that actually change this look's character; every extra one makes the useful ones harder to find. An empty array removes the panel.`),
}).strict();

export type ControlsPayload = z.infer<typeof controlsPayloadSchema>;

/** A validation failure in the shape the rest of the module reports them. */
export type ControlIssue = { path: string; message: string };

/**
 * Every CSS value a control can put on the document, with the path it came from.
 *
 * Collected rather than checked inline so one call reports every bad value at
 * once — the same reason the stylesheet validator collects instead of throwing.
 * The slider's min and max stand in for the whole range: a unit that parses at
 * both ends parses everywhere between them, and checking a thousand
 * intermediate values would prove nothing extra.
 */
function emittedValues(control: AppearanceControl, path: string): { path: string; value: string }[] {
  switch (control.kind) {
    case 'slider':
      return [
        { path: `${path}.min`, value: `${control.min}${control.unit}` },
        { path: `${path}.max`, value: `${control.max}${control.unit}` },
        { path: `${path}.value`, value: `${control.value}${control.unit}` },
      ];
    case 'toggle':
      return [
        { path: `${path}.on`, value: control.on },
        { path: `${path}.off`, value: control.off },
      ];
    case 'colour':
      return [{ path: `${path}.value`, value: control.value }];
    case 'select':
      return control.options.map((option, index) => ({
        path: `${path}.options[${index}].value`,
        value: option.value,
      }));
  }
}

/**
 * Parses a control set and checks every value it can ever write.
 *
 * Returns the payload unchanged on success rather than a rewritten one: unlike
 * a stylesheet, a control set is data the client interprets, so there are no
 * author bytes to launder — the only thing that reaches CSS is a value that has
 * been through `validateTokenValue`, and the check is what guarantees it.
 */
export function validateControls(raw: unknown):
{ ok: true; payload: ControlsPayload } | { ok: false; issues: ControlIssue[] } {
  const parsed = controlsPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.') || 'controls',
        message: issue.message,
      })),
    };
  }

  const issues: ControlIssue[] = [];
  const seen = new Set<string>();

  parsed.data.controls.forEach((control, index) => {
    const path = `controls[${index}]`;

    if (seen.has(control.id)) {
      issues.push({ path: `${path}.id`, message: `Two controls share the id "${control.id}". Ids identify a control across republishes, so they have to be unique.` });
    }
    seen.add(control.id);

    if (control.kind === 'slider' && control.min >= control.max) {
      issues.push({ path: `${path}.max`, message: 'A slider needs max greater than min.' });
    }
    if (control.kind === 'select' && !control.options.some((option) => option.value === control.value)) {
      issues.push({ path: `${path}.value`, message: 'The current value is not one of the options, so the panel would open showing a selection the look does not have.' });
    }

    for (const emitted of emittedValues(control, path)) {
      const checked = validateTokenValue(emitted.value, emitted.path);
      if (!checked.ok) issues.push(...checked.issues);
    }
  });

  return issues.length > 0 ? { ok: false, issues } : { ok: true, payload: parsed.data };
}
