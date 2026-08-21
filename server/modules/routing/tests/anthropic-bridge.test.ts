import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AnthropicStreamAssembler,
  estimateTokens,
  toOpenAiRequest,
  toStopReason,
  type AnthropicRequest,
} from '@/modules/routing/anthropic-bridge.js';

/**
 * The translation is the whole feature, and tool calling is the whole
 * translation.
 *
 * Claude Code is a tool-calling loop. Text coming back slightly wrong is a
 * cosmetic problem; a `tool_use` id that does not match its `tool_result`, or a
 * `stop_reason` of `end_turn` on a turn that asked for a tool, is a conversation
 * that stops dead with no error. So most of what is checked here is structure
 * and identity rather than content.
 */

const chunk = (delta: unknown, finish?: string) => ({
  choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }],
});

describe('anthropic -> openai request', () => {
  it('puts the system prompt in a system message', () => {
    const out = toOpenAiRequest({ system: 'be brief', messages: [] }, 'local-model');
    assert.deepEqual(out.messages[0], { role: 'system', content: 'be brief' });
  });

  it('accepts a system prompt sent as blocks', () => {
    const out = toOpenAiRequest(
      { system: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }], messages: [] },
      'local-model',
    );
    assert.equal(out.messages[0]?.content, 'one\ntwo');
  });

  it('carries a tool call across as an OpenAI tool_call, keeping the id', () => {
    const out = toOpenAiRequest({
      messages: [{
        role: 'assistant',
        content: [
          { type: 'text', text: 'reading it' },
          { type: 'tool_use', id: 'toolu_abc', name: 'Read', input: { path: 'a.ts' } },
        ],
      }],
    }, 'local-model');

    const message = out.messages[0];
    assert.equal(message?.role, 'assistant');
    assert.equal(message?.content, 'reading it');
    assert.equal(message?.tool_calls?.[0]?.id, 'toolu_abc');
    assert.equal(message?.tool_calls?.[0]?.function.name, 'Read');
    // Arguments travel as a JSON *string* on that side, not an object.
    assert.equal(message?.tool_calls?.[0]?.function.arguments, '{"path":"a.ts"}');
  });

  /*
    The shape change that is easy to get wrong: Anthropic puts tool results in a
    *user* turn, OpenAI has a role of its own for them, and one user turn holding
    three results becomes three messages.
  */
  it('splits one user turn of tool results into one message each', () => {
    const out = toOpenAiRequest({
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'first' },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: 'second' },
          { type: 'text', text: 'and now this' },
        ],
      }],
    }, 'local-model');

    assert.deepEqual(out.messages.map((m) => m.role), ['tool', 'tool', 'user']);
    assert.equal(out.messages[0]?.tool_call_id, 'toolu_1');
    assert.equal(out.messages[1]?.tool_call_id, 'toolu_2');
    assert.equal(out.messages[2]?.content, 'and now this');
  });

  it('serialises a structured tool result rather than coercing it', () => {
    const out = toOpenAiRequest({
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't', content: { ok: true, files: 2 } }],
      }],
    }, 'local-model');

    // The failure being avoided is "[object Object]", which the model cannot
    // reason about and which looks like a successful call.
    assert.equal(out.messages[0]?.content, '{"ok":true,"files":2}');
  });

  it('gives every tool a parameter schema, because runners require one', () => {
    const out = toOpenAiRequest(
      { messages: [], tools: [{ name: 'Bash' }] },
      'local-model',
    );
    assert.deepEqual(out.tools?.[0]?.function.parameters, { type: 'object', properties: {} });
  });

  it('drops an assistant turn with neither text nor calls', () => {
    const out = toOpenAiRequest({
      messages: [{ role: 'assistant', content: [] }, { role: 'user', content: 'hi' }],
    }, 'local-model');
    assert.deepEqual(out.messages.map((m) => m.role), ['user']);
  });

  it('turns a base64 image into a data URL and drops a sourceless one', () => {
    const out = toOpenAiRequest({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'image' },
        ],
      }],
    }, 'local-model');

    const parts = out.messages[0]?.content as { type: string; image_url?: { url: string } }[];
    assert.equal(parts.length, 2);
    assert.equal(parts[1]?.image_url?.url, 'data:image/png;base64,AAAA');
  });

  it('maps tool_choice', () => {
    assert.equal(toOpenAiRequest({ messages: [], tool_choice: { type: 'auto' } }, 'm').tool_choice, 'auto');
    assert.equal(toOpenAiRequest({ messages: [], tool_choice: { type: 'any' } }, 'm').tool_choice, 'required');
    assert.deepEqual(
      toOpenAiRequest({ messages: [], tool_choice: { type: 'tool', name: 'Read' } }, 'm').tool_choice,
      { type: 'function', function: { name: 'Read' } },
    );
  });
});

describe('stop reason', () => {
  /*
    The single most consequential mapping in the file. Claude Code decides
    whether to run the tools and continue, or to end the turn, from this field
    alone — so reporting `end_turn` on a turn that asked for a tool strands the
    call and the conversation simply stops with no error.
  */
  it('reports a tool call as tool_use', () => {
    assert.equal(toStopReason('tool_calls'), 'tool_use');
    assert.equal(toStopReason('function_call'), 'tool_use');
  });

  it('maps the rest', () => {
    assert.equal(toStopReason('stop'), 'end_turn');
    assert.equal(toStopReason('length'), 'max_tokens');
    assert.equal(toStopReason(undefined), 'end_turn');
    assert.equal(toStopReason('something-new'), 'end_turn');
  });
});

describe('openai stream -> anthropic events', () => {
  const run = (chunks: unknown[]) => {
    const assembler = new AnthropicStreamAssembler('msg_1', 'local-model');
    const events = [...assembler.start()];
    for (const c of chunks) events.push(...assembler.push(c));
    events.push(...assembler.end());
    return events;
  };

  it('opens, fills and closes a text block', () => {
    const events = run([chunk({ content: 'Hel' }), chunk({ content: 'lo' })]);
    assert.deepEqual(events.map((e) => e.event), [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
  });

  it('does not open a text block for a chunk with no text', () => {
    const events = run([chunk({}), chunk({ role: 'assistant' })]);
    assert.equal(events.some((e) => e.event === 'content_block_start'), false);
  });

  /*
    Anthropic content blocks are a tree and must not overlap: a tool block
    opening while a text block is open has to close the text first. Getting this
    wrong does not degrade the output, it breaks the client's parser.
  */
  it('closes the open text block before starting a tool block', () => {
    const events = run([
      chunk({ content: 'let me look' }),
      chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: '{"p' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'ath":"a.ts"}' } }] }, 'tool_calls'),
    ]);

    const names = events.map((e) => e.event);
    const textStop = names.indexOf('content_block_stop');
    const toolStart = names.lastIndexOf('content_block_start');
    assert.ok(textStop < toolStart, 'the text block must close before the tool block opens');
  });

  it('streams tool arguments as input_json_delta, never parsed', () => {
    const events = run([
      chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: '{"p' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'ath":1}' } }] }, 'tool_calls'),
    ]);

    const deltas = events
      .filter((e) => e.event === 'content_block_delta')
      .map((e) => (e.data as { delta: { type: string; partial_json?: string } }).delta);

    assert.deepEqual(deltas.map((d) => d.type), ['input_json_delta', 'input_json_delta']);
    assert.equal(deltas.map((d) => d.partial_json).join(''), '{"path":1}');
  });

  it('numbers blocks in order and reports tool_use at the end', () => {
    const events = run([
      chunk({ content: 'hi' }),
      chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'A', arguments: '{}' } }] }),
      chunk({ tool_calls: [{ index: 1, id: 'c2', function: { name: 'B', arguments: '{}' } }] }, 'tool_calls'),
    ]);

    const starts = events
      .filter((e) => e.event === 'content_block_start')
      .map((e) => (e.data as { index: number }).index);
    assert.deepEqual(starts, [0, 1, 2]);

    const final = events.find((e) => e.event === 'message_delta');
    assert.equal((final?.data as { delta: { stop_reason: string } }).delta.stop_reason, 'tool_use');
  });

  it('invents an id when the runner omits one, so the result can be paired', () => {
    const events = run([
      chunk({ tool_calls: [{ index: 0, function: { name: 'Read', arguments: '{}' } }] }, 'tool_calls'),
    ]);
    const start = events.find((e) => e.event === 'content_block_start');
    const block = (start?.data as { content_block: { id: string } }).content_block;
    assert.ok(block.id.length > 0, 'an empty id is a turn that hangs');
  });

  /*
    A runner dropping its connection mid-arguments is common. If the assembler
    relied on the stream finishing tidily, the client would be left waiting for a
    block that never closes — a spinner that never stops.
  */
  it('closes every open block even when the stream just ends', () => {
    const assembler = new AnthropicStreamAssembler('msg_1', 'local-model');
    const seen = [...assembler.start()];
    seen.push(...assembler.push(chunk({ content: 'half a sen' })));
    // Cut off here: no finish_reason, and the arguments are incomplete JSON.
    seen.push(...assembler.push(
      chunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 'A', arguments: '{"x' } }] }),
    ));

    /*
      The text block is already closed by this point, and by the right thing:
      opening the tool block closed it, because Anthropic blocks cannot overlap.
      So what `end` has left to close is the tool block alone — and the property
      that matters is that across the whole stream every block that opened also
      closed, whatever order that happened in.
    */
    const closing = assembler.end().filter((e) => e.event === 'content_block_stop');
    assert.deepEqual(closing.map((e) => (e.data as { index: number }).index), [1]);

    const all = [...seen, ...closing];
    const opened = all.filter((e) => e.event === 'content_block_start').length;
    const closed = all.filter((e) => e.event === 'content_block_stop').length;
    assert.equal(opened, 2);
    assert.equal(closed, opened, 'a block left open is a client waiting forever');
  });

  it('emits a complete envelope even for a stream that produced nothing', () => {
    const assembler = new AnthropicStreamAssembler('msg_1', 'local-model');
    const events = assembler.end();
    assert.deepEqual(events.map((e) => e.event), ['message_start', 'message_delta', 'message_stop']);
  });
});

describe('token estimate', () => {
  it('counts the system prompt, the messages and the tool schemas', () => {
    const request: AnthropicRequest = {
      system: 'x'.repeat(400),
      messages: [{ role: 'user', content: 'y'.repeat(400) }],
      tools: [{ name: 'Read', description: 'z'.repeat(200), input_schema: { type: 'object' } }],
    };
    // Roughly a quarter of the characters, and above it rather than below —
    // guessing low overflows the context and fails the turn.
    assert.ok(estimateTokens(request) > 250);
  });

  it('does not count an image by its base64 length', () => {
    const huge = 'A'.repeat(200_000);
    const estimate = estimateTokens({
      messages: [{
        role: 'user',
        content: [{ type: 'image', source: { media_type: 'image/png', data: huge } }],
      }],
    });
    // The failure being avoided: one screenshot reading as 50,000 tokens and the
    // CLI deciding the context is full.
    assert.ok(estimate < 2000, `expected a tile-sized estimate, got ${estimate}`);
  });
});
