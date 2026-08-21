import express from 'express';

import {
  AnthropicStreamAssembler,
  encodeSse,
  estimateTokens,
  toOpenAiRequest,
  toStopReason,
  type AnthropicRequest,
} from '@/modules/routing/anthropic-bridge.js';
import {
  discoverRunners,
  probeRunner,
  readRouting,
  readRoutingStatus,
  writeRouting,
} from '@/modules/routing/local-model.js';
import { AppError } from '@/shared/utils.js';

/**
 * The address Claude Code is pointed at when it is running on a local model.
 *
 * ## Shape
 *
 *     Claude Code CLI  ->  POST /api/routing/v1/messages   (this file)
 *                      ->  POST {runner}/chat/completions  (Ollama, llama.cpp…)
 *
 * Claude Code takes one instruction about where to send its requests, and that
 * is `ANTHROPIC_BASE_URL`. So this is what that variable points at: an
 * Anthropic-shaped endpoint that translates and forwards. The translation lives
 * in `anthropic-bridge.ts` and is pure; everything here is plumbing.
 *
 * ## Localhost only, and why that is enough
 *
 * The whole server binds `127.0.0.1`, so this endpoint is not reachable from
 * another machine and there is nothing here to authenticate. It reads no
 * credentials of its own: the bearer token the CLI sends is a placeholder this
 * app generated, and is ignored. What *is* forwarded is the runner's own key,
 * from the routing settings, and only to the runner's address.
 *
 * ## Three endpoints, because the CLI uses three
 *
 * `/v1/messages` is the conversation. `/v1/messages/count_tokens` is how it
 * tracks a filling context — answered with an estimate, since the tokeniser
 * belongs to the model and is not exposed. `/v1/models` it may consult to check
 * a name resolves; answering with the configured model keeps that from failing.
 */

/** How long a local generation may take before the request is abandoned. */
const GENERATION_TIMEOUT_MS = 10 * 60_000;

function runnerHeaders(): Record<string, string> {
  const settings = readRouting();
  return {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}),
  };
}

/**
 * Reads an SSE body and yields each `data:` payload, parsed.
 *
 * Written by hand rather than with a library because the framing is three lines
 * of rules and the failure mode of getting it wrong is specific: a chunk
 * boundary that lands mid-line. Hence the carry-over buffer — without it, a
 * message split across two network reads is dropped, which shows up as
 * occasional missing words rather than as an error.
 */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffered += decoder.decode(value, { stream: true });

    // Events are separated by a blank line; a trailing partial event stays in
    // the buffer until the rest of it arrives.
    const parts = buffered.split(/\r?\n\r?\n/);
    buffered = parts.pop() ?? '';

    for (const part of parts) {
      for (const line of part.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          yield JSON.parse(payload);
        } catch {
          // A runner that emits a malformed chunk should cost that chunk, not
          // the whole turn.
        }
      }
    }
  }
}

export function createRoutingRouter(): express.Router {
  const router = express.Router();

  /* ------------------------------------------------------------ settings --- */

  router.get('/status', (_req, res) => {
    res.json(readRoutingStatus());
  });

  /** What is running on this machine right now, and what each one holds. */
  router.get('/discover', async (_req, res, next) => {
    try {
      res.json({ runners: await discoverRunners() });
    } catch (error) {
      next(error);
    }
  });

  router.post('/settings', async (req, res, next) => {
    try {
      const body = req.body as Partial<{
        provider: string;
        baseUrl: string;
        model: string;
        apiKey: string;
      }>;

      const next_ = writeRouting({
        ...(body.provider === 'local' || body.provider === 'anthropic'
          ? { provider: body.provider }
          : {}),
        ...(typeof body.baseUrl === 'string' ? { baseUrl: body.baseUrl } : {}),
        ...(typeof body.model === 'string' ? { model: body.model } : {}),
        // An empty string clears it, which is the only way to remove a key.
        ...(typeof body.apiKey === 'string' ? { apiKey: body.apiKey } : {}),
      });

      /*
        Checked immediately, and reported.

        Saving a base URL that nothing is listening on is the single most likely
        mistake here, and the alternative to checking now is discovering it when
        the next message fails — several layers away, as a CLI error about a
        model name.
      */
      const probe = await probeRunner(
        { id: 'configured', label: 'Configured address', baseUrl: next_.baseUrl },
        next_.apiKey,
      );

      res.json({ ...readRoutingStatus(), probe });
    } catch (error) {
      next(error);
    }
  });

  /* ---------------------------------------------- what the CLI talks to --- */

  router.get('/v1/models', (_req, res) => {
    const settings = readRouting();
    res.json({
      object: 'list',
      data: settings.model
        ? [{ id: settings.model, object: 'model', owned_by: 'local' }]
        : [],
    });
  });

  router.post('/v1/messages/count_tokens', (req, res) => {
    // An estimate, and labelled as one wherever it surfaces. See the function.
    res.json({ input_tokens: estimateTokens(req.body as AnthropicRequest) });
  });

  router.post('/v1/messages', async (req, res, next) => {
    const settings = readRouting();
    if (!settings.model) {
      next(new AppError('No local model is selected in Settings.', {
        code: 'routing.noModel',
        statusCode: 400,
      }));
      return;
    }

    const request = req.body as AnthropicRequest;
    const wantsStream = request.stream !== false;
    const payload = toOpenAiRequest(request, settings.model);

    let upstream: Response;
    try {
      upstream = await fetch(`${settings.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: runnerHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      next(new AppError(
        timedOut
          ? 'The local model did not finish in ten minutes.'
          : `Could not reach the local model at ${settings.baseUrl}. Is the runner still running?`,
        { code: 'routing.unreachable', statusCode: 502 },
      ));
      return;
    }

    if (!upstream.ok) {
      /*
        Forwarded as the runner's own words.

        These messages are the useful ones — an unloaded model, a context
        overflow, a name that does not exist — and rewriting them into
        "something went wrong" would throw away the only diagnosis available.
      */
      const detail = await upstream.text().catch(() => '');
      next(new AppError(
        `The local model returned ${upstream.status}. ${detail.slice(0, 400)}`.trim(),
        { code: 'routing.upstream', statusCode: 502 },
      ));
      return;
    }

    /* ------------------------------------------------------ non-streaming --- */

    if (!wantsStream || !upstream.body) {
      const completion = await upstream.json() as {
        id?: string;
        choices?: {
          finish_reason?: string;
          message?: {
            content?: string;
            tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
          };
        }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const choice = completion.choices?.[0];
      const content: unknown[] = [];
      if (choice?.message?.content) content.push({ type: 'text', text: choice.message.content });

      for (const [index, call] of (choice?.message?.tool_calls ?? []).entries()) {
        let input: unknown = {};
        try {
          input = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          // A model that emits invalid JSON for its arguments has made a
          // mistake the client can see and report; an empty object at least
          // keeps the block well-formed.
          input = {};
        }
        content.push({
          type: 'tool_use',
          id: call.id || `toolu_local_${index}`,
          name: call.function?.name ?? 'unknown',
          input,
        });
      }

      res.json({
        id: completion.id ?? `msg_local_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: settings.model,
        content,
        stop_reason: toStopReason(choice?.finish_reason),
        stop_sequence: null,
        usage: {
          input_tokens: completion.usage?.prompt_tokens ?? 0,
          output_tokens: completion.usage?.completion_tokens ?? 0,
        },
      });
      return;
    }

    /* ---------------------------------------------------------- streaming --- */

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // Nothing between here and the CLI should hold a token back waiting for a
      // buffer to fill; the whole point of the stream is that it arrives.
      'x-accel-buffering': 'no',
    });

    const assembler = new AnthropicStreamAssembler(`msg_local_${Date.now()}`, settings.model);
    const write = (events: { event: string; data: unknown }[]) => {
      for (const event of events) res.write(encodeSse(event));
    };

    /*
      A client that goes away mid-generation.

      Without this the runner keeps generating into a socket nobody is reading —
      which on a local machine means the GPU stays busy for the rest of a reply
      the user has already abandoned.
    */
    const abort = new AbortController();
    req.on('close', () => abort.abort());

    try {
      write(assembler.start());
      for await (const chunk of readSse(upstream.body)) {
        if (abort.signal.aborted) break;
        write(assembler.push(chunk));
      }
      write(assembler.end());
    } catch {
      /*
        The stream broke partway.

        The blocks still have to be closed, or the client waits for an end that
        never comes — a spinner that never stops is a worse failure than an
        error. `end()` closes whatever is open whatever happened.
      */
      try { write(assembler.end()); } catch { /* socket already gone */ }
    } finally {
      res.end();
    }
  });

  return router;
}
