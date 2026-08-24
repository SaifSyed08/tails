import { Check, CircleDot, Minus, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

import { WIDGET_ICON_COMPONENTS } from '@/components/surface/icons';

import { AnimatedNumber, GrowBar, Reveal, Stagger } from '@/shared/ui/Motion';
import { cn } from '@/lib/utils';
import type { IdentifiedWidget, Tone, Widget, WidgetIcon } from '@/types/surface';

/**
 * How each widget kind is drawn.
 *
 * The other half of the contract in `server/modules/surface/widget-spec.ts`:
 * the agent names a kind, and this file decides what that kind means on screen.
 * There is no path from anything the agent wrote to markup — every string below
 * arrives as React children, which is why the validator does not escape markup
 * characters and should not start.
 *
 * ## Tone is the reason a generated panel does not look generated
 *
 * Every colour here is a theme token the appearance pipeline derives and
 * contrast-solves. Ask for a new look and the panels follow it, in the dark
 * mode the user chose, at a contrast the pipeline has already checked. A widget
 * that could name `#22c55e` would be a widget that is wrong the moment anyone
 * uses the feature this app is built around.
 */

const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-foreground',
  positive: 'text-positive',
  warning: 'text-warning',
  danger: 'text-destructive',
  accent: 'text-primary',
};

const TONE_FILL: Record<Tone, string> = {
  neutral: 'bg-muted-foreground/60',
  positive: 'bg-positive',
  warning: 'bg-warning',
  danger: 'bg-destructive',
  accent: 'bg-primary',
};

const toneText = (tone: Tone = 'neutral') => TONE_TEXT[tone];
const toneFill = (tone: Tone = 'neutral') => TONE_FILL[tone];

/**
 * The picture beside a label, when one was named.
 *
 * Always `aria-hidden`, and always next to words that already say the thing. An
 * icon carrying meaning the text does not is meaning unavailable to anyone
 * listening to the panel rather than looking at it — and at this size, to
 * plenty of people looking at it too.
 */
function Glyph({ icon, tone, className }: { icon?: WidgetIcon; tone?: Tone; className?: string }) {
  if (!icon) return null;
  const Drawing = WIDGET_ICON_COMPONENTS[icon];
  return <Drawing className={cn('size-3.5 shrink-0', toneText(tone), className)} aria-hidden="true" />;
}

/** The heading a widget carries when it has one. Absent rather than empty. */
function WidgetTitle({ children }: { children?: string }) {
  if (!children) return null;
  return <h4 className="mb-2 text-xs font-semibold text-muted-foreground">{children}</h4>;
}

function Card({ children, className }: { children: ReactNode; className?: string }) {
  // `data-tails-part` is how the theme reaches in. Without it a generated panel
  // would sit outside every look the appearance system builds.
  return (
    <div data-tails-part="card" className={cn('p-3', className)}>
      {children}
    </div>
  );
}

function StatWidget({ widget }: { widget: Extract<Widget, { kind: 'stat' }> }) {
  return (
    <Card>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Glyph icon={widget.icon} tone={widget.tone} />
        {widget.label}
      </div>
      <div className="mt-0.5 flex items-baseline gap-2">
        {/*
          A number that visibly moves says it changed; one that swaps does not.
          Only when the value really is a number — "3.2 s" and "£11.40" are
          strings the agent formatted, and animating a parse of them would be
          animating a guess.
        */}
        <span className={cn('text-2xl font-semibold tabular-nums', toneText(widget.tone))}>
          {isPlainNumber(widget.value)
            ? <AnimatedNumber value={Number(widget.value)} />
            : widget.value}
        </span>
        {widget.delta ? (
          <span className="text-xs text-muted-foreground">{widget.delta}</span>
        ) : null}
      </div>
      {widget.hint ? (
        <div className="mt-1 text-xs text-muted-foreground">{widget.hint}</div>
      ) : null}
    </Card>
  );
}

/** Whether a formatted value is bare enough to animate as the number it is. */
function isPlainNumber(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value);
}

function ChartWidget({ widget }: { widget: Extract<Widget, { kind: 'chart' }> }) {
  // Relative to the largest bar, so the series carries its own scale and the
  // agent never has to normalise. A series of zeroes draws empty rather than
  // dividing by nothing.
  const peak = Math.max(...widget.series.map((point) => Math.abs(point.value)), 0);

  return (
    <Card>
      <WidgetTitle>{widget.title}</WidgetTitle>
      <Stagger variant="fade" className="space-y-1.5">
        {widget.series.map((point, index) => (
          <div key={`${point.label}-${index}`} className="space-y-1">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate">{point.label}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {point.value}
                {widget.unit ? ` ${widget.unit}` : ''}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <GrowBar
                fraction={peak === 0 ? 0 : Math.abs(point.value) / peak}
                delayMs={index * 30}
                className={cn('h-full rounded-full', toneFill(point.tone))}
              />
            </div>
          </div>
        ))}
      </Stagger>
    </Card>
  );
}

function TableWidget({ widget }: { widget: Extract<Widget, { kind: 'table' }> }) {
  return (
    <Card>
      <WidgetTitle>{widget.title}</WidgetTitle>
      {/*
        Its own scroller. A wide table must not be able to make the pane scroll
        sideways — the conversation beside it would go with it.
      */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-border">
              {widget.columns.map((column, index) => (
                <th key={`${column}-${index}`} className="py-1 pr-3 font-medium text-muted-foreground">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {widget.rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-b border-border/50 last:border-0">
                {/* Indexed off the columns, not the row: a short row draws blank
                    cells rather than a ragged table, and a long one cannot push
                    a column the header never announced. */}
                {widget.columns.map((_, cellIndex) => (
                  <td key={cellIndex} className="py-1 pr-3 align-top">{row[cellIndex] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ChecklistWidget({ widget }: { widget: Extract<Widget, { kind: 'checklist' }> }) {
  return (
    <Card>
      <WidgetTitle>{widget.title}</WidgetTitle>
      <Stagger variant="fade" as="ul" className="space-y-1">
        {widget.items.map((item, index) => (
          <li key={`${item.label}-${index}`} className="flex items-start gap-2 text-xs">
            {/*
              A box and a tick, not a checkbox input. These report state and do
              not collect it — a control that looks operable and is not is worse
              than a mark, and interaction is a capability this contract has
              deliberately not taken on yet.
            */}
            <span
              aria-hidden="true"
              className={cn(
                'mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded border',
                item.done ? cn('border-transparent', toneFill(item.tone ?? 'positive')) : 'border-border',
              )}
            >
              {item.done ? <Check className="size-2.5 text-background" /> : null}
            </span>
            <Glyph icon={item.icon} tone={item.tone} className="mt-0.5 size-3" />
            <span className={cn(item.done && 'text-muted-foreground line-through')}>
              {item.label}
            </span>
          </li>
        ))}
      </Stagger>
    </Card>
  );
}

function TimelineWidget({ widget }: { widget: Extract<Widget, { kind: 'timeline' }> }) {
  return (
    <Card>
      <WidgetTitle>{widget.title}</WidgetTitle>
      <Stagger variant="fade" as="ul" className="space-y-2">
        {widget.events.map((event, index) => (
          <li key={`${event.label}-${index}`} className="flex gap-2 text-xs">
            {/* The named icon in place of the generic dot, not beside it: two
                marks per row on a narrow panel is a column of noise. */}
            {event.icon
              ? <Glyph icon={event.icon} tone={event.tone} className="mt-0.5 size-3" />
              : <CircleDot className={cn('mt-0.5 size-3 shrink-0', toneText(event.tone))} aria-hidden="true" />}
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{event.label}</span>
                {event.at ? <span className="text-muted-foreground">{event.at}</span> : null}
              </div>
              {event.detail ? (
                <div className="text-muted-foreground">{event.detail}</div>
              ) : null}
            </div>
          </li>
        ))}
      </Stagger>
    </Card>
  );
}

function ProgressWidget({ widget }: { widget: Extract<Widget, { kind: 'progress' }> }) {
  return (
    <Card>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate font-medium">{widget.label}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {Math.round(widget.fraction * 100)}%
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
        <GrowBar
          fraction={widget.fraction}
          className={cn('h-full rounded-full', toneFill(widget.tone ?? 'accent'))}
        />
      </div>
      {widget.detail ? (
        <div className="mt-1 text-xs text-muted-foreground">{widget.detail}</div>
      ) : null}
    </Card>
  );
}

function NoteWidget({ widget }: { widget: Extract<Widget, { kind: 'note' }> }) {
  return (
    <Card>
      <WidgetTitle>{widget.title}</WidgetTitle>
      {/* `whitespace-pre-wrap`, so the lines the agent wrote are the lines that
          appear. Not markdown: the transcript is where prose belongs. */}
      <div className="flex gap-1.5">
        <Glyph icon={widget.icon} tone={widget.tone} className="mt-0.5 size-3" />
        <p className={cn('whitespace-pre-wrap text-xs', toneText(widget.tone))}>{widget.body}</p>
      </div>
    </Card>
  );
}

const MONITOR_LABEL: Record<Extract<Widget, { kind: 'monitor' }>['status'], string> = {
  idle: 'Not started',
  watching: 'Watching',
  match: 'Match found',
  error: 'Stopped',
};

const MONITOR_TONE: Record<Extract<Widget, { kind: 'monitor' }>['status'], Tone> = {
  idle: 'neutral',
  watching: 'accent',
  match: 'positive',
  error: 'danger',
};

function MonitorWidget({ widget }: { widget: Extract<Widget, { kind: 'monitor' }> }) {
  const tone = MONITOR_TONE[widget.status];

  return (
    <Card className={cn(widget.status === 'match' && 'ring-1 ring-positive')}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium">{widget.label}</span>
        <span className={cn('flex shrink-0 items-center gap-1 text-xs font-semibold', toneText(tone))}>
          {widget.status === 'error' ? <TriangleAlert className="size-3" aria-hidden="true" /> : null}
          {widget.status === 'watching' ? <Minus className="size-3" aria-hidden="true" /> : null}
          {MONITOR_LABEL[widget.status]}
        </span>
      </div>
      {widget.detail ? (
        <div className="mt-1 text-xs text-muted-foreground">{widget.detail}</div>
      ) : null}
      {widget.matches?.length ? (
        <ul className="mt-2 space-y-1 text-xs">
          {widget.matches.map((match, index) => (
            <li key={`${match}-${index}`} className="truncate">{match}</li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

/**
 * Kind to renderer.
 *
 * Typed as a total record over `WidgetKind`, which is the whole safety property:
 * a kind the server can produce and this file has forgotten is a compile error
 * here, not an empty box beside somebody's conversation.
 */
const RENDERERS: { [K in Widget['kind']]: (widget: Extract<Widget, { kind: K }>) => ReactNode } = {
  stat: (widget) => <StatWidget widget={widget} />,
  chart: (widget) => <ChartWidget widget={widget} />,
  table: (widget) => <TableWidget widget={widget} />,
  checklist: (widget) => <ChecklistWidget widget={widget} />,
  timeline: (widget) => <TimelineWidget widget={widget} />,
  progress: (widget) => <ProgressWidget widget={widget} />,
  note: (widget) => <NoteWidget widget={widget} />,
  monitor: (widget) => <MonitorWidget widget={widget} />,
};

export function WidgetView({ widget }: { widget: IdentifiedWidget }) {
  // The cast reunites the key with its own member of the union, which the
  // indexed lookup cannot do on its own. Safe because the record is total and
  // the discriminant is what selected the renderer.
  const render = RENDERERS[widget.kind] as (value: Widget) => ReactNode;
  return <Reveal variant="rise">{render(widget)}</Reveal>;
}
