import { AlertCircle, CheckCircle2, ChevronRight, Loader2, Wrench } from 'lucide-react';
import { useState } from 'react';

import { readToolDisplay } from '@/components/chat/toolConfigs';
import { cn } from '@/lib/utils';
import type { ChatRow } from '@/types/chat';

type ToolRowProps = { row: Extract<ChatRow, { type: 'tool' }> };

/**
 * A single tool call.
 *
 * Pure router over `toolConfigs` — every tool-specific decision lives in the
 * config, so this file does not grow when tools are added.
 */
/**
 * Three dots, cycling.
 *
 * CSS rather than state: a component re-rendering three times a second to
 * animate punctuation is a re-render of every tool row on screen, and the
 * animation is the same one every time. `animate-fade-in` alone would play
 * once; the staggered opacity keyframes are in the Tailwind config beside the
 * other motion tokens.
 */
function WorkingDots() {
  return (
    <span className="flex shrink-0 items-center gap-0.5" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="size-1 rounded-full bg-muted-foreground animate-working-dot"
          style={{ animationDelay: `${index * 180}ms` }}
        />
      ))}
    </span>
  );
}

export function ToolRow({ row }: ToolRowProps) {
  const display = readToolDisplay(row.toolName);
  const [expanded, setExpanded] = useState(!display.collapsed);

  const input = (typeof row.toolInput === 'object' && row.toolInput !== null)
    ? (row.toolInput as Record<string, unknown>)
    : {};
  const summary = display.summarize?.(input);

  const status: 'running' | 'error' | 'done' = !row.result
    ? 'running'
    : row.result.isError ? 'error' : 'done';

  const StatusIcon = status === 'running' ? Loader2 : status === 'error' ? AlertCircle : CheckCircle2;

  // A failed call is marked by its status icon rather than by a red border:
  // the `card` part owns border-color, so a `border-destructive` on the row
  // would be overridden and read as working styling that isn't.
  return (
    <div data-tails-part="card" className="text-sm transition-colors duration-quick ease-standard">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform duration-quick ease-standard',
            expanded && 'rotate-90',
          )}
          aria-hidden="true"
        />
        <Wrench className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        {/*
          The present tense while it is running, the plain noun once it is done.
          A row that says "Read" beside a filename for the eight seconds it
          spends reading is a row claiming to have finished — which is what it
          was reported as, and it is the difference between the app looking
          stuck and the app looking busy.
        */}
        <span className="shrink-0 font-medium">
          {status === 'running' ? display.active ?? display.label : display.label}
        </span>
        {summary ? (
          <span className="truncate font-mono text-xs text-muted-foreground" title={summary}>
            {summary}
          </span>
        ) : null}
        {/*
          Three dots that come and go while the call is open.

          The spinner on the right already says "running", and it is on the
          right — at the end of a long row, far from the words. This sits where
          the reading happens, and it is the thing that reads as *in progress*
          rather than as a decoration.
        */}
        {status === 'running' ? <WorkingDots /> : null}
        <StatusIcon
          className={cn(
            'ml-auto size-3.5 shrink-0',
            status === 'running' && 'animate-spin text-muted-foreground',
            status === 'error' && 'text-destructive',
            status === 'done' && 'text-positive',
          )}
          aria-label={status}
        />
      </button>

      {expanded ? (
        <div className="animate-fade-in space-y-2 border-t border-border/60 px-3 py-2">
          {Object.keys(input).length > 0 ? (
            <pre
              data-tails-part="code"
              className="overflow-x-auto whitespace-pre-wrap break-words p-2 font-mono text-xs"
            >
              {JSON.stringify(input, null, 2)}
            </pre>
          ) : null}

          {row.result?.content ? (
            <pre
              // An error body keeps its destructive tint, which is state
              // rather than surface, so only the ordinary case is a `code`
              // surface for the theme to style.
              data-tails-part={row.result.isError ? undefined : 'code'}
              className={cn(
                'max-h-80 overflow-auto whitespace-pre-wrap break-words p-2 font-mono text-xs',
                row.result.isError && 'rounded bg-destructive/10 text-destructive',
              )}
            >
              {row.result.content}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
