import { MessageCircleQuestion } from 'lucide-react';
import { useState } from 'react';

import { cn } from '@/lib/utils';
import { Reveal } from '@/shared/ui/Motion';
import type { AskUserQuestion } from '@/types/chat';

type QuestionCardProps = {
  requestId: string;
  questions: AskUserQuestion[];
  onAnswer: (requestId: string, answers: Record<string, string>, response?: string) => void;
};

/**
 * The model's own question, rendered so it can actually be answered.
 *
 * Answers are keyed by the question's exact text and valued by the chosen
 * option's label, because that is the shape the tool reads back. Multi-select
 * joins labels with a comma.
 */
export function QuestionCard({ requestId, questions, onAnswer }: QuestionCardProps) {
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState('');

  const toggle = (question: AskUserQuestion, label: string) => {
    setSelections((current) => {
      const existing = current[question.question] ?? [];
      if (!question.multiSelect) return { ...current, [question.question]: [label] };
      return {
        ...current,
        [question.question]: existing.includes(label)
          ? existing.filter((entry) => entry !== label)
          : [...existing, label],
      };
    });
  };

  const answered = questions.every((question) => (selections[question.question]?.length ?? 0) > 0);
  const canSubmit = answered || other.trim().length > 0;

  const submit = () => {
    if (!canSubmit) return;
    const answers: Record<string, string> = {};
    for (const question of questions) {
      const chosen = selections[question.question];
      if (chosen?.length) answers[question.question] = chosen.join(', ');
    }
    onAnswer(requestId, answers, other.trim() || undefined);
  };

  return (
    <Reveal variant="rise">
      <div className="rounded-xl border border-primary/40 bg-primary/5 p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium">
          <MessageCircleQuestion className="size-4 text-primary" aria-hidden="true" />
          T.A.I.L.S. needs a decision
        </div>

        <div className="space-y-4">
          {questions.map((question) => (
            <fieldset key={question.question} className="space-y-2">
              <legend className="text-sm font-medium">
                {question.header ? (
                  <span className="mr-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {question.header}
                  </span>
                ) : null}
                {question.question}
              </legend>

              <div className="space-y-1.5">
                {question.options.map((option) => {
                  const selected = (selections[question.question] ?? []).includes(option.label);
                  return (
                    <button
                      key={option.label}
                      type="button"
                      onClick={() => toggle(question, option.label)}
                      className={cn(
                        'flex w-full items-start gap-2 rounded-lg border p-2.5 text-left transition-colors duration-quick',
                        selected
                          ? 'border-primary bg-primary/10'
                          : 'border-border hover:bg-accent/50',
                      )}
                    >
                      <span
                        className={cn(
                          'mt-0.5 flex size-4 shrink-0 items-center justify-center border',
                          question.multiSelect ? 'rounded' : 'rounded-full',
                          selected ? 'border-primary bg-primary' : 'border-border',
                        )}
                        aria-hidden="true"
                      >
                        {selected ? <span className="size-1.5 rounded-full bg-primary-foreground" /> : null}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{option.label}</span>
                        {option.description ? (
                          <span className="block text-xs text-muted-foreground">{option.description}</span>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>
          ))}

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground" htmlFor={`other-${requestId}`}>
              Or answer in your own words
            </label>
            <input
              id={`other-${requestId}`}
              value={other}
              onChange={(event) => setOther(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit();
              }}
              placeholder="Something else…"
              className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none transition-shadow duration-quick focus:ring-2 focus:ring-ring"
            />
          </div>

          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-transform duration-instant ease-emphasis active:scale-95 disabled:opacity-50"
          >
            Send answer
          </button>
        </div>
      </div>
    </Reveal>
  );
}
