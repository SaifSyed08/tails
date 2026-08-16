import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';

import type { ModelChoice } from '@/modules/chat/model.service.js';

/** Every effort level the SDK defines, weakest first. */
export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export type TurnSettings = {
  /** Wire id, or undefined to run on whatever the CLI resolves to. */
  model?: string;
  effort?: EffortLevel;
};

export type ResolvedTurnSettings = TurnSettings & {
  /**
   * What could not be honoured, in the user's terms.
   *
   * Non-empty means something the composer offered was refused, and the run
   * must say so: a request that is silently dropped leaves the UI claiming a
   * model or an effort that never took, which is worse than an error.
   */
  problems: string[];
};

export function readEffortLevel(value: unknown): EffortLevel | undefined {
  return EFFORT_LEVELS.find((level) => level === value);
}

/**
 * Decides what a turn may actually run with.
 *
 * Validated against the catalogue the CLI itself reported, so an account that
 * cannot use a model cannot be talked into trying — but only when that
 * catalogue is known. An empty list means "we could not read it", not "nothing
 * is available", and refusing every model on that basis would break sending
 * for anyone whose catalogue read failed.
 */
export function resolveTurnSettings(
  requested: TurnSettings,
  catalogue: ModelChoice[],
): ResolvedTurnSettings {
  const problems: string[] = [];
  const known = catalogue.length > 0;

  let model = requested.model;
  const chosen = model ? catalogue.find((entry) => entry.id === model) : undefined;

  if (model && known && !chosen) {
    problems.push(`This account cannot use the model "${model}", so this turn ran on the default.`);
    model = undefined;
  }

  let effort = requested.effort;
  // Only enforced against a model we actually know the capabilities of. A
  // model we could not look up gets the benefit of the doubt, and the CLI is
  // the backstop if the level is wrong.
  if (effort && chosen && !chosen.effortLevels.includes(effort)) {
    // Named only when the model has effort levels and this is not one of them.
    // A model with no effort control at all is not a mistake the user made —
    // the picker does not offer it — so the setting is simply dropped rather
    // than reported as a refusal.
    if (chosen.effortLevels.length > 0) {
      problems.push(
        `${chosen.displayName} does not offer "${effort}" effort, so this turn ran at its default.`,
      );
    }
    effort = undefined;
  }

  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    problems,
  };
}
