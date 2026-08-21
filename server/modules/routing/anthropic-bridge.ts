/**
 * Speaking Anthropic's Messages API on behalf of a local model.
 *
 * ## Why a translator and not a setting
 *
 * Claude Code is not a library that takes a model function — it is a program
 * that talks to an Anthropic-shaped HTTP endpoint. The one thing it *will*
 * accept is a different address for that endpoint (`ANTHROPIC_BASE_URL`). So
 * pointing it at a local model means standing something at that address which
 * answers `POST /v1/messages` in Anthropic's shape, and forwarding the substance
 * to whatever the user is actually running.
 *
 * The far side is OpenAI's chat-completions shape, because that is what every
 * local runner already speaks: Ollama, llama.cpp's server, LM Studio, vLLM. So
 * this file is a pair of pure translations —
 *
 *     Anthropic request  ->  OpenAI request
 *     OpenAI SSE stream  ->  Anthropic SSE events
 *
 * — kept pure, and kept here, because they are the part worth testing. Nothing
 * in this file opens a socket.
 *
 * ## What does not survive the trip
 *
 * Named honestly, because the interesting failures are all in this list:
 *
 * - **Prompt caching.** `cache_control` has no counterpart. Dropped, which
 *   costs nothing locally: there is no token bill and no cache to miss.
 * - **Thinking blocks.** A local model has no separate reasoning channel, so
 *   there is no `thinking` content to emit. Requests asking for it are answered
 *   without it rather than refused.
 * - **Images.** Passed through in OpenAI's `image_url` form. A text-only model
 *   will reject them, and that rejection is the model's to report.
 * - **Exact token counts.** `count_tokens` is an estimate; see that function.
 *
 * The one thing that has to survive perfectly is **tool calling**, because
 * Claude Code *is* tool calling. A dropped `tool_use` id is a turn that hangs.
 */

/* ---------------------------------------------------------------- request --- */

type AnthropicTextBlock = { type: 'text'; text: string };
type AnthropicImageBlock = {
  type: 'image';
  source?: { type?: string; media_type?: string; data?: string; url?: string };
};
type AnthropicToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input?: unknown;
};
type AnthropicToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
};
type AnthropicBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | { type: string; [key: string]: unknown };

export type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[];
};

export type AnthropicRequest = {
  model?: string;
  system?: string | AnthropicBlock[];
  messages?: AnthropicMessage[];
  tools?: { name: string; description?: string; input_schema?: unknown }[];
  tool_choice?: { type: string; name?: string };
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
};

type OpenAiMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | { type: string; text?: string; image_url?: { url: string } }[] | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

export type OpenAiRequest = {
  model: string;
  messages: OpenAiMessage[];
  tools?: { type: 'function'; function: { name: string; description?: string; parameters: unknown } }[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  stream: boolean;
};

const asBlocks = (content: string | AnthropicBlock[] | undefined): AnthropicBlock[] => {
  if (!content) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content;
};

/** Text from a block list, joined. Non-text blocks contribute nothing. */
function plainText(content: string | AnthropicBlock[] | undefined): string {
  if (typeof content === 'string') return content;
  return asBlocks(content)
    .filter((block): block is AnthropicTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * A tool result's payload as a string.
 *
 * Anthropic allows the content to be a string, a block list, or a bare object.
 * The far side takes one string, and a tool result that arrives as
 * `"[object Object]"` is a turn the model cannot reason about — so an object is
 * serialised as JSON rather than coerced.
 */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const block = part as AnthropicBlock;
        if (block?.type === 'text') return (block as AnthropicTextBlock).text;
        return JSON.stringify(part);
      })
      .join('\n');
  }
  if (content === undefined || content === null) return '';
  return JSON.stringify(content);
}

/**
 * An image block in OpenAI's shape.
 *
 * Anthropic sends base64 with a media type; OpenAI takes a data URL. A block
 * with neither is dropped rather than sent as a broken URL, because a malformed
 * image is a hard 400 from most runners and takes the whole turn with it.
 */
function imagePart(block: AnthropicImageBlock): { type: string; image_url: { url: string } } | null {
  const source = block.source ?? {};
  if (source.type === 'url' && source.url) return { type: 'image_url', image_url: { url: source.url } };
  if (source.data && source.media_type) {
    return { type: 'image_url', image_url: { url: `data:${source.media_type};base64,${source.data}` } };
  }
  return null;
}

/**
 * Anthropic's request, as the far side wants it.
 *
 * The message-by-message shape changes more than it looks. Anthropic puts a
 * tool's *result* in a user turn; OpenAI has a `tool` role for it, keyed by the
 * call id. And one Anthropic user turn holding three tool results becomes three
 * OpenAI messages — so this is a flat-map, not a map, and the ids are what hold
 * it together.
 */
export function toOpenAiRequest(request: AnthropicRequest, model: string): OpenAiRequest {
  const messages: OpenAiMessage[] = [];

  const system = plainText(request.system).trim();
  if (system) messages.push({ role: 'system', content: system });

  for (const message of request.messages ?? []) {
    const blocks = asBlocks(message.content);

    if (message.role === 'assistant') {
      const text = blocks
        .filter((block): block is AnthropicTextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');
      const calls = blocks
        .filter((block): block is AnthropicToolUseBlock => block.type === 'tool_use')
        .map((block) => ({
          id: block.id,
          type: 'function' as const,
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        }));

      // An assistant turn with neither is a turn with nothing in it, and some
      // runners reject an empty message outright.
      if (!text && calls.length === 0) continue;

      messages.push({
        role: 'assistant',
        content: text || null,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
      continue;
    }

    /*
      A user turn splits.

      Tool results become their own `tool` messages — one each, in order, so the
      ids line up with the calls that produced them — and anything else stays as
      the user's own words. Emitting the results *before* the remaining content
      matters: a runner that sees a user message between a call and its result
      has been handed a conversation that does not typecheck.
    */
    const results = blocks.filter(
      (block): block is AnthropicToolResultBlock => block.type === 'tool_result',
    );
    for (const result of results) {
      messages.push({
        role: 'tool',
        tool_call_id: result.tool_use_id,
        content: toolResultText(result.content),
      });
    }

    const rest = blocks.filter((block) => block.type !== 'tool_result');
    if (rest.length === 0) continue;

    const hasImage = rest.some((block) => block.type === 'image');
    if (!hasImage) {
      const text = rest
        .filter((block): block is AnthropicTextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      if (text) messages.push({ role: 'user', content: text });
      continue;
    }

    type ContentPart = { type: string; text?: string; image_url?: { url: string } };
    const parts = rest.flatMap<ContentPart>((block) => {
      if (block.type === 'text') return [{ type: 'text', text: (block as AnthropicTextBlock).text }];
      if (block.type === 'image') {
        const part = imagePart(block as AnthropicImageBlock);
        return part ? [part] : [];
      }
      return [];
    });
    if (parts.length > 0) messages.push({ role: 'user', content: parts });
  }

  const tools = (request.tools ?? []).map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      // Every runner expects *a* schema. An absent one becomes the empty object
      // schema rather than `undefined`, which several reject.
      parameters: tool.input_schema ?? { type: 'object', properties: {} },
    },
  }));

  return {
    model,
    messages,
    ...(tools.length > 0 ? { tools } : {}),
    ...(request.tool_choice ? { tool_choice: toolChoice(request.tool_choice) } : {}),
    ...(request.max_tokens ? { max_tokens: request.max_tokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.top_p !== undefined ? { top_p: request.top_p } : {}),
    ...(request.stop_sequences?.length ? { stop: request.stop_sequences } : {}),
    stream: request.stream !== false,
  };
}

function toolChoice(choice: { type: string; name?: string }): OpenAiRequest['tool_choice'] {
  if (choice.type === 'tool' && choice.name) {
    return { type: 'function', function: { name: choice.name } };
  }
  if (choice.type === 'any') return 'required';
  if (choice.type === 'none') return 'none';
  return 'auto';
}

/* --------------------------------------------------------------- response --- */

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';

/**
 * Why the model stopped, in Anthropic's vocabulary.
 *
 * `tool_calls -> tool_use` is the one that has to be right. Claude Code decides
 * whether to run tools and continue, or to end the turn, from this field alone;
 * reporting `end_turn` on a turn that asked for a tool call strands the call and
 * the conversation simply stops.
 */
export function toStopReason(finish: string | null | undefined): StopReason {
  switch (finish) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'stop':
    default:
      return 'end_turn';
  }
}

export type SseEvent = { event: string; data: unknown };

/** One SSE frame in the wire format the Anthropic client expects. */
export const encodeSse = ({ event, data }: SseEvent): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

type ToolAccumulator = { index: number; id: string; name: string; started: boolean };

/**
 * Turns a stream of OpenAI chunks into a stream of Anthropic events.
 *
 * ## Why this is a class and not a map
 *
 * The two protocols disagree about *blocks*. OpenAI streams a flat delta —
 * some text, then some arguments — and leaves the structure implicit. Anthropic
 * streams an explicit tree: every run of text or tool arguments is a numbered
 * content block that must be opened with `content_block_start`, filled with
 * deltas, and closed with `content_block_stop`, in order, without overlapping.
 *
 * So something has to remember which block is open. Getting it wrong does not
 * degrade the output, it breaks the client's parser: an unclosed block, or a
 * delta for an index that was never started, and the turn ends in an error the
 * user sees as the model having failed.
 *
 * Fed one chunk at a time and asked for the events that chunk produced. No I/O,
 * so the whole protocol can be tested by handing it a recorded stream.
 */
export class AnthropicStreamAssembler {
  private nextIndex = 0;
  private textOpen = false;
  private textIndex = 0;
  private tools = new Map<number, ToolAccumulator>();
  private stop: StopReason = 'end_turn';
  private started = false;
  private usage = { input_tokens: 0, output_tokens: 0 };

  constructor(private readonly messageId: string, private readonly model: string) {}

  /** The opening events, sent before anything from the model. */
  start(): SseEvent[] {
    this.started = true;
    return [
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: this.messageId,
            type: 'message',
            role: 'assistant',
            model: this.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
      },
    ];
  }

  /** Events produced by one OpenAI chunk. */
  push(chunk: unknown): SseEvent[] {
    const events: SseEvent[] = [];
    const choice = (chunk as { choices?: { delta?: Record<string, unknown>; finish_reason?: string }[] })
      ?.choices?.[0];
    const usage = (chunk as { usage?: { prompt_tokens?: number; completion_tokens?: number } })?.usage;
    if (usage) {
      this.usage = {
        input_tokens: usage.prompt_tokens ?? this.usage.input_tokens,
        output_tokens: usage.completion_tokens ?? this.usage.output_tokens,
      };
    }
    if (!choice) return events;

    const delta = choice.delta ?? {};

    /*
      Some runners put the whole reasoning trace in `reasoning_content`. It is
      not a text block — emitting it as one would print the model's scratch work
      into the reply — and there is no Anthropic block it maps to, so it is
      dropped. Named here so the next person does not assume it was missed.
    */

    const text = typeof delta.content === 'string' ? delta.content : '';
    if (text) {
      if (!this.textOpen) {
        this.textIndex = this.nextIndex;
        this.nextIndex += 1;
        this.textOpen = true;
        events.push({
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: this.textIndex,
            content_block: { type: 'text', text: '' },
          },
        });
      }
      events.push({
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: this.textIndex,
          delta: { type: 'text_delta', text },
        },
      });
    }

    const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const raw of calls) {
      const call = raw as {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      };
      const slot = call.index ?? 0;

      let tool = this.tools.get(slot);
      if (!tool) {
        /*
          A tool call arrives across several chunks: the first carries the id and
          name, later ones carry fragments of the arguments. So the block can
          only be opened once the name is known — and text already open has to be
          closed first, because Anthropic blocks do not overlap.
        */
        if (!call.function?.name) continue;

        if (this.textOpen) {
          events.push({
            event: 'content_block_stop',
            data: { type: 'content_block_stop', index: this.textIndex },
          });
          this.textOpen = false;
        }

        tool = {
          index: this.nextIndex,
          // Synthesised when the runner omits one. The id is what pairs the
          // result back to the call, so an empty string is a hung turn.
          id: call.id || `toolu_local_${this.messageId}_${slot}`,
          name: call.function.name,
          started: true,
        };
        this.nextIndex += 1;
        this.tools.set(slot, tool);

        events.push({
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: tool.index,
            content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} },
          },
        });
      }

      const fragment = call.function?.arguments;
      if (fragment) {
        events.push({
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: tool.index,
            // The JSON arrives as text, a piece at a time, and is never parsed
            // here. Handing the client a partial object would be worse than
            // handing it partial text, which is what this delta type is for.
            delta: { type: 'input_json_delta', partial_json: fragment },
          },
        });
      }
    }

    if (choice.finish_reason) this.stop = toStopReason(choice.finish_reason);
    return events;
  }

  /**
   * The closing events.
   *
   * Every open block is closed here, in index order, whatever the stream did.
   * A runner that drops its connection mid-arguments is common enough that
   * relying on it to finish tidily would leave the client waiting for a block
   * that never closes.
   */
  end(): SseEvent[] {
    const events: SseEvent[] = [];
    if (!this.started) events.push(...this.start());

    const open: number[] = [];
    if (this.textOpen) open.push(this.textIndex);
    for (const tool of this.tools.values()) if (tool.started) open.push(tool.index);
    open.sort((a, b) => a - b);

    for (const index of open) {
      events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
    }
    this.textOpen = false;
    this.tools.clear();

    events.push({
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: this.stop, stop_sequence: null },
        usage: { output_tokens: this.usage.output_tokens },
      },
    });
    events.push({ event: 'message_stop', data: { type: 'message_stop' } });
    return events;
  }
}

/**
 * A rough token count.
 *
 * Claude Code asks for this to track how full the context is. There is no way
 * to answer it exactly for an arbitrary local model — the tokeniser belongs to
 * the model and is not exposed over the OpenAI API — so this is the usual four
 * characters per token, which is close enough for a progress indicator and is
 * labelled an estimate everywhere it surfaces.
 *
 * Deliberately *over*-counts slightly rather than under: the consequence of
 * guessing low is a request that overflows the context and fails, and the
 * consequence of guessing high is compacting a little early.
 */
export function estimateTokens(request: AnthropicRequest): number {
  let characters = plainText(request.system).length;

  for (const message of request.messages ?? []) {
    for (const block of asBlocks(message.content)) {
      if (block.type === 'text') characters += (block as AnthropicTextBlock).text.length;
      else if (block.type === 'tool_use') characters += JSON.stringify(block).length;
      else if (block.type === 'tool_result') {
        characters += toolResultText((block as AnthropicToolResultBlock).content).length;
      } else if (block.type === 'image') {
        // A tile's worth, rather than the base64 length, which would read as
        // hundreds of thousands of tokens for one screenshot.
        characters += 4000;
      }
    }
  }

  for (const tool of request.tools ?? []) {
    characters += tool.name.length + (tool.description?.length ?? 0);
    characters += JSON.stringify(tool.input_schema ?? {}).length;
  }

  return Math.ceil(characters / 4) + 16;
}
