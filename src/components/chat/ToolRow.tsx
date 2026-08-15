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
        <span className="shrink-0 font-medium">{display.label}</span>
        {summary ? (
          <span className="truncate font-mono text-xs text-muted-foreground" title={summary}>
            {summary}
          </span>
        ) : null}
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
