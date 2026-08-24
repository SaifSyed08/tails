import { WIDGET_ICONS } from '@/modules/surface/icons.js';

/**
 * How panels are built, handed to the model rather than left in `docs/`.
 *
 * The appearance module learned this first and the note there is worth
 * repeating: the agent's working directory is the folder the conversation is
 * about and almost never this repository, so a document it cannot open is a
 * document it never reads. The guide rides on a tool response instead.
 *
 * ## What this is for
 *
 * A tool schema says what is *accepted*. It cannot say what is *good*, and the
 * gap between those two is the difference between a model that permutes tables
 * and one that composes. Left to the schema alone the failure is predictable
 * and was predicted for the theme system before it: every answer becomes the
 * one widget that can hold anything, which here is `table`, and the panel turns
 * into a spreadsheet of things that were never rows.
 *
 * So this is worked examples and the reasoning behind them — deliberately not a
 * menu. Copying one of these verbatim is the failure mode, the same one
 * `theme_list` names: the examples are panels somebody already thought of, and
 * the request is for one they did not.
 */

const EXAMPLES = [
  {
    when: 'A test run, or any "did it work" answer.',
    why: 'The number is the answer and everything else is context, so one stat leads and the rest supports it. A table of every test is what to avoid — nobody reads 500 rows, and the one that failed is the only one that matters.',
    panel: {
      title: 'Test run',
      widgets: [
        { kind: 'stat', label: 'Passing', value: '574', delta: '+18', tone: 'positive', icon: 'circle-check' },
        { kind: 'stat', label: 'Failing', value: '0', tone: 'neutral', icon: 'bug' },
        { kind: 'timeline', title: 'Recent', events: [
          { label: 'draft-store', at: '4s', detail: '6 tests', tone: 'positive', icon: 'check' },
          { label: 'pet-motion', at: '9s', detail: '22 tests', tone: 'positive', icon: 'check' },
        ] },
      ],
    },
  },
  {
    when: 'Comparing a handful of options the user has to choose between.',
    why: 'A chart for the numbers they differ on, a table for the facts they differ on. Two widgets rather than one, because a bar is readable at a glance and a fact is not, and forcing both into one shape makes the wrong half unreadable.',
    panel: {
      title: 'Three approaches',
      widgets: [
        { kind: 'chart', title: 'Cold start', unit: 'ms', series: [
          { label: 'Local', value: 40, tone: 'positive' },
          { label: 'Hosted', value: 320 },
          { label: 'Hybrid', value: 120, tone: 'accent' },
        ] },
        { kind: 'table', columns: ['', 'Offline', 'Cost'], rows: [
          ['Local', 'yes', 'free'],
          ['Hosted', 'no', 'per call'],
          ['Hybrid', 'partly', 'per call'],
        ] },
      ],
    },
  },
  {
    when: 'Work in progress that the user is going to walk away from.',
    why: 'A checklist says where it got to and a monitor keeps saying so after the turn ends. Give the monitor a `watch` whenever the answer can be found by looking at a local address or a file, or it freezes at exactly the moment they stopped watching.',
    panel: {
      title: 'Migration',
      widgets: [
        { kind: 'progress', label: 'Files converted', fraction: 0.62, detail: '31 of 50', tone: 'accent' },
        { kind: 'checklist', items: [
          { label: 'Schema', done: true, icon: 'database' },
          { label: 'Repositories', done: true, icon: 'folder' },
          { label: 'Routes', done: false, icon: 'globe' },
        ] },
        {
          kind: 'monitor',
          label: 'Build output',
          status: 'watching',
          watch: { source: 'file', path: 'dist/index.js', everyMs: 5000 },
        },
      ],
    },
  },
  {
    when: 'One number worth watching, and nothing else.',
    why: 'One widget is a complete panel. Padding it out with a note repeating the reply, or a chart of a single bar, makes the answer harder to find rather than richer.',
    panel: {
      title: 'Bundle size',
      widgets: [
        { kind: 'stat', label: 'index.js', value: '1.06 MB', delta: '+12 KB', tone: 'warning', icon: 'package' },
      ],
    },
  },
];

const RULES = [
  'One panel per conversation, replaced whole. Include every widget each time — there is no partial update, and a redraw is how you change one number.',
  'Lead with the answer. The first widget should be the thing the user asked about; everything after it is support.',
  'Prefer the widget that fits the shape of the data over the one that can hold anything. `table` can hold anything, which is exactly why reaching for it first is usually wrong.',
  'Tone is meaning, not decoration: `positive` for a good result, `warning` for something to look at, `danger` for something broken, `accent` for the thing in focus, and nothing at all for the ordinary case. A panel where everything is coloured is a panel where nothing is.',
  'Four or five widgets is a full panel. The cap is twelve; a panel near it is a page, and it will be scrolled rather than read.',
  'Text still belongs in the reply. A panel is the part worth looking at rather than reading, and a note widget repeating your own sentence is the most common way to waste one.',
  'Icons are optional and always sit beside words that already say the thing. They are drawn hidden from screen readers, so an icon carrying meaning of its own is meaning some readers never get.',
];

/** Everything the model needs to compose a panel, in one response. */
export const SURFACE_GUIDE = {
  rules: RULES,
  examples: EXAMPLES,
  icons: WIDGET_ICONS,
};
