import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPromptBlocks } from '@/modules/chat/claude-runtime.js';
import { normalizeSdkMessage } from '@/modules/chat/normalize.js';

/** A 1×1 PNG, small enough to keep the expectations readable. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const readBlock = (blocks: Record<string, unknown>[], index: number) => blocks[index] as {
  type: string;
  text?: string;
  source?: { type: string; media_type: string; data: string };
};

test('an image attachment becomes a well-formed image block', () => {
  const blocks = buildPromptBlocks('What is this?', [
    { name: 'shot.png', mediaType: 'image/png', data: PNG_BASE64 },
  ]);

  assert.equal(blocks.length, 2);
  assert.deepEqual(readBlock(blocks, 0), {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 },
  });
  // The instruction comes last, after everything it refers to.
  assert.deepEqual(readBlock(blocks, 1), { type: 'text', text: 'What is this?' });
});

test('a data-URL prefix and a bogus jpeg type are both repaired', () => {
  const blocks = buildPromptBlocks('hi', [
    { name: 'photo.jpg', mediaType: 'IMAGE/JPG', data: `data:image/jpg;base64,${PNG_BASE64}` },
  ]);

  assert.deepEqual(readBlock(blocks, 0).source, {
    type: 'base64',
    media_type: 'image/jpeg',
    data: PNG_BASE64,
  });
});

test('a non-image attachment is inlined under a heading the transcript can read back', () => {
  const blocks = buildPromptBlocks('review this', [
    { name: 'notes.txt', mediaType: 'text/plain', data: Buffer.from('hello').toString('base64') },
  ]);

  assert.equal(readBlock(blocks, 0).text, '[Attached file: notes.txt]\n\nhello');
});

test('an attachment with no message produces no empty text block', () => {
  const blocks = buildPromptBlocks('', [
    { name: 'shot.png', mediaType: 'image/png', data: PNG_BASE64 },
  ]);

  assert.equal(blocks.length, 1);
  assert.equal(readBlock(blocks, 0).type, 'image');
});

test('a transcript user turn hands its attachments back to the chat view', () => {
  const messages = normalizeSdkMessage({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 } },
        { type: 'text', text: '[Attached file: notes.txt]\n\nhello' },
        { type: 'text', text: 'What is this?' },
      ],
    },
  }, 'session-1');

  assert.equal(messages.length, 1, 'the inlined file is a chip, not a second bubble');
  const [message] = messages;
  assert.equal(message.content, 'What is this?');
  assert.deepEqual(message.attachments, [
    { name: 'Image', mediaType: 'image/png', previewUrl: `data:image/png;base64,${PNG_BASE64}` },
    { name: 'notes.txt', mediaType: 'text/plain' },
  ]);
});

test('an image sent with no words still renders as a row', () => {
  const messages = normalizeSdkMessage({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 } },
      ],
    },
  }, 'session-1');

  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, '');
  assert.equal(messages[0].attachments?.length, 1);
});
