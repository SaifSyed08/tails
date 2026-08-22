import { useCallback, useEffect, useRef, useState } from 'react';

import {
  canAnswerByVoice,
  hearApproval,
  hearConfirmation,
  hearPlanAnswer,
  hearQuestionAnswer,
  needsConfirmation,
  speakConfirmation,
  speakExplanation,
  speakPermission,
  speakPlan,
  speakQuestion,
  speakRetry,
} from '@/components/voice/spoken-approval';
import type { PendingPermission, PendingPrompt } from '@/types/chat';

/**
 * Putting a permission request to the user out loud, and hearing the answer.
 *
 * The counterpart to `useSpokenReply`, and the reason voice mode is worth
 * having: everything else about walking away from the machine already worked,
 * and then the first `Bash` call parked the whole turn behind a button.
 *
 * ## Two things that are not the same thing
 *
 * *Which question is on the table* and *whether the microphone is open* are
 * tracked separately, because they change independently and an earlier version
 * that folded them into one value lost the difference at the worst moment: the
 * second yes on a destructive command arrived while the state said "asking for
 * the first time", and was read as a fresh approval of something else.
 *
 * ## What this hook is careful about
 *
 * **It never speaks unless voice mode is on.** Approvals arrive whether or not
 * anyone is listening, and reading them aloud to someone typing at their desk
 * would be a new way for the app to talk over its user.
 *
 * **It gives up rather than guessing.** Two answers it cannot read and the
 * request goes back to the screen, with a spoken sentence saying so. A prompt
 * that keeps asking is worse than a card, because the card at least stops.
 *
 * **Consequence gets a second question**, naming what will happen rather than
 * asking "are you sure" — see `spoken-approval.ts` for why that matters aloud.
 */

type Speech = {
  speaking: boolean;
  enqueue: (markdown: string) => void;
};

type Options = {
  /**
   * Whether voice is the user's declared intent right now.
   *
   * Not "is the microphone open": dictation opens the microphone too, and a
   * dictated "yeah" landing on a permission prompt is exactly the accident this
   * flag exists to prevent.
   */
  armed: boolean;
  pendingPermissions: readonly PendingPermission[];
  pendingPrompts: readonly PendingPrompt[];
  speech: Speech;
  answerPermission: (requestId: string, allow: boolean, remember?: boolean) => void;
  answerQuestion: (requestId: string, answers: Record<string, string>, response?: string) => void;
  answerPlan: (
    requestId: string,
    approve: boolean,
    options?: { autoAcceptEdits?: boolean; message?: string },
  ) => void;
};

/** The request being handled, reduced to what answering it needs. */
type Target =
  | { kind: 'permission'; requestId: string; toolName: string; input: unknown; description?: string }
  | { kind: 'question'; requestId: string; question: string; labels: string[] }
  | { kind: 'plan'; requestId: string };

/** Which question is outstanding. Independent of whether we are talking. */
type Stage = 'deciding' | 'confirming';

export type SpokenApproval = {
  /** The request being handled out loud, or null. Drives the `asking` mode. */
  asking: { prompt: string; awaiting: boolean } | null;
  /**
   * Offers a transcript as an answer.
   *
   * Returns true when it was consumed, which is the caller's signal **not** to
   * put those words in the composer. "Approve" is not a message.
   */
  hear: (text: string) => boolean;
  /**
   * Whether the spoken turn that just ended was an answer rather than a message.
   *
   * Read once and cleared: `onText` runs before `onSpokenTurn`, so by the time
   * the send would happen the answer has already been consumed and the target
   * may already be gone.
   */
  swallowTurn: () => boolean;
};

/**
 * How long to wait for speech to actually start before opening the microphone
 * anyway.
 *
 * Without this the hook deadlocks on a machine where synthesis fails: it would
 * wait to finish speaking for ever, never capture, and the user would hear
 * nothing and be unable to answer either. Losing the prompt is bad; losing the
 * prompt *and* the ability to reply is worse.
 */
const SPEECH_START_TIMEOUT_MS = 1500;

/** Unreadable answers tolerated before the request goes back to the screen. */
const MAX_MISSES = 2;

export function useSpokenApproval({
  armed, pendingPermissions, pendingPrompts, speech,
  answerPermission, answerQuestion, answerPlan,
}: Options): SpokenApproval {
  const [target, setTarget] = useState<Target | null>(null);
  const [awaiting, setAwaiting] = useState(false);
  const [prompt, setPrompt] = useState('');

  const targetRef = useRef<Target | null>(null);
  useEffect(() => { targetRef.current = target; }, [target]);
  /** Not state: nothing renders differently for it, and `hear` must see it now. */
  const stageRef = useRef<Stage>('deciding');
  /** The decision waiting on its second yes. */
  const heldRef = useRef<{ remember: boolean } | null>(null);
  const missesRef = useRef(0);
  /** Requests handed back to the screen. Never picked up again. */
  const deferredRef = useRef(new Set<string>());
  const swallowRef = useRef(false);
  /** True once synthesis has actually begun for the current prompt. */
  const startedRef = useRef(false);

  const speechRef = useRef(speech);
  useEffect(() => { speechRef.current = speech; }, [speech]);
  const answerPermissionRef = useRef(answerPermission);
  useEffect(() => { answerPermissionRef.current = answerPermission; }, [answerPermission]);
  const answerQuestionRef = useRef(answerQuestion);
  useEffect(() => { answerQuestionRef.current = answerQuestion; }, [answerQuestion]);
  const answerPlanRef = useRef(answerPlan);
  useEffect(() => { answerPlanRef.current = answerPlan; }, [answerPlan]);

  /** Says something and closes the microphone until it has been said. */
  const say = useCallback((text: string) => {
    setPrompt(text);
    setAwaiting(false);
    startedRef.current = false;
    speechRef.current.enqueue(text);
  }, []);

  const clear = useCallback(() => {
    setTarget(null);
    targetRef.current = null;
    stageRef.current = 'deciding';
    heldRef.current = null;
    missesRef.current = 0;
    startedRef.current = false;
    setAwaiting(false);
    setPrompt('');
  }, []);

  /** Hands the request back to the screen, saying so rather than going quiet. */
  const defer = useCallback((requestId: string, why: string) => {
    deferredRef.current.add(requestId);
    speechRef.current.enqueue(why);
    clear();
  }, [clear]);

  /*
    Picking up the next request.

    Permissions before prompts, and only one at a time: two questions read out
    together are two questions nobody can answer, and the second one will still
    be there when the first is done.
  */
  useEffect(() => {
    if (!armed) {
      if (targetRef.current) clear();
      return;
    }
    if (targetRef.current) return;

    const permission = pendingPermissions.find((entry) => !deferredRef.current.has(entry.requestId));
    if (permission) {
      setTarget({
        kind: 'permission',
        requestId: permission.requestId,
        toolName: permission.toolName,
        input: permission.input,
        description: permission.description,
      });
      say(speakPermission(permission.toolName, permission.input, permission.title));
      return;
    }

    const pending = pendingPrompts.find((entry) => !deferredRef.current.has(entry.requestId));
    if (!pending) return;

    if (pending.kind === 'plan') {
      setTarget({ kind: 'plan', requestId: pending.requestId });
      say(speakPlan(pending.plan));
      return;
    }

    if (!canAnswerByVoice(pending.questions)) {
      // Honest rather than silent. The alternative — reading out a multi-select
      // and parsing "the first and third" — is a guess at what someone meant on
      // a question the model asked because it could not guess either.
      defer(pending.requestId, 'There is a question on screen I cannot answer by voice.');
      return;
    }

    const [question] = pending.questions;
    const labels = question.options.map((option) => option.label);
    setTarget({
      kind: 'question', requestId: pending.requestId, question: question.question, labels,
    });
    say(speakQuestion(question.question, labels));
  }, [armed, pendingPermissions, pendingPrompts, say, clear, defer]);

  /*
    The request went away while we were talking about it — answered on screen,
    cancelled by an abort, or timed out server-side. Whatever we were about to
    ask is now a question about nothing.
  */
  useEffect(() => {
    const current = targetRef.current;
    if (!current) return;
    const alive = pendingPermissions.some((entry) => entry.requestId === current.requestId)
      || pendingPrompts.some((entry) => entry.requestId === current.requestId);
    if (!alive) clear();
  }, [pendingPermissions, pendingPrompts, clear]);

  /*
    Speaking finished, so the microphone may open.

    `startedRef` is the same guard `useSpokenReply` needs and for the same
    reason: `speaking` is false both before synthesis begins and after it ends,
    and only the second one means the prompt has been heard.
  */
  useEffect(() => {
    if (!target || awaiting) return undefined;

    if (speech.speaking) {
      startedRef.current = true;
      return undefined;
    }
    if (startedRef.current) {
      setAwaiting(true);
      return undefined;
    }

    const timer = setTimeout(() => setAwaiting(true), SPEECH_START_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [target, awaiting, speech.speaking]);

  /** An answer that could not be read. Asks again, or gives up saying so. */
  const miss = useCallback((requestId: string) => {
    missesRef.current += 1;
    if (missesRef.current > MAX_MISSES) {
      defer(requestId, 'I will leave this one on screen.');
      return;
    }
    say(speakRetry());
  }, [defer, say]);

  const settle = useCallback((run: () => void) => {
    run();
    clear();
  }, [clear]);

  const hear = useCallback((text: string): boolean => {
    const current = targetRef.current;
    if (!current) return false;

    // Consumed either way: these words were spoken at a permission prompt, and
    // letting an unreadable answer fall through to the composer would put
    // "uhh, sure?" in the user's next message.
    swallowRef.current = true;

    if (current.kind === 'question') {
      const index = hearQuestionAnswer(text, current.labels);
      if (index === null) { miss(current.requestId); return true; }
      settle(() => answerQuestionRef.current(
        current.requestId,
        { [current.question]: current.labels[index] },
      ));
      return true;
    }

    if (current.kind === 'plan') {
      const answer = hearPlanAnswer(text);
      if (answer === 'explain') {
        // A plan's detail is the plan, and it is already on screen in full.
        // Reciting it is what `speakPlan` exists to avoid doing once.
        say('The plan is on screen. Approve it, or deny it?');
        return true;
      }
      if (answer === 'unknown') { miss(current.requestId); return true; }
      settle(() => answerPlanRef.current(current.requestId, answer === 'approve'));
      return true;
    }

    if (stageRef.current === 'confirming') {
      const held = heldRef.current;
      const confirmed = hearConfirmation(text);
      if (confirmed === 'unknown' || !held) { miss(current.requestId); return true; }
      if (confirmed === 'no') {
        // A refused confirmation refuses the whole thing. Falling back to "then
        // just approve it the once" would make the second question a formality.
        settle(() => answerPermissionRef.current(current.requestId, false));
        return true;
      }
      settle(() => answerPermissionRef.current(current.requestId, true, held.remember));
      return true;
    }

    const intent = hearApproval(text);

    if (intent === 'explain') {
      say(speakExplanation(current.toolName, current.input, current.description));
      return true;
    }
    if (intent === 'unknown') { miss(current.requestId); return true; }
    if (intent === 'deny') {
      // Refusal is never confirmed. The safe answer has to be the cheap one, or
      // the confirmation becomes a tax on saying no.
      settle(() => answerPermissionRef.current(current.requestId, false));
      return true;
    }

    const remember = intent === 'always';
    const consequence = needsConfirmation(current.toolName, current.input, remember);
    if (!consequence) {
      settle(() => answerPermissionRef.current(current.requestId, true, remember));
      return true;
    }

    stageRef.current = 'confirming';
    heldRef.current = { remember };
    // The misses so far were spent understanding the first question; the second
    // one deserves its own allowance rather than inheriting a nearly spent one.
    missesRef.current = 0;
    say(speakConfirmation(consequence));
    return true;
  }, [miss, say, settle]);

  const swallowTurn = useCallback((): boolean => {
    const swallowed = swallowRef.current;
    swallowRef.current = false;
    return swallowed;
  }, []);

  return {
    asking: target ? { prompt, awaiting } : null,
    hear,
    swallowTurn,
  };
}
