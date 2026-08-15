import { query, type CanUseTool, type Options, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';

import { sessionsRepository } from '@/db/sessions.repository.js';
import { normalizeSdkMessage } from '@/modules/chat/normalize.js';
import { runRegistry } from '@/modules/chat/run-registry.js';
import type { NormalizedMessage, PermissionDecision } from '@/shared/types.js';
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

type RunChatTurnInput = {
  sessionId: string;
  prompt: string;
  cwd: string;
};

/**
 * Runs one conversational turn against Claude Code.
 *
 * Every event the SDK yields is normalized and pushed through the run
 * registry, which owns sequencing and replay. This function owns exactly two
 * things the registry cannot: translating SDK events, and guaranteeing that
 * the run terminates with a `complete` no matter how it ends.
 */
export async function runChatTurn(input: RunChatTurnInput): Promise<void> {
  const { sessionId, prompt, cwd } = input;

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

  // Echo the user's own message into the sequenced stream so a reconnecting
  // client replays the full exchange, not just the reply.
  send(createMessage('text', sessionId, { role: 'user', content: prompt }));

  try {
    const options: Options = {
      cwd,
      abortController,
      // Spreading rather than assigning: `options.env` REPLACES process.env in
      // the SDK rather than merging into it, so a bare object would strip PATH
      // and the subprocess would fail to spawn.
      env: { ...process.env } as Record<string, string>,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      tools: { type: 'preset', preset: 'claude_code' },
      // 'project' is required for CLAUDE.md files to load.
      settingSources: ['user', 'project', 'local'],
      // Token-level streaming; without it the UI renders a message at a time.
      includePartialMessages: true,
      canUseTool: createPermissionGate(sessionId),
      ...(session.providerSessionId ? { resume: session.providerSessionId } : {}),
      ...(process.env.TAILS_CLAUDE_PATH
        ? { pathToClaudeCodeExecutable: process.env.TAILS_CLAUDE_PATH }
        : {}),
    };

    const instance = query({ prompt, options });

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

      runRegistry.record(sessionId, createMessage('permission_request', sessionId, {
        requestId,
        toolName,
        toolInput,
        permissionTitle: context.title,
        permissionDescription: context.description,
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

    return decision.allow
      ? ({ behavior: 'allow', updatedInput: toolInput } satisfies PermissionResult)
      : ({ behavior: 'deny', message: decision.message ?? 'Denied by the user.' } satisfies PermissionResult);
  };
}
