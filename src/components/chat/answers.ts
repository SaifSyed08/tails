/**
 * Composing an answer to one `AskUserQuestion` question.
 *
 * The tool's contract is question text -> a single string, with multi-select
 * answers comma-separated, and the string is arbitrary: its schema says not to
 * offer an "Other" option because one is provided automatically. Typed text is
 * therefore an answer in exactly the same sense a picked label is, and belongs
 * in the same string rather than in a separate field the tool does not read as
 * an answer.
 *
 * Import-free so the repo's test runner can execute it directly.
 */
export function composeAnswer(labels: string[], custom: string): string {
  return [...labels, custom.trim()].filter(Boolean).join(', ');
}
