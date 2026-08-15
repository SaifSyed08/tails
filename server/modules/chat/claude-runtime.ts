import { query, type CanUseTool, type Options, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';

import { sessionsRepository } from '@/db/sessions.repository.js';
import { APPEARANCE_ALLOWED_TOOLS, appearanceMcpServer } from '@/modules/appearance/appearance.tools.js';
import { expandLocalCommand } from '@/modules/chat/commands.service.js';
import {
  formatAttachedFileHeading,
  normalizeSdkMessage,
  toMessageAttachment,
} from '@/modules/chat/normalize.js';
import { runRegistry } from '@/modules/chat/run-registry.js';
import { publishSessionsChanged } from '@/shared/broadcast.js';
import type { AskUserQuestion, NormalizedMessage, PermissionDecision } from '@/shared/types.js';
import { createCompleteMessage, createMessage, readRecord } from '@/shared/utils.js';

/**
 * How long a permission prompt waits before denying by default.
 *
 * A run parked forever on a prompt nobody is looking at is worse than a denial
 * the user can retry, but the window has to be long enough to walk away from
 * the keyboard and come back.
 */
const PERMISSION_TIMEOUT_MS = Number(process.env.TAILS_PERMISSION_TIMEOUT_MS || 120_000);

/**
 * Tools whose entire purpose is to ask the user something.
 *
 * These never auto-resolve and never time out — a timeout would mean the model
 * proceeds on an answer the user never gave.
 */
const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/**
 * Reads the questions out of an `AskUserQuestion` call.
 *
 * Defensive because this is the tool's own schema rather than ours: a shape
 * change should degrade to a plain permission prompt, not throw mid-run.
 */
function readQuestions(input: unknown): AskUserQuestion[] {
  const record = readRecord(input);
  if (!Array.isArray(record?.questions)) return [];

  return record.questions.flatMap((entry): AskUserQuestion[] => {
    const question = readRecord(entry);
    const text = typeof question?.question === 'string' ? question.question : null;
    if (!text || !Array.isArray(question?.options)) return [];

    const options = question.options.flatMap((rawOption) => {
      const option = readRecord(rawOption);
      const label = typeof option?.label === 'string' ? option.label : null;
      return label
        ? [{
          label,
          description: typeof option?.description === 'string' ? option.description : '',
          ...(typeof option?.preview === 'string' ? { preview: option.preview } : {}),
        }]
        : [];
    });

    return options.length > 0
      ? [{
        question: text,
        header: typeof question.header === 'string' ? question.header : '',
        multiSelect: question.multiSelect === true,
        options,
      }]
      : [];
  });
}

/**
 * The answers to hand back to `AskUserQuestion`, keyed by question text.
 *
 * Free text is a first-class answer in that tool's contract: the value is an
 * arbitrary string, and its schema says not to offer an "Other" option because
 * one is provided automatically. A decision carrying only `response` was
 * therefore an answer, but the runtime read the empty `answers` map as "no
 * option was picked" and allowed the call with its input untouched — which is
 * precisely what makes the tool report that the user did not answer.
 *
 * Mapping a bare `response` is only unambiguous with a single question on the
 * card; with several there is no way to know which one it answers, so it is
 * left for the tool to see as free-text context rather than guessed at.
 */
export function resolveQuestionAnswers(
  decision: Pick<PermissionDecision, 'answers' | 'response'>,
  questions: AskUserQuestion[],
): Record<string, string> {
  const answers = { ...(decision.answers ?? {}) };
  const response = decision.response?.trim();

  if (Object.keys(answers).length === 0 && response && questions.length === 1) {
    answers[questions[0].question] = response;
  }

  return answers;
}

type ParkedPermission = {
  resolve: (decision: PermissionDecision) => void;
  timer: NodeJS.Timeout | null;
  sessionId: string;
};

const parkedPermissions = new Map<string, ParkedPermission>();

/** Tools the user chose to remember, per app session. */
const rememberedTools = new Map<string, Set<string>>();

/**
 * Resolves a pending permission prompt.
 *
 * Called from the websocket layer when the user answers. Unknown ids are
 * ignored rather than throwing: a late answer to a prompt that already timed
 * out is a normal race, not an error.
 */
export function resolvePermission(requestId: string, decision: PermissionDecision): boolean {
  const parked = parkedPermissions.get(requestId);
  if (!parked) return false;

  if (parked.timer) clearTimeout(parked.timer);
  parkedPermissions.delete(requestId);
  runRegistry.removePendingPermission(parked.sessionId, requestId);
  parked.resolve(decision);
  return true;
}

/**
 * The permission modes exposed in the UI.
 *
 * Deliberately a subset of the SDK's set. `bypassPermissions` and `dontAsk`
 * are omitted because both resolve permissions *before* `canUseTool` fires,
 * which would silently stop questions and plans reaching the user — the exact
 * failure this app just finished fixing.
 */
export const SELECTABLE_PERMISSION_MODES = ['default', 'acceptEdits', 'plan'] as const;
export type SelectablePermissionMode = typeof SELECTABLE_PERMISSION_MODES[number];

/** One file the user attached to a message. */
export type ChatAttachment = {
  name: string;
  /** e.g. `image/png`. Non-image types are inlined as text. */
  mediaType: string;
  /** Base64 payload, without a data-URL prefix. */
  data: string;
};

/** Attachment types the model can actually look at as images. */
const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * Normalises what a browser reports as a file's type.
 *
 * `image/jpg` is not a real media type but is what several tools stamp on a
 * JPEG, and the API rejects the whole block rather than guessing — one
 * mislabelled screenshot must not cost the user their attachment.
 */
function normalizeMediaType(mediaType: string): string {
  const lowered = mediaType.trim().toLowerCase();
  return lowered === 'image/jpg' ? 'image/jpeg' : lowered;
}

/**
 * Strips a data-URL prefix if one survived the client.
 *
 * The wire contract says bare base64, but a prefix reaching the API is a
 * silent decode failure — the run continues and the model simply cannot see
 * the image, which is exactly the failure that is hardest to notice.
 */
function readBase64(data: string): string {
  const comma = data.startsWith('data:') ? data.indexOf(',') : -1;
  return comma >= 0 ? data.slice(comma + 1) : data;
}

type RunChatTurnInput = {
  sessionId: string;
  prompt: string;
  cwd: string;
  permissionMode?: SelectablePermissionMode;
  attachments?: ChatAttachment[];
};

/**
 * Builds the content blocks for one turn.
 *
 * Exported for the test that guards the block shapes: a malformed `image`
 * block does not fail the run, it just quietly reaches the model as nothing,
 * which is indistinguishable from the attachment never having been sent.
 */
export function buildPromptBlocks(
  text: string,
  attachments: ChatAttachment[],
): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];

  for (const attachment of attachments) {
    const mediaType = normalizeMediaType(attachment.mediaType);
    if (SUPPORTED_IMAGE_TYPES.has(mediaType)) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: readBase64(attachment.data) },
      });
      continue;
    }

    // Anything else is inlined as labelled text. Silently dropping a file the
    // user visibly attached is worse than showing the model its contents, and
    // the heading is what lets the transcript reader turn it back into a chip.
    const decoded = Buffer.from(readBase64(attachment.data), 'base64').toString('utf8');
    blocks.push({
      type: 'text',
      text: `${formatAttachedFileHeading(attachment.name)}\n\n${decoded.slice(0, 200_000)}`,
    });
  }

  // Last, so the instruction is the most recent thing the model reads. An
  // empty text block is rejected by the API outright, which would fail the
  // whole turn for someone who sent nothing but a screenshot.
  if (text.trim()) blocks.push({ type: 'text', text });
  return blocks;
}

/**
 * Builds the prompt the SDK receives.
 *
 * A plain string cannot carry anything but text, so any attachment forces the
 * async-iterable form. One message is yielded and the iterable completes,
 * which keeps the existing one-run-per-turn lifecycle intact — a long-lived
 * streaming session would also allow queued input, but that is a larger change
 * than attachments need.
 */
function buildPrompt(text: string, attachments: ChatAttachment[]) {
  if (attachments.length === 0) return text;

  const blocks = buildPromptBlocks(text, attachments);

  return (async function* prompt() {
    yield {
      type: 'user' as const,
      message: { role: 'user' as const, content: blocks },
      parent_tool_use_id: null,
      session_id: '',
    };
  })();
}

/**
 * The permission mode each conversation is actually running in.
 *
 * Kept here because this is where the mode is applied and where a plan
 * approval changes it mid-run. Without it the composer had no source of truth
 * to read and simply showed whatever the last conversation was set to.
 */
const sessionPermissionModes = new Map<string, SelectablePermissionMode>();

/**
 * How long the stream is drained after the turn has already finished.
 *
 * The SDK delivers a prompt suggestion *after* the `result` message, so the
 * iterator has to be read past the end of the visible turn. This bounds that
 * wait: a suggestion is a nicety, and a subprocess we never stop reading is
 * not something to trade for it.
 */
const SUGGESTION_DRAIN_MS = 20_000;

/**
 * Which turn each conversation is currently on.
 *
 * A suggestion belongs to the turn that produced it. If the user has already
 * sent the next message by the time it arrives, it is an answer to a question
 * nobody is asking any more, so it is dropped rather than shown against the
 * wrong turn.
 */
const sessionTurnTokens = new Map<string, number>();
let turnCounter = 0;

export function getSessionPermissionMode(sessionId: string): SelectablePermissionMode {
  return sessionPermissionModes.get(sessionId) ?? 'default';
}

/**
 * Runs one conversational turn against Claude Code.
 *
 * Every event the SDK yields is normalized and pushed through the run
 * registry, which owns sequencing and replay. This function owns exactly two
 * things the registry cannot: translating SDK events, and guaranteeing that
 * the run terminates with a `complete` no matter how it ends.
 */
export async function runChatTurn(input: RunChatTurnInput): Promise<void> {
  const { sessionId, prompt, cwd, permissionMode, attachments = [] } = input;

  const session = sessionsRepository.getSession(sessionId);
  if (!session) {
    throw new Error(`Unknown session ${sessionId}`);
  }

  const abortController = new AbortController();
  const run = runRegistry.startRun(sessionId, () => abortController.abort());
  if (!run) {
    // A second send while one is in flight would interleave two runs into the
    // same transcript. Tell the client rather than silently dropping it.
    runRegistry.record(sessionId, createMessage('protocol_error', sessionId, {
      errorCode: 'run_in_progress',
      content: 'This conversation is already generating a response.',
    }));
    return;
  }

  const send = (message: NormalizedMessage) => runRegistry.record(sessionId, message);
  let exitCode = 0;

  const turnToken = ++turnCounter;
  sessionTurnTokens.set(sessionId, turnToken);

  /**
   * Ends the turn for the user.
   *
   * Split out of the `finally` because the stream now outlives the turn: the
   * prompt suggestion arrives after `result`, and holding the terminal
   * `complete` until the iterator finishes would leave the spinner running
   * for however long that takes. Called from both places; the registry drops
   * the duplicate, but tracking it here keeps the sidebar refresh from firing
   * twice as well.
   */
  let completed = false;
  const finishTurn = () => {
    if (completed) return;
    completed = true;
    send(createCompleteMessage(sessionId, exitCode));
    sessionsRepository.touchSession(sessionId);
    publishSessionsChanged(sessionId);
  };

  let drainTimer: NodeJS.Timeout | null = null;

  // The mode this turn runs in is the mode the conversation is in, so a
  // client that reconnects — or a new one that opens the same chat — can be
  // told what is actually in force rather than guessing.
  sessionPermissionModes.set(sessionId, permissionMode ?? 'default');

  // Echo what the user actually typed, not the expanded form — seeing
  // `/personalize` turn into a paragraph of instructions in your own
  // transcript is disorienting. The attachments ride along so the bubble can
  // show them immediately, before the transcript is read back.
  send(createMessage('text', sessionId, {
    role: 'user',
    content: prompt,
    ...(attachments.length > 0
      ? { attachments: attachments.map(toMessageAttachment) }
      : {}),
  }));

  // Stamped at the *start* of the turn, not only when it finishes. A long
  // agentic run can take minutes, and the conversation the user is actively
  // typing in has to reach the top of the sidebar the moment their message
  // lands rather than whenever the agent happens to stop.
  sessionsRepository.touchSession(sessionId);
  publishSessionsChanged(sessionId);

  const modelPrompt = buildPrompt(expandLocalCommand(prompt), attachments);

  try {
    const options: Options = {
      cwd,
      abortController,
      // Spreading rather than assigning: `options.env` REPLACES process.env in
      // the SDK rather than merging into it, so a bare object would strip PATH
      // and the subprocess would fail to spawn.
      env: { ...process.env } as Record<string, string>,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        // The agent has to be told this capability exists, and — the part that
        // was missing — told that the whole of it exists. Naming only list,
        // preview and apply here is what made the freeform layer dead code:
        // theme_css was implemented and reachable, and nothing ever mentioned
        // it, so the model's entire mental model of "restyling" stopped at the
        // declarative spec.
        append: [
          'You can restyle the T.A.I.L.S. interface you are running inside, and you have real room to work: mcp__tails-appearance__theme_preview and __theme_apply compile a declarative spec, __theme_css layers arbitrary hand-written CSS over it for anything the spec cannot express, and __theme_controls publishes live sliders and toggles for the look you just made so the user can tune it without asking you.',
          'mcp__tails-appearance__theme_list is for reading how the shipped presets are built. It is not a menu: answering a request for a mood with "the closest preset is X" is a failure, not an answer. Compose the look the user asked for, and if a primitive is genuinely missing, say which one.',
          `The current conversation id is ${sessionId}; pass it as sessionId and prefer scope "conversation" unless the user explicitly asks to change their default.`,
        ].join(' '),
      },
      tools: { type: 'preset', preset: 'claude_code' },
      // 'project' is required for CLAUDE.md files to load.
      settingSources: ['user', 'project', 'local'],
      // Token-level streaming; without it the UI renders a message at a time.
      includePartialMessages: true,
      // The composer offers the model's guess at the user's next message as
      // ghost text. Nearly free — the suggestion rides the turn's own prompt
      // cache — and the CLI suppresses it wherever it would be unwelcome
      // (first turn, plan mode, after an API error, or if the user turned it
      // off in their own settings), so there is nothing to gate here.
      promptSuggestions: true,
      // In-process, so the handlers reach the theme service directly instead of
      // authenticating back into our own HTTP API.
      mcpServers: { 'tails-appearance': appearanceMcpServer },
      // Every appearance tool runs unprompted; see the comment on the constant
      // for why the two that used to be gated no longer are. What guards the
      // user is that the freeform layer is never persisted and the panic key is
      // handled in the main process — not a modal in the middle of a design
      // conversation the user started.
      allowedTools: APPEARANCE_ALLOWED_TOOLS,
      // Per-turn rather than mid-session: a string prompt spawns a fresh CLI
      // each turn, so any live mode change would be discarded anyway.
      ...(permissionMode ? { permissionMode } : {}),
      canUseTool: createPermissionGate(sessionId),
      ...(session.providerSessionId ? { resume: session.providerSessionId } : {}),
      ...(process.env.TAILS_CLAUDE_PATH
        ? { pathToClaudeCodeExecutable: process.env.TAILS_CLAUDE_PATH }
        : {}),
    };

    const instance = query({ prompt: modelPrompt as never, options });

    for await (const message of instance) {
      const event = readRecord(message);

      // The provider's session id arrives on the first event of a new
      // conversation and is the only handle that can resume this transcript.
      const providerSessionId = typeof event?.session_id === 'string' ? event.session_id : null;
      if (providerSessionId && !session.providerSessionId) {
        sessionsRepository.assignProviderSessionId(sessionId, providerSessionId);
        session.providerSessionId = providerSessionId;
        send(createMessage('session_created', sessionId, { content: providerSessionId }));
        // The transcript now exists, which is what makes this conversation
        // eligible for the sidebar at all.
        publishSessionsChanged(sessionId);
      }

      // A suggestion that outlived its turn — the user has already sent the
      // next message — would be offered as a reply to the wrong thing.
      if (event?.type === 'prompt_suggestion' && sessionTurnTokens.get(sessionId) !== turnToken) {
        continue;
      }

      for (const normalized of normalizeSdkMessage(message, sessionId)) {
        send(normalized);
      }

      if (event?.type === 'result') {
        // The turn is over on screen here, not when the iterator ends. What
        // follows is only the suggestion, and it must not hold the spinner.
        finishTurn();
        drainTimer = setTimeout(() => abortController.abort(), SUGGESTION_DRAIN_MS);
      }
    }
  } catch (error) {
    // An abort is a user action, not a failure, and the client already knows.
    if (!abortController.signal.aborted) {
      exitCode = 1;
      send(createMessage('error', sessionId, {
        errorCode: 'runtime_error',
        content: error instanceof Error ? error.message : String(error),
      }));
    }
  } finally {
    if (drainTimer) clearTimeout(drainTimer);
    // The one guaranteed terminal event. Without this in a `finally`, any
    // throw above leaves the client's spinner running forever. A turn that
    // reached its `result` has already sent it.
    finishTurn();

    for (const [requestId, parked] of parkedPermissions) {
      if (parked.sessionId !== sessionId) continue;
      if (parked.timer) clearTimeout(parked.timer);
      parkedPermissions.delete(requestId);
      parked.resolve({ allow: false, message: 'The run ended before this was answered.' });
    }
  }
}

/**
 * Builds the permission callback for one session.
 *
 * Note a real constraint inherited from the SDK: in `auto` and
 * `bypassPermissions` modes the permission mode resolves *before* this
 * callback runs, so interactive tools never reach the UI. This app runs in the
 * default mode, where the callback does fire; if a permission-mode selector is
 * added later, interactive tools must move to a `PermissionRequest` hook,
 * which runs ahead of the mode check.
 */
function createPermissionGate(sessionId: string): CanUseTool {
  return async (toolName, toolInput, context) => {
    const remembered = rememberedTools.get(sessionId);
    if (remembered?.has(toolName) && !INTERACTIVE_TOOLS.has(toolName)) {
      return { behavior: 'allow', updatedInput: toolInput } satisfies PermissionResult;
    }

    const requestId = randomUUID();
    const isInteractive = INTERACTIVE_TOOLS.has(toolName);

    // The two interactive tools carry their own payload and deserve their own
    // UI. Sending them through the generic Allow/Deny banner is why the user
    // could approve a question without ever seeing it — the tool supplies no
    // `title`/`description`, so the banner rendered "Allow AskUserQuestion?"
    // with the actual question nowhere on screen.
    const questions = toolName === 'AskUserQuestion' ? readQuestions(toolInput) : [];
    const planText = toolName === 'ExitPlanMode'
      ? (typeof readRecord(toolInput)?.plan === 'string' ? String(readRecord(toolInput)?.plan) : null)
      : null;

    const promptKind = questions.length > 0
      ? 'question_request'
      : planText !== null ? 'plan_request' : 'permission_request';

    const decision = await new Promise<PermissionDecision>((resolve) => {
      const timer = isInteractive
        ? null
        : setTimeout(() => {
          parkedPermissions.delete(requestId);
          runRegistry.removePendingPermission(sessionId, requestId);
          resolve({ allow: false, message: 'Permission request timed out.' });
        }, PERMISSION_TIMEOUT_MS);

      parkedPermissions.set(requestId, { resolve, timer, sessionId });

      runRegistry.addPendingPermission(sessionId, {
        requestId,
        sessionId,
        toolName,
        input: toolInput,
        title: context.title,
        description: context.description,
        receivedAt: new Date().toISOString(),
      });

      runRegistry.record(sessionId, createMessage(promptKind, sessionId, {
        requestId,
        toolName,
        toolInput,
        permissionTitle: context.title,
        permissionDescription: context.description,
        ...(questions.length > 0 ? { questions } : {}),
        ...(planText !== null ? { plan: planText } : {}),
      }));

      // The SDK aborts the request if the run is cancelled underneath us.
      context.signal.addEventListener('abort', () => {
        if (timer) clearTimeout(timer);
        parkedPermissions.delete(requestId);
        runRegistry.removePendingPermission(sessionId, requestId);
        runRegistry.record(sessionId, createMessage('permission_cancelled', sessionId, { requestId }));
        resolve({ allow: false, message: 'Cancelled.' });
      }, { once: true });
    });

    if (decision.allow && decision.remember) {
      const set = rememberedTools.get(sessionId) ?? new Set<string>();
      set.add(toolName);
      rememberedTools.set(sessionId, set);
    }

    if (!decision.allow) {
      // A denial on ExitPlanMode is not a refusal, it is "keep planning" — the
      // message is delivered to the model verbatim as feedback.
      return {
        behavior: 'deny',
        message: decision.message ?? 'Denied by the user.',
      } satisfies PermissionResult;
    }

    // The answer to a question travels back inside `updatedInput`, keyed by
    // the question's exact text. Returning the input unmodified is what makes
    // the tool report that the user did not answer.
    const answers = resolveQuestionAnswers(decision, questions);

    if (Object.keys(answers).length > 0) {
      return {
        behavior: 'allow',
        updatedInput: {
          ...(readRecord(toolInput) ?? {}),
          answers,
          ...(decision.response ? { response: decision.response } : {}),
        },
      } satisfies PermissionResult;
    }

    // Approving a plan has to leave plan mode as well, or every edit the plan
    // describes is immediately blocked by the mode that produced it.
    if (decision.planMode) {
      // The session really is in a different mode from here on, so the
      // tracked mode has to move with it or the composer would keep offering
      // "Plan first" for a conversation that left plan mode minutes ago.
      sessionPermissionModes.set(sessionId, decision.planMode);
      return {
        behavior: 'allow',
        updatedInput: toolInput,
        updatedPermissions: [{
          type: 'setMode',
          mode: decision.planMode,
          destination: 'session',
        }],
      } satisfies PermissionResult;
    }

    return { behavior: 'allow', updatedInput: toolInput } satisfies PermissionResult;
  };
}
