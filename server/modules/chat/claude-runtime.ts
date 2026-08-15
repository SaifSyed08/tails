import { query, type CanUseTool, type Options, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';

import { sessionsRepository } from '@/db/sessions.repository.js';
import { APPEARANCE_ALLOWED_TOOLS, appearanceMcpServer } from '@/modules/appearance/appearance.tools.js';
import { expandLocalCommand } from '@/modules/chat/commands.service.js';
import { normalizeSdkMessage } from '@/modules/chat/normalize.js';
import { runRegistry } from '@/modules/chat/run-registry.js';
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

type RunChatTurnInput = {
  sessionId: string;
  prompt: string;
  cwd: string;
  permissionMode?: SelectablePermissionMode;
  attachments?: ChatAttachment[];
};

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

  const blocks: Record<string, unknown>[] = [];

  for (const attachment of attachments) {
    if (SUPPORTED_IMAGE_TYPES.has(attachment.mediaType)) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: attachment.mediaType, data: attachment.data },
      });
      continue;
    }

    // Anything else is inlined as labelled text. Silently dropping a file the
    // user visibly attached is worse than showing the model its contents.
    const decoded = Buffer.from(attachment.data, 'base64').toString('utf8');
    blocks.push({
      type: 'text',
      text: `Attached file ${attachment.name}:\n\n${decoded.slice(0, 200_000)}`,
    });
  }

  blocks.push({ type: 'text', text });

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

  // Echo what the user actually typed, not the expanded form — seeing
  // `/personalize` turn into a paragraph of instructions in your own
  // transcript is disorienting.
  send(createMessage('text', sessionId, { role: 'user', content: prompt }));
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
        // The agent has to be told this capability exists, and told to reach
        // for the reference presets before inventing a look from nothing.
        append: [
          'You can restyle the T.A.I.L.S. interface you are running inside.',
          'When the user asks for a different look or mood, call mcp__tails-appearance__theme_list first to see the reference presets, then mcp__tails-appearance__theme_preview to show your design, then mcp__tails-appearance__theme_apply once they are happy.',
          `The current conversation id is ${sessionId}; pass it as sessionId and prefer scope "conversation" unless the user explicitly asks to change their default.`,
        ].join(' '),
      },
      tools: { type: 'preset', preset: 'claude_code' },
      // 'project' is required for CLAUDE.md files to load.
      settingSources: ['user', 'project', 'local'],
      // Token-level streaming; without it the UI renders a message at a time.
      includePartialMessages: true,
      // In-process, so the handlers reach the theme service directly instead of
      // authenticating back into our own HTTP API.
      mcpServers: { 'tails-appearance': appearanceMcpServer },
      // Listing and previewing a look are reversible and visible, so they run
      // unprompted. `theme_apply` is deliberately not here: changing the app's
      // permanent appearance should be the user's call, so it falls through to
      // the permission gate.
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
      }

      for (const normalized of normalizeSdkMessage(message, sessionId)) {
        send(normalized);
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
    // The one guaranteed terminal event. Without this in a `finally`, any
    // throw above leaves the client's spinner running forever.
    send(createCompleteMessage(sessionId, exitCode));
    sessionsRepository.touchSession(sessionId);

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
    if (decision.answers && Object.keys(decision.answers).length > 0) {
      return {
        behavior: 'allow',
        updatedInput: {
          ...(readRecord(toolInput) ?? {}),
          answers: decision.answers,
          ...(decision.response ? { response: decision.response } : {}),
        },
      } satisfies PermissionResult;
    }

    // Approving a plan has to leave plan mode as well, or every edit the plan
    // describes is immediately blocked by the mode that produced it.
    if (decision.planMode) {
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
