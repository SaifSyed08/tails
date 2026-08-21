import { randomUUID } from 'node:crypto';

import type { MessageKind, NormalizedMessage } from '@/shared/types.js';

/**
 * An error carrying an HTTP status and a stable machine-readable code.
 *
 * Routes translate this into a response; everything else throws it and lets
 * the transport layer decide how to present it.
 */
export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(message: string, options: { code: string; statusCode?: number; details?: unknown }) {
    super(message);
    this.name = 'AppError';
    this.code = options.code;
    this.statusCode = options.statusCode ?? 400;
    this.details = options.details;
  }
}

/** Generates a unique event id. Prefixed so ids are readable in logs. */
export function generateMessageId(prefix = 'msg'): string {
  return `${prefix}_${randomUUID()}`;
}

/**
 * Builds a normalized event with the fields every event needs.
 *
 * Centralised so `id` and `timestamp` can never be forgotten — a message
 * missing either breaks client-side ordering and React keying in ways that
 * only show up under load.
 */
export function createMessage(
  kind: MessageKind,
  sessionId: string,
  fields: Partial<NormalizedMessage> = {},
): NormalizedMessage {
  return {
    id: generateMessageId(kind),
    sessionId,
    timestamp: new Date().toISOString(),
    kind,
    ...fields,
  };
}

/**
 * Builds the single terminal event of a run.
 *
 * Exactly one `complete` must reach the client per run. The registry enforces
 * uniqueness; this just guarantees the shape.
 */
export function createCompleteMessage(
  sessionId: string,
  exitCode: number,
  durationMs?: number,
): NormalizedMessage {
  return createMessage('complete', sessionId, {
    exitCode,
    ...(durationMs === undefined ? {} : { durationMs }),
  });
}

/** Narrows unknown JSON to a plain object, or null. */
export function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Reads a trimmed non-empty string, or null. */
export function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
