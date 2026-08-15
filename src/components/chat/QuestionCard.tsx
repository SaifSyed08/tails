import { MessageCircleQuestion } from 'lucide-react';
import { useState } from 'react';

import { composeAnswer } from '@/components/chat/answers';
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
 * Every question owns its options *and* its own free-text box. The previous
 * version had one shared box whose contents were sent as `response` while
 * `answers` stayed empty — which the runtime read as "no option was chosen",
 * so a typed answer reached the tool as no answer at all.
 */
export function QuestionCard({ requestId, questions, onAnswer }: QuestionCardProps) {
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});

  const toggle = (question: AskUserQuestion, label: string) => {
    setSelections((current) => {
      const existing = current[question.question] ?? [];
      if (!question.multiSelect) {
        // Tapping the chosen option again clears it, which is the only way to
        // fall back to a typed answer without reloading the card.
        return {
          ...current,
          [question.question]: existing[0] === label ? [] : [label],
        };
      }
      return {
        ...current,
        [question.question]: existing.includes(label)
          ? existing.filter((entry) => entry !== label)
          : [...existing, label],
      };
    });
  };

  const answerFor = (question: AskUserQuestion) => composeAnswer(
    selections[question.question] ?? [],
    custom[question.question] ?? '',
  );

  // Every question needs something, or the tool reports the whole set
  // unanswered — a half-filled form is not a partial answer to it.
  const canSubmit = questions.every((question) => answerFor(question).length > 0);

  const submit = () => {
    if (!canSubmit) return;
    const answers: Record<string, string> = {};
    for (const question of questions) {
      answers[question.question] = answerFor(question);
    }
    onAnswer(requestId, answers);
  };

  return (
    <Reveal variant="rise">
      <div data-tails-part="card" className="p-4">
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
                      aria-pressed={selected}
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

              <input
                value={custom[question.question] ?? ''}
                onChange={(event) => setCustom((current) => ({
                  ...current,
                  [question.question]: event.target.value,
                }))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') submit();
                }}
                placeholder="Or answer in your own words…"
                aria-label={`Your own answer to: ${question.question}`}
                data-tails-part="input"
                className="w-full px-2.5 py-1.5 text-sm outline-none transition-shadow duration-quick focus:[--t-shadow:0_0_0_1px_hsl(var(--ring)/0.45),0_8px_24px_-10px_hsl(var(--ring)/0.5)]"
              />
            </fieldset>
          ))}

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
