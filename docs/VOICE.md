# Voice — what is actually buildable locally

## The question this document answers

Two features were asked for: auto-correcting dictation in the composer, in the
manner of Wispr Flow, and a "hey TAILS" wake word with a configurable name.
Both under one non-negotiable constraint — **fully local, no audio and no
transcript leaves the machine** — and at low latency.

`src/components/chat/Composer.tsx` currently ships an honest "Not built" state
for voice mode, because Chromium's `SpeechRecognition` uploads audio to a cloud
service. That refusal was correct. This document is about what replaces it.

The short version: **one of these two features is worth building now and the
other is not**, and the reference product the ask was modelled on does not
solve this problem either — it solves a different one.

---

## The reference does it the way we are forbidden to

Wispr Flow is cloud. Not partly, not optionally: *"All transcription happens in
the cloud. There is no offline mode. This is the best way for us to provide
accurate, low latency transcription."* ([Wispr Flow data
controls](https://wisprflow.ai/data-controls), [help
centre](https://docs.wisprflow.ai/articles/2772472373-what-is-flow))

Its architecture is two stages: cloud speech-to-text, then **a second cloud LLM
pass that rewrites the raw transcript** — dropping filler, fixing false starts,
adapting tone per application. The "it fixes what you meant to say" quality
people notice is that second stage, and it is a frontier model running on a
server.

This matters for expectation-setting, not as an excuse. It means the target
here is not "reproduce Wispr Flow locally" — nobody has done that on a CPU. It
is "how much of that experience survives the local constraint, and is the
remainder worth shipping."

---

## Engines

Every number below is sourced. Where a number does not exist, this document
says so rather than inventing one — and the single largest finding of this
research is how much is missing.

### Speech-to-text candidates

| Engine | Disk (English) | Licence (code / weights) | Windows Node path | Verdict |
|---|---|---|---|---|
| **whisper.cpp** `base.en` q5_1 | **57.0 MiB** | MIT / MIT | `@fugood/whisper.node` (prebuilt) or bundled `whisper-cli` | **Recommended** |
| whisper.cpp `base.en` q8_0 | 78.0 MiB | MIT / MIT | same | Quality step up |
| whisper.cpp `small.en` q5_1 | 181.3 MiB | MIT / MIT | same | Too slow on CPU for dictation |
| **sherpa-onnx** (Whisper/Moonshine) | 118 MiB (moonshine-tiny int8) | Apache-2.0 / varies | `sherpa-onnx-node` + `sherpa-onnx-win-x64` (prebuilt, ~23 MB) | **Viable fallback** |
| Moonshine tiny / base | 118 MiB / 272 MiB | MIT / MIT | via sherpa-onnx or `@huggingface/transformers` | Promising, unverified |
| Vosk `small-en-us-0.15` | 40 MiB | Apache-2.0 / Apache-2.0 | **npm binding dead since 2022-05** | Rejected |
| NVIDIA Parakeet / Canary | 622 MiB / ~700 MiB | Apache / **CC-BY-4.0** | via sherpa-onnx | Too heavy, GPU-targeted |
| Kyutai STT 1B | 2.36 GB | MIT+Apache / CC-BY-4.0 | none | Rejected — GPU-only |
| Distil-Whisper / large-v3-turbo | 330 MiB / 327–440 MiB | MIT / MIT | transformers.js | Rejected — see below |

Sizes are from the Hugging Face API for
[`ggerganov/whisper.cpp`](https://huggingface.co/ggerganov/whisper.cpp) and the
sherpa-onnx release tarballs. `whisper.cpp` moved to the
[`ggml-org`](https://github.com/ggml-org/whisper.cpp) organisation and is
actively maintained — v1.9.2, 2026-08-04, roughly monthly releases.

**Distil-Whisper and `large-v3-turbo` are rejected for a specific reason.**
Their headline speedups come from efficient long-form chunking, and a 3–8
second composer utterance is a single pass — the mechanism that makes them fast
does not engage. Neither model card benchmarks against `base.en`, so there is no
evidence they win in this regime, and `distil-small.en`'s published short-form
WER of 12.1 is *worse* than the large model it distils. Turbo cuts the decoder
from 32 layers to 4, and community reports describe more hallucination on short
or noisy clips. Both would be a bet against the only data available.

### The latency number does not exist

This is the honest and slightly uncomfortable centre of the research. **No
source anywhere gives a trustworthy real-time factor for any of these engines
on a modern CPU-only Windows laptop.** What exists:

- whisper.cpp [issue #89](https://github.com/ggml-org/whisper.cpp/issues/89),
  crowdsourced, **encoder forward pass only** — not full pipeline: Ryzen 9
  5950X / 8 threads / AVX2 → `base` 421 ms, `small` 1393 ms.
- whisper.cpp [discussion
  #3752](https://github.com/ggml-org/whisper.cpp/discussions/3752), real
  full-pipeline RTF on an 11 s clip — but on a **2010 Intel i5-460M with no
  AVX**: `base` q8_0 at 0.82× RTF.
- sherpa-onnx's only published RTF table is Whisper `tiny.en` on a **Raspberry
  Pi 4**: 0.52–0.69× RTF.
- Phoronix benchmarked `base.en`/`small.en` on a Ryzen 9950X, but the numeric
  data sits behind a Cloudflare challenge.

Blog posts claiming "`small.en` at 0.085 RTF" or "7–8× real-time" disclose no
CPU and no methodology. They are excluded rather than repeated.

One useful signal survives the noise: on AVX2-capable chips the 5-bit
quantizations (q5_1) run *faster* than fp16, and the anomaly where q5_1 is slow
is specific to pre-AVX CPUs where the 5-bit unpack has no SIMD to hide behind.
Every plausible target machine has AVX2.

**Bounding the problem rather than guessing it:** `base` encoder is ~421 ms on a
fast desktop core and the full pipeline on a fifteen-year-old CPU is roughly
real-time. A 6-second utterance on a current laptop should land somewhere
between a few hundred milliseconds and two seconds. That is a range, not a
measurement, and the first thing phase 2 should do is replace it with one.

### Is that fast enough to beat typing?

Yes, and not narrowly. Speech runs at roughly 150 wpm against 40 wpm for
typing. A 6-second utterance is about 15 words — twenty-odd seconds of typing.
Even two seconds of post-utterance latency is a large net win.

The risk is not throughput. It is that dictation which needs correcting is
worse than typing, because reading and repairing a wrong sentence costs more
than writing a right one. **Accuracy, not speed, is the thing that decides
whether this feature is used twice.**

---

## The native-module problem

`ensureServer()` in `electron/main.js` spawns a **plain Node** process precisely
because `better-sqlite3` and `node-pty` are built against Node's ABI and
Electron's `NODE_MODULE_VERSION` differs. `terminal-gateway.ts` carries the scar
in its comments: node-pty import failure must degrade to a panel that says so,
never to a server that will not boot.

**That scar does not recur here, and it is worth being precise about why.**

`onnxruntime-node` — the substrate under sherpa-onnx and transformers.js — is an
**N-API** addon (`node-addon-api`, `napi_versions: [6]`). N-API is explicitly
ABI-stable across Node major versions by design, not by luck: modules compiled
for one major version run on later ones without recompilation
([nodejs.org/api/n-api](https://nodejs.org/api/n-api.html)). Windows x64
prebuilts ship in `bin/napi-v3/win32/x64/`. And the STT work runs in the plain
Node server anyway, which is the well-supported case.

`better-sqlite3` and `node-pty` are NAN/V8-ABI addons. That is a different
category of dependency, and conflating the two would mean rejecting a safe
option for the sins of an unsafe one.

Still, the toolchain question is real and it eliminates most of the field:

| Package | Windows x64 prebuilt? | Status |
|---|---|---|
| `sherpa-onnx-node` | **Yes** — `sherpa-onnx-win-x64` | v1.13.5, ~100k weekly downloads |
| `@fugood/whisper.node` | **Yes** — `@fugood/node-whisper-win32-x64`, 2.7 MB | v1.1.1, 2026-07-19, MIT |
| `smart-whisper` | No — needs MSVC | GitHub active, npm stale |
| `nodejs-whisper` | No — needs MinGW-w64/MSYS2 | npm active |
| `whisper-node` | No — needs GnuWin32 `make` | Stale since 2024 |
| `vosk` | Native, unmaintained | Last publish 2022-05 |

A package that shells out to `node-gyp` on install is not shippable — it turns
`npm install` into "do you have Visual Studio Build Tools." Only the top two
rows survive.

**The escape hatch, if the addon fights us.** whisper.cpp ships prebuilt Windows
binaries in every release (`whisper-bin-x64.zip`, 8.2 MB; the OpenBLAS build,
20.9 MB). Note that `whisper-cli` takes `-f FILENAME` and **cannot read audio
from stdin** — so this is a temp-file-in, JSON-out subprocess, not a streaming
stdio pipe. That is a real latency cost (a disk round-trip per utterance) but it
buys complete independence from Node's ABI. Given this project's history, it is
worth keeping as the documented fallback rather than discovering it under
pressure.

---

## Where the audio is captured

The renderer has `getUserMedia`; the server does not. Two facts settle the
design.

**The renderer is already a secure context.** `electron/main.js` does
`loadURL(APP_URL)` where `APP_URL` is `http://127.0.0.1:<port>` in *both* dev and
production — never `file://`. Loopback HTTP is a secure context under the
localhost exception, so `getUserMedia`, `AudioContext` and `AudioWorklet` all
work with no scheme change and no Electron-specific shim.

**The transport is cheap enough not to think about.** An `AudioWorklet` on the
audio thread downsamples to 16 kHz mono and emits Int16 PCM — 32 KB/s, in ~100 ms
chunks. Over loopback that is nothing. Binary WebSocket frames rather than
base64-in-JSON avoids a third of the bytes and the encode/decode cost, and the
worklet runs off the main thread so the pet animations do not stutter while
you talk.

So: **capture in the renderer, stream Int16 PCM over a dedicated binary
WebSocket to the server, decode there.** The alternative — running the model in
the renderer via `onnxruntime-web` — keeps audio in one process but puts a
multi-hundred-millisecond CPU burn inside the window that draws the UI, and
loses the ability to cache a warm model across window reloads.

One thing this needs that does not exist yet: the gateway must claim its own
path using the `routeUpgrades` chaining pattern that
`server/modules/terminal/terminal-gateway.ts` documents at length. A second
naive `new WebSocketServer({ server, path })` **aborts the other gateways'
handshakes with a 400**. That comment is the most valuable paragraph in the
server and it applies verbatim here.

---

## The microphone has to be trustworthy

Right now it is not, and this is a finding rather than a design note.

`electron/main.js` sets **no permission handler at all**. Electron's default is
to grant, and Electron groups camera, microphone and screen capture into a
single `media` permission. Any code in the renderer — including a generated
theme's stylesheet payload, given this app lets an agent write CSS — sits in a
process that can open the microphone without a prompt.

Before any voice code ships, `session.setPermissionRequestHandler` should deny
everything by default and allow `media` only while the app itself has asked for
it. That is a small change in a file with a live owner; it is described in the
handover notes rather than made here.

Beyond the permission gate, the UI obligations are:

- The microphone is **closed** when not dictating — the `MediaStreamTrack` is
  stopped, not merely muted. A muted track still shows the OS recording
  indicator, and a user who sees that indicator while they believe the mic is
  off has learned the app lies.
- Listening state is visible without hunting for it, and the same indicator is
  the off switch.
- No implicit start. Nothing opens the microphone on launch.

---

## Wake word

This is where the research turns decisive, and the answer is no.

### Porcupine is disqualified, twice over

Picovoice's **free tier was discontinued on 2026-06-30** — a date that has
already passed. Existing free-tier AccessKeys stop working; it is replaced by a
7-day trial for product teams, and Picovoice have stated *"there is no
non-commercial tier planned"* ([HA community
thread](https://community.home-assistant.io/t/fyi-picovoice-confirmed-free-tier-accesskeys-will-stop-working-after-june-30-2026/1012744)).

Independently of price, **every Porcupine SDK validates an AccessKey against
Picovoice's licence servers**, and the Android quick-start requires the INTERNET
permission. Detection itself is offline, but the SDK will not initialise without
the key check, and Picovoice's own documentation does not state unambiguously
whether that check is once-ever or per-launch. For a feature whose entire premise
is "nothing reaches the network," a dependency that phones home at startup and
whose phone-home cadence is undocumented is not a candidate.

Custom wake words on non-enterprise accounts also **expire after 30 days** and
are limited to personal use. Shipping "hey TAILS" would need a sales-negotiated
enterprise agreement.

### openWakeWord is licence-incompatible

The code is Apache-2.0. **The pretrained models are CC-BY-NC-SA 4.0 —
non-commercial** — because of datasets with unknown or restrictive licensing in
their training data. This app is MIT. Shipping the bundled `hey_jarvis` /
`alexa` / `hey_mycroft` models is not available to us.

Training our own model avoids the weights licence, but the official
`automatic_model_training.ipynb` Colab notebook is **reported broken** on current
runtimes; the working path is a community fork
([alfiedennen/openwakeword-colab-2026](https://github.com/alfiedennen/openwakeword-colab-2026))
claiming 75–90 minutes per word on Colab Pro. openWakeWord is also Python-only;
the official answer for browsers is "stream audio to a Python backend." A genuine
browser ONNX port exists —
[dnavarrom/openwakeword_wasm](https://github.com/dnavarrom/openwakeword_wasm) —
at v0.1.0 with six GitHub stars.

### "Configurable, default TAILS" is the part that cannot be built

Even setting licensing aside, the requirement as written does not have a
solution in 2026.

Every accurate wake-word engine is a **trained binary classifier for one
specific phrase**. Changing the name means generating synthetic TTS samples,
mining negatives, and training — minutes to an hour, offline, per name. There
is no runtime "type a new word and it works."

The one thing that *does* do open-vocabulary wake words locally is PocketSphinx
keyphrase spotting, which is phoneme/HMM-based and needs no training at all. It
is also, by consistent report, bad enough that it fires on words that merely
rhyme. Shipping a wake word that triggers on the wrong thing is worse than
shipping none: it means the app started listening when you did not ask it to,
which is the exact failure the whole feature has to avoid.

So the realistic shape is a small set of names pre-trained at build time — which
is not "configurable," it is a dropdown, and it should be described as one if it
is ever built.

### Idle cost, for the record

The brief asked what continuous listening actually costs. The honest answer is
that **nobody publishes an x86 laptop number for openWakeWord**. The available
data is a Raspberry Pi 3 proxy ("15–20 models simultaneously in real-time",
implying ~5–7% of one weak ARM core per model) alongside field reports of the
process pinning 100% CPU on a Pi Zero and exceeding 100% in containers
([wyoming-openwakeword #30](https://github.com/rhasspy/wyoming-openwakeword/issues/30)).
Porcupine claims <4% of one Raspberry Pi 3 core. Neither is a laptop.

What *is* measured: **Silero VAD at roughly 0.43% of one core** (RTF 0.004),
under 1 ms per 30 ms chunk. That number comes from Picovoice's own comparison
blog — a competitor, so treat it as directional — but it is consistent with the
model's 260K parameters.

And the always-on-Whisper alternative is roughly an order of magnitude worse
than a dedicated classifier. No rigorous head-to-head CPU benchmark exists,
which is itself informative: essentially nobody deploys Whisper as a keyword
spotter, because a full acoustic and language model over every frame is a
different cost class from a small classifier over a rolling window.

### What is actually good here

**Silero VAD is the one unambiguous win in this whole area.** MIT licensed, no
keys, no telemetry, no registration. ~1–2 MB ONNX. Under 1 ms per chunk.
Currently at v6.2 (2025-12-10) and actively developed
([snakers4/silero-vad](https://github.com/snakers4/silero-vad)).

The browser wrapper [`@ricky0123/vad-web`](https://www.npmjs.com/package/@ricky0123/vad-web)
is at v0.0.30 published 2025-11-21 — genuinely maintained, ISC licensed, bundles
`silero_vad_v5.onnx`, runs on `onnxruntime-web`. Note that its sibling
`@ricky0123/vad-node` is stale at v0.0.3 from roughly two years ago; **use the
web package in the renderer, not the node package in the server.**

Honourable mentions for whenever wake word is revisited: **Hey Buddy**
(Apache-2.0 code *and* models, 90 KB browser JS + 1 KB worklet, custom word via a
single `heybuddy train "hello world"` CLI command — but last updated October
2024) and **Rustpotter** (Apache-2.0, has a real AudioWorklet/WASM port, tiny
community). LiveKit's new Apache-2.0 wake-word model claims large accuracy wins
over openWakeWord but ships Python/Rust/Swift bindings only.

---

## What "auto-correcting" would actually mean

### The brief contains an error worth correcting

The task said: *"note we have a local LLM already available in-process, since
the app is a Claude Code host."*

**There is no local LLM in this app.** `@anthropic-ai/claude-agent-sdk` is Claude
Code packaged as a library; `query()` spawns the CLI, which calls Anthropic's
cloud API. `server/modules/chat/model.service.ts` reads the model by starting
that subprocess and waiting for its `init` event — an event that arrives from a
server. There is nothing on this machine doing inference.

So the obvious design — pipe the raw transcript through the agent for a cleanup
pass — **sends the transcript off the machine and breaks the one constraint the
feature has.**

It is worth being precise about the nuance, because there is a tempting
counter-argument. The user's dictated message goes to Claude anyway when they
press send, so what is the difference? The difference is consent and scope. Text
the user read and chose to send is not the same as an automatic background
round-trip of whatever the microphone thought it heard — false starts, the
half-sentence you abandoned, the thing said to someone else in the room. With a
wake word and a permanently open microphone, that distinction is the entire
trust model.

If a cloud correction pass is ever wanted it must be an explicit, off-by-default,
clearly-labelled choice. It cannot be the default and it cannot be quiet.

### Most of the correction is already free

The genuinely good news: **Whisper already does the filler-word half of this,
for nothing.** It was trained on 680,000 hours of normalised captions, and
implicit disfluency removal is a well-documented artifact of that data — it
drops "um" and "uh" on its own, producing what the literature calls an
"intended" rather than verbatim transcription
([CrisperWhisper, arXiv:2408.16589](https://arxiv.org/pdf/2408.16589);
[faster-whisper #901](https://github.com/SYSTRAN/faster-whisper/issues/901)).
It is not configurable and it is not perfect, but the most visible layer of
"clean up what I said" arrives with the model.

That leaves a narrower residual gap: **false starts and self-corrections** —
"let's meet Tuesday, wait no, Friday" should land as "Let's meet Friday."
Whisper transcribes those faithfully.

### Three tiers, and where to stop

| Tier | Mechanism | Cost | Quality |
|---|---|---|---|
| 1 | Whisper's implicit normalisation | Free — comes with the model | Filler words handled |
| 2 | Deterministic heuristic pass | <1 ms, ~150 lines, testable | Repeated-word collapse, explicit "scratch that" / "I mean" / "no wait" rewrites |
| 3 | Local small LLM rewrite | +400–600 MB on disk, 1–3 s per utterance | Wispr-Flow-grade, genuinely rewrites intent |

Tier 2 is worth building. It is pure functions over a string, it costs nothing
at runtime, it is trivially unit-testable against the existing
`server/**/*.test.ts` harness, and — crucially — it is *predictable*. A user
learns that saying "scratch that" deletes the last clause, and that is a
feature rather than a model's opinion.

**Tier 3 should not be built now.** A 0.6B-parameter model in Q4 is several
hundred megabytes on top of Whisper's 57 MiB, needs a second inference runtime,
and adds one to three seconds *after* transcription has already finished — which
is where the "slower than typing" line finally gets crossed. And a small model
rewriting your sentence is an unpredictable failure mode: when it silently
changes a word you did say, you have to proofread every dictation, and the
feature has cost you more than it saved.

---

## Recommendation

**Build the dictation path. Do not build the wake word. Do not build the LLM
rewrite.**

Concretely:

1. **Capture and VAD** — `getUserMedia` in the renderer, `AudioWorklet`
   downsampling to 16 kHz mono Int16, Silero VAD via `@ricky0123/vad-web`
   gating on speech, binary frames to a dedicated `/voice` WebSocket that
   claims its path through the `routeUpgrades` pattern. MIT/ISC throughout,
   ~2 MB of model, sub-1% CPU. This layer is required by every possible future
   engine choice and carries no engine-specific commitment.

2. **Push-to-talk dictation**, not always-on. A mic button in the composer,
   held or toggled. VAD provides endpointing so the user does not have to press
   stop precisely.

3. **whisper.cpp `base.en` q5_1 (57.0 MiB)** as the engine, reached through
   `@fugood/whisper.node` — MIT end to end, real Windows x64 prebuilts, no
   toolchain on install. `sherpa-onnx-node` is the fallback if that addon
   disappoints, and a bundled `whisper-cli` subprocess is the fallback if native
   addons prove hostile at all. All three sit behind one interface in
   `server/modules/voice/`, so the choice is reversible.

4. **The model is a deliberate, visible, one-time download of 57 MiB**, stated
   in the UI before it happens, stored under `~/.tails` next to the database.
   Never on launch, never implicit.

5. **Correction is tiers 1 and 2 only.** Whisper's own normalisation, plus a
   documented deterministic pass. The transcript never leaves the machine, and
   there is no cloud fallback to accidentally leave enabled.

6. **The wake word ships as a documented "not built" state**, replacing the
   current one — not because it is hard, but because every route to it either
   breaks the licence (openWakeWord's CC-BY-NC-SA weights), breaks the no-network
   rule (Porcupine's AccessKey validation), or cannot deliver the configurable
   name that was asked for. The new copy should say which of those it is rather
   than repeating "not built."

### The main risk

**The latency number is unverified and it is the number the feature lives or
dies on.** Nobody publishes a real-time factor for any of these engines on a
CPU-only Windows laptop, and this document's estimate of "a few hundred
milliseconds to two seconds for a 6-second utterance" is bracketed by an
encoder-only measurement on a desktop Ryzen and a full-pipeline measurement on a
2010 CPU with no AVX. Neither is the target machine.

The mitigation is cheap and should be the first task of phase 2: a
throwaway benchmark of `base.en` q5_1 and q8_0 on this actual machine against a
handful of real 3–8 second utterances, before a line of feature code is written.
If `base.en` lands above roughly two seconds, the honest answer is to ship
nothing rather than ship dictation that loses to the keyboard.

The secondary risk is accuracy rather than speed. `base.en` is a small model,
and this is a *coding* app — it will be asked to transcribe identifiers, flags
and file paths, which is close to the worst case for a model trained on
podcasts and captions. Whisper's `initial_prompt` can be seeded with project
vocabulary to help, and the benchmark above should include realistic technical
phrasing rather than prose, or it will measure the wrong thing.
