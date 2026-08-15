import { ClipboardList } from 'lucide-react';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { Reveal } from '@/shared/ui/Motion';

type PlanCardProps = {
  requestId: string;
  plan: string;
  onAnswer: (
    requestId: string,
    approve: boolean,
    options?: { autoAcceptEdits?: boolean; message?: string },
  ) => void;
};

/**
 * The plan the model wants approved, shown before you approve it.
 *
 * Rejecting is not a refusal — the note goes back to the model and it keeps
 * planning with that feedback, which is the third option Claude Code offers
 * and the one people actually reach for.
 */
export function PlanCard({ requestId, plan, onAnswer }: PlanCardProps) {
  const [note, setNote] = useState('');
  const [rejecting, setRejecting] = useState(false);

  return (
    <Reveal variant="rise">
      <div className="rounded-xl border border-primary/40 bg-card p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium">
          <ClipboardList className="size-4 text-primary" aria-hidden="true" />
          Plan ready for review
        </div>

        <div className="prose-tails max-h-80 overflow-y-auto rounded-lg bg-muted/40 p-3 text-sm">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan}</ReactMarkdown>
        </div>

        {rejecting ? (
          <div className="mt-3 space-y-2">
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
              autoFocus
              placeholder="What should it do differently?"
              aria-label="Feedback on the plan"
              className="w-full resize-y rounded-lg border border-border bg-background p-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onAnswer(requestId, false, { message: note.trim() || undefined })}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-transform duration-instant ease-emphasis active:scale-95"
              >
                Send feedback
              </button>
              <button
                type="button"
                onClick={() => setRejecting(false)}
                className="rounded-md border border-border px-3 py-1.5 text-xs transition-colors duration-quick hover:bg-accent"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onAnswer(requestId, true, { autoAcceptEdits: true })}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-transform duration-instant ease-emphasis active:scale-95"
            >
              Approve &amp; auto-accept edits
            </button>
            <button
              type="button"
              onClick={() => onAnswer(requestId, true)}
              className="rounded-md border border-border px-3 py-1.5 text-xs transition-colors duration-quick hover:bg-accent"
            >
              Approve, ask each edit
            </button>
            <button
              type="button"
              onClick={() => setRejecting(true)}
              className="rounded-md border border-border px-3 py-1.5 text-xs transition-colors duration-quick hover:bg-accent"
            >
              Keep planning…
            </button>
          </div>
        )}
      </div>
    </Reveal>
  );
}
