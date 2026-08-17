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
| **whisper.cpp** `base.en` **q8_0** | **78.0 MiB** | MIT / MIT | `@fugood/whisper.node` (prebuilt) or bundled `whisper-cli` | **Recommended** — 522 ms, and faster *and* more accurate than q5_1 |
| whisper.cpp `base.en` q5_1 | 56.9 MiB | MIT / MIT | same | Smaller, but slower and worse — see benchmark |
| whisper.cpp `small.en` q5_1 | 181.3 MiB | MIT / MIT | same | 2191 ms — over the bar, no accuracy gain |
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

### The latency number did not exist, so it was measured

**No source anywhere gives a trustworthy real-time factor for any of these
engines on a modern CPU-only Windows laptop.** That gap is why phase 2 began
with a benchmark rather than with code — the results are in
[Benchmark](#benchmark-measured-on-this-machine) below, and they supersede the
estimates in this section. Kept here because the absence is itself a finding:
anyone else evaluating on-device STT will hit the same wall.

What was published:

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
between a few hundred milliseconds and two seconds.

That estimate turned out to be correct, at the fast end of the range. The
measurement follows.

---

## Benchmark, measured on this machine

**Machine.** AMD Ryzen 7 8845HS (Zen 4, 8 cores / 16 threads, AVX2 + AVX-512 +
VNNI), 15.3 GB RAM, Windows 11, **on AC power**, CPU-only — whisper.cpp reported
`no GPU found`. whisper.cpp **v1.9.2** (2026-08-04), the plain `whisper-bin-x64`
release build.

**Corpus.** Eleven utterances written as realistic dictation into *this* app's
composer — commands, identifiers, file paths, spoken digits: `npm run
typecheck`, `better sqlite three`, `src components petstage ChatPet tsx`, `four
three one seven`. Eight short (3.6–5.5 s) and three long (13.0–14.2 s).
Synthesised at 16 kHz mono 16-bit via Windows TTS, three repetitions each, 264
runs total. Corpus and harness are reproducible; see the caveat below.

### Latency

Inference only — the cost with the model already resident, which is what a warm
integration pays. Milliseconds.

| Model | Disk | 4 threads short | 8 threads short | 8 threads p95 | 8 threads long |
|---|---:|---:|---:|---:|---:|
| `tiny.en` q5_1 | 30.7 MiB | 433 | 322 | 336 | 533 |
| `base.en` q5_1 | 56.9 MiB | 854 | 630 | 702 | 919 |
| **`base.en` q8_0** | **78.0 MiB** | **723** | **522** | **549** | **796** |
| `small.en` q5_1 | 181.3 MiB | 2996 | 2191 | 2331 | 2695 |

Model load, paid once when warm: 60 / 91 / 117 / 236 ms respectively. Cold
subprocess wall-clock for `base.en` q8_0 at 8 threads — process spawn to exit,
load included — is 728 ms short and 1003 ms long.

Four things fall out of this:

**`base.en` q8_0 beats q5_1 on both speed *and* accuracy.** 522 ms against
630 ms, and a lower error rate, for 21 MiB more disk. The intuition that the
smaller quantization must be faster is wrong here: q8_0 has the better SIMD
path on AVX2/AVX-512. **This changes the recommendation** — q8_0 is the pick,
and the extra 21 MiB is bought back several times over.

**Latency is roughly flat under 30 seconds.** A 14-second utterance costs 796 ms
against 522 ms for a 4-second one — not 3.5× more. Whisper pads every input to a
30-second window, so the encoder cost is fixed and only decoding scales. Long
dictation is cheap; the pricing is per-utterance, not per-second.

**The 2-second bar is cleared with 3–4× headroom, and it holds under
contention.** Even at 4 threads — the case where the machine is busy doing
something else — q8_0 is 723 ms short and 1051 ms long.

**`small.en` is correctly excluded.** 2191 ms at 8 threads is over the bar, and
it buys no accuracy (below). OpenBLAS was also tried: 494 ms against 522 ms, a
~5% gain for +12 MB of DLLs. Not worth it — **ship the 7.8 MB plain build.**

### Accuracy, which is the more interesting result

Raw word error rate over the technical corpus was **13.5–15.1%, and essentially
flat across every model size** — `tiny.en` scored the same as `small.en`. A flat
curve across a 6× parameter range is the signature of errors that are not
acoustic, and reading the transcripts confirms it. The 28 "errors" on `base.en`
split three ways:

**Most are formatting, and most of those are improvements.** Asked for "line
forty two" it wrote `line42`; "four three one seven" became `4317`; "sixteen
kilohertz" became `16 kHz`; "composer component" became "Composer component".
Scored as errors against a literal reference, these are what you actually want
in a composer.

**Some are compound splitting.** `typecheck` → "type check", `websocket` →
"web socket". Real, trivial, and fixable.

**A few are genuine mishearings, and they are all project nouns.** `plain node`
→ "play note". `sqlite` → "Sleight". `silero` → "silro". `petstage ChatPet tsx`
→ "Pet's Tage Chat Pet TSX". This is precisely the failure predicted for a
caption-trained model in a coding tool — and it is the only category that
matters.

**True error rate, counting only genuine mishearings, is roughly 3–4%.**

### Vocabulary seeding fixes most of what is left

Whisper's `initial_prompt` conditions the decoder on supplied text. Seeding it
with about forty words of project vocabulary, at a cost of **~50 ms (+9%)**:

| | bare | seeded with project vocabulary |
|---|---|---|
| s1 | "npm run **type check**" | "npm run **typecheck**" |
| s4 | "spawn plain **note**" | "**ensureServer** spawn plain **node** … **execPath**" |
| l1 | "**Pet's Tage Chat Pet TSX**" | "**petstage, ChatPet.tsx**" |
| l3 | "gated by **silro** VAD" | "gated by **Silero** VAD" |
| s6 | "better **Sleight** 3" | "better **Sclyte3**" — still wrong |

Four of five fixed, including every bad one. On `s4` the seeded output is
*better than the reference*: it produced the camelCase identifiers
`ensureServer` and `execPath` from speech that did not contain the casing.

This is the design consequence: **the composer should seed the decoder from
context it already has** — the session's `cwd` and the filenames in it, plus a
static list of the project's own vocabulary. This app is unusually well placed
to do that, and it costs 50 ms.

`sqlite` resists seeding even though `better-sqlite3` was in the prompt, which
is likely an artifact of how the synthesizer pronounces it rather than a model
limitation.

### Robustness: noise, reverberation, and a second speaker

The clean-room objection to the numbers above is the obvious one, so the corpus
was degraded toward what a laptop microphone in a room actually delivers —
pink-ish room tone at three signal-to-noise ratios, three early reflections, and
a slow gain drift standing in for someone leaning toward and away from the
machine — and re-run against a second synthetic speaker at a different pace.
`base.en` q8_0, seeded, key tokens being the identifiers and commands whose loss
actually costs the user something:

| Condition | WER% (bare) | WER% (seeded) | Key tokens (seeded) |
|---|---:|---:|---:|
| Speaker A, clean | 14.6 | 9.7 | 34/36 |
| Speaker A, 20 dB SNR | 14.6 | 9.7 | 34/36 |
| Speaker A, 12 dB SNR | 16.8 | 9.2 | 34/36 |
| Speaker A, 6 dB SNR | 18.4 | 12.4 | 32/36 |
| Speaker B, clean | 14.6 | 8.6 | 33/36 |
| Speaker B, 6 dB SNR | 17.8 | 11.9 | 34/36 |

Three things worth keeping:

**It degrades gracefully rather than falling over.** Six decibels SNR is a
genuinely noisy room. It costs about three points of WER and two key tokens.

**Seeding helps *more* as conditions worsen** — 18.4% → 12.4% at 6 dB, a third
of the errors removed, against 14.6% → 9.7% when clean. That is the expected
shape: the language prior is doing more work precisely when the acoustics are
doing less.

**Latency is unaffected by noise**, which follows from the encoder cost being
fixed per 30-second window.

Across all eight conditions, seeded key-token recall was **92.7%**, and the
residual misses were not spread out: `sqlite` and `exec` accounted for 15 of 21.
Two words. That is a lookup table, not a model problem — and it is why
`cleanup.ts` carries a small, specific mis-hearing map rather than a fuzzy
matcher that would start "correcting" words the user really said.

### What the benchmark does not prove

**The audio is synthesised, not human.** Latency is unaffected — compute is
driven by duration, and every clip is real 16 kHz PCM. Accuracy remains
optimistic even after the degradation study above: added noise and reverb
simulate a *room*, but nothing here simulates an *accent*, a disfluency, an
uneven pace, or the particular way one person's voice hits one microphone. The
identifier-mangling mode is a language prior rather than an acoustic one, so it
transfers; the absolute rate will still be worse than measured.

Closing that gap needs a recording, which is a two-minute job and is the one
piece of evidence this document cannot generate for itself. `recorder.html`
alongside the benchmark harness reads the same eleven sentences back to a person
and saves them as 16 kHz WAVs in exactly the format the app captures, so the
accuracy half re-runs unchanged against real speech.

Also unmeasured: sustained thermal behaviour, and battery. This ran on AC. A
laptop on battery with a conservative power profile will be slower, and that is
the case most likely to approach the bar.

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

3. **whisper.cpp `base.en` q8_0 (78.0 MiB)** as the engine — **revised from
   q5_1 by the benchmark**, which found q8_0 both faster (522 ms vs 630 ms) and
   more accurate for 21 MiB more disk. Reached through `@fugood/whisper.node` —
   MIT end to end, real Windows x64 prebuilts, no toolchain on install.
   `sherpa-onnx-node` is the fallback if that addon disappoints, and a bundled
   `whisper-cli` subprocess is the fallback if native addons prove hostile at
   all — measured at 1003 ms wall-clock even cold, so that escape hatch is
   affordable rather than theoretical. All three sit behind one interface in
   `server/modules/voice/`, so the choice stays reversible.

4. **The model is a deliberate, visible, one-time download of 78 MiB**, stated
   in the UI before it happens, stored under `~/.tails` next to the database.
   Never on launch, never implicit.

5. **Seed the decoder with project vocabulary.** `initial_prompt` built from the
   session `cwd`, the filenames in it, and a static project word list. ~50 ms,
   and it is the difference between "Pet's Tage Chat Pet TSX" and
   "petstage, ChatPet.tsx".

6. **Correction is tiers 1 and 2 only.** Whisper's own normalisation, plus a
   documented deterministic pass. The transcript never leaves the machine, and
   there is no cloud fallback to accidentally leave enabled.

7. **The wake word ships as a documented "not built" state**, replacing the
   current one — not because it is hard, but because every route to it either
   breaks the licence (openWakeWord's CC-BY-NC-SA weights), breaks the no-network
   rule (Porcupine's AccessKey validation), or cannot deliver the configurable
   name that was asked for. The new copy should say which of those it is rather
   than repeating "not built."

### The main risk

**The latency risk is retired.** It was the number the feature lived or died on,
it was unverified, and it has now been measured on the target machine with 3–4×
headroom against the bar — including at 4 threads, and including the cold
subprocess path. Nothing in the remaining plan is gated on it.

**The remaining risk is accuracy on a real voice**, and it is genuinely open.
Every accuracy figure above comes from synthesised speech, which has no room
noise, no accent and no disfluency. The category of error that matters —
mangled identifiers and project nouns — is a language prior rather than an
acoustic one and so should transfer, and vocabulary seeding demonstrably fixes
most of it. But the absolute rate on a real microphone in a real room will be
worse than 3–4%, and by an unknown factor.

The mitigation is that the latency headroom is large enough to spend. If a real
recording shows the error rate is too high, `small.en` q5_1 is available at
2191 ms — over the 2-second bar, but the bar was set for a model that turned out
to be four times faster than needed, and a slower-but-right transcript may be
the better trade. That is a decision to make with a real recording in hand, not
before. **The first task of implementation is to record a dozen real utterances
and re-run the accuracy half of this benchmark.**

The second risk is the one this document cannot resolve from the outside:
dictation that needs correcting is worse than typing, and whether a 3–4% error
rate on identifiers crosses that line is a judgement about how it feels to use,
not a number.

---

## What implementation found

Three results that came out of building rather than researching, recorded here
because each one is a trap the next person would otherwise fall into.

### The wake-word runtime: WASM in the renderer, not a native addon

Both runtimes were measured on this machine, running openWakeWord's three-graph
chain over 60 seconds of audio, single-threaded:

| | native `onnxruntime-node` | `onnxruntime-web` (WASM) |
|---|---:|---:|
| Continuous listening, 1 word | **1.80%** of one core | 5.37% |
| 3 words | 1.80% | 6.12% |
| Per 80 ms chunk | 1.44 ms | 4.29 ms |
| Shipped payload | ~60 MB | **12.86 MB** |
| Native addon | yes | no |
| `postinstall` script | **yes — network-capable** | none |

WASM costs three times the CPU and won anyway. 5.4% of one core is 0.34% of
this 16-thread machine and is paid only by someone who switched the feature on,
against ~47 MB less shipped, no native addon, no ABI surface — and no
install-time network call inside a feature whose whole premise is that nothing
touches the network. The ABI risk that looked like the danger is not one:
`onnxruntime-node` is N-API (napi-v6), which is version-stable by design and
genuinely not the `better-sqlite3`/`node-pty` category.

**Two sub-findings worth keeping:**

**Threads make it worse.** Two threads measured **9.17%** against one thread's
5.37% — coordination overhead dominates on graphs this small. So the feature
needs no `SharedArrayBuffer`, and therefore no cross-origin isolation headers
on a page the app serves itself. That constraint evaporated on measurement.

**A Worker is required, but not because 5.4% is large.** The work arrives as a
**4.29 ms block every 80 ms** against a 16.7 ms frame budget — a quarter of a
frame, twelve times a second, on the thread that draws the pet. On the main
thread this would have shipped as "the pet stutters sometimes", a symptom
nobody would ever have traced back to the wake word.

The 12.86 MB `.wasm` is emitted as its own asset and the worker as its own
74 KB chunk, neither referenced until a wake word is armed — so the initial
bundle is unchanged and nothing downloads for a user who leaves this off.

### The measurement that was wrong before it was right

The first idle-CPU figure was **1.15%**, and it was a measurement of a pipeline
that could not detect anything. It was plausible, in the right range, and
nothing about it looked broken. It was caught only because a validity check
scored exactly 0.0000 on a clip of the wake phrase.

Two causes, both now encoded as tested constants in `wake-window.ts`:

- The classifier consumes 16 embeddings over a 76-frame window and cannot
  produce **any** score until ~2.0 s of audio has arrived. Probe clips were
  1.6 s. No score and a zero score look identical.
- Feeding the melspectrogram graph bare 1280-sample chunks yields **5 frames,
  not 8** — the STFT loses its edge frames with no history. The reference
  carries 480 samples of overlap. Without it the warm-up stretches to 3.2 s and
  every frame's timing drifts off what the models were trained on.

Corrected, the figure is 1.80% and the chain scores 0.9979 on the wake phrase.
**A cheap pipeline that never fires is not cheap, it is broken** — validity
checks belong next to performance numbers.

### Platform voice names share no substring across platforms

Matching a pet's authored voice to one installed on this machine looks like a
one-line `includes()`. It is not:

```
"Microsoft Zira - English (United States)"   // how Chrome names her
"Microsoft Zira Desktop"                     // how Windows names her
```

**Neither string contains the other**, so a naive substring match silently
fails to find the same speaker, falls through to a language fallback, and picks
a different voice. Nothing throws, nothing fails a typecheck, and the only
symptom is that a pet sounds wrong on some machines.

The fix in `pet-voice.ts` is to reduce both names to their *distinctive* words —
dropping `microsoft`, `desktop`, `english`, `united`, `states` and the rest of
the decoration every platform wraps around the same speaker — and match on what
is left. Both reduce to `zira`.

This is the shape of bug this project keeps producing: something that looks
like it works, degrades quietly, and is invisible to every automated gate.
