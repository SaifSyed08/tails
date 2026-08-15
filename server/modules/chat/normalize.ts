import type { NormalizedMessage } from '@/shared/types.js';
import { createMessage, readRecord } from '@/shared/utils.js';

/**
 * Turns one SDK event into zero or more client events.
 *
 * The same function serves live streaming and replayed history, which is the
 * only way the two can be guaranteed to render identically. It returns an
 * array because a single assistant message routinely contains several content
 * blocks — text plus two tool calls is one SDK event and three chat rows.
 *
 * Unknown event types return an empty array rather than throwing: the SDK adds
 * message kinds regularly, and an unrecognised one should be invisible, not
 * fatal.
 */
export function normalizeSdkMessage(raw: unknown, sessionId: string): NormalizedMessage[] {
  const event = readRecord(raw);
  if (!event) return [];

  switch (event.type) {
    case 'assistant':
      return normalizeAssistant(event, sessionId);
    case 'user':
      return normalizeUser(event, sessionId);
    case 'stream_event':
      return normalizeStreamEvent(event, sessionId);
    case 'system':
      return normalizeSystem(event, sessionId);
    case 'result':
      return normalizeResult(event, sessionId);
    default:
      return [];
  }
}

/** Reads the `content` array off an SDK message envelope. */
const readContentBlocks = (event: Record<string, unknown>): Record<string, unknown>[] => {
  const message = readRecord(event.message);
  const content = message?.content;
  if (typeof content === 'string') {
    return content.trim() ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  return content.map(readRecord).filter((block): block is Record<string, unknown> => block !== null);
};

function normalizeAssistant(event: Record<string, unknown>, sessionId: string): NormalizedMessage[] {
  // A subagent's output carries the parent tool id. Surfacing it lets the UI
  // nest subagent activity under the Task call that spawned it.
  const parentToolUseId = typeof event.parent_tool_use_id === 'string'
    ? event.parent_tool_use_id
    : undefined;

  return readContentBlocks(event).flatMap((block): NormalizedMessage[] => {
    switch (block.type) {
      case 'text': {
        const text = typeof block.text === 'string' ? block.text : '';
        if (!text.trim()) return [];
        return [createMessage('text', sessionId, {
          role: 'assistant',
          content: text,
          toolId: parentToolUseId,
        })];
      }
      case 'thinking': {
        const thinking = typeof block.thinking === 'string' ? block.thinking : '';
        // Thinking blocks arrive with empty text unless `display: 'summarized'`
        // is requested; an empty one carries no information to render.
        if (!thinking.trim()) return [];
        return [createMessage('thinking', sessionId, { role: 'assistant', content: thinking })];
      }
      case 'tool_use':
        return [createMessage('tool_use', sessionId, {
          role: 'assistant',
          toolName: typeof block.name === 'string' ? block.name : 'unknown',
          toolInput: block.input,
          toolId: typeof block.id === 'string' ? block.id : undefined,
        })];
      default:
        return [];
    }
  });
}

function normalizeUser(event: Record<string, unknown>, sessionId: string): NormalizedMessage[] {
  return readContentBlocks(event).flatMap((block): NormalizedMessage[] => {
    if (block.type === 'tool_result') {
      return [createMessage('tool_result', sessionId, {
        toolId: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
        toolResult: {
          content: readToolResultText(block.content),
          isError: block.is_error === true,
        },
      })];
    }
    if (block.type === 'text') {
      const text = typeof block.text === 'string' ? block.text : '';
      if (!text.trim()) return [];
      return [createMessage('text', sessionId, { role: 'user', content: text })];
    }
    return [];
  });
}

/**
 * Flattens a tool result's content into displayable text.
 *
 * Tool results are either a bare string or an array of blocks; images and
 * other non-text blocks are summarised rather than dropped silently, so a
 * screenshot-returning tool doesn't look like it returned nothing.
 */
function readToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((entry) => {
      const block = readRecord(entry);
      if (!block) return '';
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      if (block.type === 'image') return '[image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Handles token-level streaming events.
 *
 * Only text deltas are surfaced. Tool-input deltas are deliberately ignored:
 * a half-built JSON argument object is not renderable, and the complete
 * `tool_use` block arrives moments later anyway.
 */
function normalizeStreamEvent(event: Record<string, unknown>, sessionId: string): NormalizedMessage[] {
  const inner = readRecord(event.event);
  if (!inner) return [];

  if (inner.type === 'content_block_delta') {
    const delta = readRecord(inner.delta);
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      return [createMessage('stream_delta', sessionId, { content: delta.text })];
    }
    return [];
  }

  if (inner.type === 'content_block_stop') {
    return [createMessage('stream_end', sessionId)];
  }

  return [];
}

function normalizeSystem(event: Record<string, unknown>, sessionId: string): NormalizedMessage[] {
  if (event.subtype === 'compact_boundary') {
    const metadata = readRecord(event.compact_metadata);
    const trigger = metadata?.trigger === 'manual' ? 'manually' : 'automatically';
    return [createMessage('status', sessionId, {
      statusCode: 'context_compacted',
      content: `Context ${trigger} compacted.`,
    })];
  }

  if (event.subtype === 'permission_denied') {
    // An auto-denial never reaches `canUseTool`, so without surfacing it here
    // the tool call would simply vanish from the UI.
    const toolName = typeof event.tool_name === 'string' ? event.tool_name : 'A tool';
    const reason = typeof event.message === 'string' ? event.message : 'Permission denied.';
    return [createMessage('error', sessionId, {
      errorCode: 'permission_denied',
      content: `${toolName} was denied: ${reason}`,
    })];
  }

  return [];
}

function normalizeResult(event: Record<string, unknown>, sessionId: string): NormalizedMessage[] {
  // The registry emits the authoritative `complete`, so a result only needs to
  // contribute an error row when the run actually failed.
  if (event.subtype === 'success') return [];

  const detail = typeof event.result === 'string' && event.result.trim()
    ? event.result
    : `Run ended: ${String(event.subtype ?? 'unknown')}`;

  return [createMessage('error', sessionId, {
    errorCode: typeof event.subtype === 'string' ? event.subtype : 'run_failed',
    content: detail,
  })];
}
