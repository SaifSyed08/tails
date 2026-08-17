/**
 * Drives the dictation socket exactly as the renderer does.
 *
 * The point is the *route*, not the recogniser: it connects through the Vite
 * dev server on 7317 rather than to the API server directly, because the bug
 * being verified was that the dev proxy did not forward `/voice`. Talking
 * straight to 4317 would pass whether or not the fix is in.
 *
 * Streams a real WAV in 100 ms blocks, the same size the capture worklet posts,
 * then sends `voice.stop` and prints every frame the server sends back.
 */
import fs from 'node:fs';
import WebSocket from 'ws';

const [wav, origin = 'ws://127.0.0.1:7317'] = process.argv.slice(2);
const bytes = fs.readFileSync(wav);

// Skip the RIFF header to the `data` chunk rather than assuming 44 bytes: the
// synthesiser writes a `fact` chunk too, and being 12 bytes out turns speech
// into noise at the start of every utterance.
let at = 12;
while (at < bytes.length - 8) {
  const id = bytes.toString('ascii', at, at + 4);
  const size = bytes.readUInt32LE(at + 4);
  if (id === 'data') { at += 8; break; }
  at += 8 + size + (size % 2);
}
const pcm = bytes.subarray(at);
console.log(`wav ${wav}: ${pcm.length} bytes of PCM (${(pcm.length / 2 / 16000).toFixed(1)}s), data at ${at}`);

const BLOCK = 1600 * 2; // 100 ms of 16 kHz mono int16, as the worklet posts.
const socket = new WebSocket(`${origin}/voice`);
const frames = [];
let opened = false;

const done = (code) => {
  console.log('\n--- frames ---');
  for (const frame of frames) console.log(' ', JSON.stringify(frame));
  const text = frames.filter((f) => f.type === 'partial' || f.type === 'transcript')
    .map((f) => f.text).join(' ');
  console.log('\ntranscript:', text || '(nothing)');
  console.log(opened ? 'socket: opened' : 'socket: NEVER OPENED');
  process.exit(code);
};

socket.on('open', () => {
  opened = true;
  console.log('socket open through', origin);
  socket.send(JSON.stringify({ type: 'voice.start' }));

  let offset = 0;
  // Paced at real time. The server rate-limits its live passes to one a second
  // and only runs them while its speech gate is open, so firing the whole file
  // at once would produce a single final transcript and prove nothing about
  // the streaming path.
  const timer = setInterval(() => {
    if (offset >= pcm.length) {
      clearInterval(timer);
      socket.send(JSON.stringify({ type: 'voice.stop' }));
      return;
    }
    socket.send(pcm.subarray(offset, offset + BLOCK));
    offset += BLOCK;
  }, 100);
});

socket.on('message', (data) => {
  const frame = JSON.parse(data.toString());
  frames.push(frame);
  console.log('<-', JSON.stringify(frame));
  if (frame.type === 'transcript' || frame.type === 'error') setTimeout(() => done(0), 300);
});

socket.on('error', (error) => { console.log('socket error:', error.message); done(1); });
socket.on('close', () => { if (!opened) done(1); });
setTimeout(() => done(frames.length ? 0 : 1), 45_000);
