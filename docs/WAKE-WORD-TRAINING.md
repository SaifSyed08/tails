# Training the "tails" wake word

This produces the one file the app is missing: `tails.onnx`, a wake-word
classifier. Everything else — the runtime, the download plumbing, the settings
toggles — is already built and waiting for it.

**Do both phrases.** The config for `hey tails` is below alongside `tails`, and
training the second costs one extra run of the same pipeline. The reason is in
[Why two phrases](#why-two-phrases); short version, `tails` alone is below the
published reliability floor and the only way to know how much that costs is to
measure both.

**This runs on this machine.** An earlier version of this document sent the job
to Colab; that advice was wrong and is corrected below.

---

## Correction: it does not need Colab

This document used to open with "Training locally was priced and rejected on
evidence", citing a livekit-wakeword contributor's report of **~14 hours of CPU
feature extraction** against 13 minutes on a GPU. That figure was repeated here
without being reproduced, and both of the things it rested on turned out not to
apply.

**Measured here, feature extraction is 6.5 ms per clip.** The pipeline is two
frozen ONNX graphs per two-second clip — one melspectrogram call at 0.8 ms and
one embedding call at 5.8 ms, because a two-second clip is 16 windows and the
embedding stage already batches 64 at a time. For ~52,000 clips that is about
**five minutes per phrase**, and about **eleven minutes for both**. The
`CPUExecutionProvider` hardcoding is real and still present in 0.2.1; it simply
does not matter at this scale. The contributor's number was almost certainly
extracting features from the full 2,000-hour ACAV100M *audio*, which this
pipeline does not do — it downloads those features precomputed.

The second reason was the Linux-only dependencies. **Version 0.2.1 has none.**
It phonemises with `nltk` + `cmudict` and runs a vendored Piper VITS in pure
PyTorch, so there is no `espeak-ng`, no `sox`, and no apt at all. The setup
commands below are kept for reference but are not needed on Windows.

And the machine this was written for has an **RTX 4060**, which the original
assessment did not account for.

What is left is the download, and it is the only slow part: ~17 GB of
precomputed negatives, backgrounds and impulse responses. That is a function of
the connection, not the hardware.

Reproduce the measurement with `docs/reference/wakeword-feature-bench.py`, run
from the training venv.

---

## Why livekit-wakeword

Two reasons, one legal and one that decides whether the feature is usable.

**Licensing.** openWakeWord's code is Apache-2.0 but its *pretrained classifier
weights* are CC-BY-NC-SA — non-commercial, and not shippable inside an MIT
application. livekit-wakeword's are plain Apache-2.0. (A model we train
ourselves is ours either way; this matters for anything we might bundle later.)

**False accepts.** This is the problem `tails` actually has. livekit's published
comparison, on their own "hey livekit" validation set of 15,000 positive and
45,084 negative clips over 25 hours:

| | openWakeWord (DNN) | livekit (conv-attention) |
|---|---:|---:|
| False positives per hour | 8.50 | **0.08** |
| Recall | 68.6% | **86.1%** |
| Optimal threshold | 0.01 | **0.68** |

That is their own benchmark on their own phrase, published with its methodology
but not independently reproduced. Treat it as directional. The direction is the
one we need.

**Nothing changes at runtime.** Both projects share the same frozen front end —
the same melspectrogram graph, the same Google speech-embedding model, the same
`(16, 96)` feature matrix, the same `/10 + 2` scaling. livekit swaps only the
classification head. The app's Worker already implements that front end,
including the 480-sample mel overlap and the 2.0-second warm-up, both measured
here. Training with livekit swaps one file and touches nothing else.

---

## Why two phrases

`tails` is four phonemes and one syllable. Published guidance puts the floor at
six phonemes and two syllables, and the word rhymes with *fails, sales, tales,
bales*, sits inside "heads or tails" and "tails off", and — the case that will
actually bite — is the app's own name, said aloud constantly while using it.

`hey tails` is six phonemes and clears the floor.

The measurement available today, and it is worse than this document used to
claim. A near-rhyme of the *distinctive* phrase "hey jarvis" — "hey harvest" —
was recorded here as scoring **0.29** against a 0.5 threshold, and offered as
evidence of comfortable margin. Re-measured across two voices on identical
synthesised audio it scores **0.190 and 0.961**. The second would fire.

Caveat, stated rather than buried: synthesised speech is not human speech, and
one voice's "harvest" may land unusually close to "jarvis". These figures are
sound for comparing models on identical audio — which is what
`false_accepts.py` is for — and should not be read as absolute rates.

What they do establish is that the single number this threshold was reasoned
from was not representative. If a rhyme can push a distinctive two-word phrase
to 0.96, nothing about phoneme counts predicts where a common one-syllable word
lands. It has to be measured, per phrase, which is the whole reason both are
trained.

So train both, and let the false-accept measurement decide. The app already
supports either — the choice is a config value, not a rewrite.

---

## Setup

A virtual environment outside the app repo, so 17 GB of corpora never goes near
git. CUDA PyTorch first, explicitly, or pip resolves the CPU build and the
training phase runs on the processor for no reason:

```bash
python -m venv .venv
./.venv/Scripts/python.exe -m pip install   --index-url https://download.pytorch.org/whl/cu124 "torch>=2.6" torchaudio
./.venv/Scripts/python.exe -m pip install "livekit-wakeword[train,eval,export]"
```

Check it took: `torch.cuda.is_available()` must be `True`, and `torch.__version__`
must end in `+cu124` rather than being a bare version.

On Windows, run every command below with `PYTHONUTF8=1`. The CLI prints Unicode
arrows through `rich`, and on a cp1252 console that is an unhandled
`UnicodeEncodeError` before it does any work — a crash that looks like a broken
install and is a console encoding.

Then download the models and corpora:

```bash
PYTHONUTF8=1 ./.venv/Scripts/python.exe -m livekit.wakeword setup --config tails.yaml
```

<details>
<summary>The old Colab instructions, kept for reference</summary>

```bash
!apt-get -qq install espeak-ng libsndfile1 ffmpeg sox   # not needed in 0.2.1
!pip -q install "livekit-wakeword[train,eval,export]"
!livekit-wakeword setup --config tails.yaml
```

</details>

> **This is the long download.** The production configuration pulls roughly
> **16–17 GB** of precomputed negative features (ACAV100M) plus background audio
> and room impulse responses. On Colab it comes down inside Google's network,
> which is the main reason this is not being done locally.
>
> It is also the reason this is the slow part now that the compute has been
> measured. Everything after it is minutes.
>
> There is a `--skip-acav` flag. **Do not use it here.** ACAV100M is the corpus
> the false-positive behaviour is tuned against, and skipping it on a phrase
> that is already below the reliability floor removes exactly the protection we
> are training for.

---

## The configs

Save each as its own file in the working directory. They are the production
config with the phrase and the adversarial negatives changed — the negatives are
the part that matters here, because they are how the model is taught what *not*
to fire on.

### `tails.yaml`

```yaml
model_name: tails
target_phrases:
  - "tails"
  - "TAILS"

n_samples: 25000
n_samples_val: 5000
n_background_samples: 2000
n_background_samples_val: 500

# The whole reason this phrase needs care. Rhymes first, then the word inside
# ordinary sentences, then the app's own name as it gets said in conversation.
custom_negative_phrases:
  - "fails"
  - "sales"
  - "tales"
  - "bales"
  - "gales"
  - "whales"
  - "trails"
  - "details"
  - "retails"
  - "tail"
  - "tails off"
  - "heads or tails"
  - "the tail end"
  - "it fails"
  - "for sale"
  - "tell tales"
  - "open tails"
  - "in tails"
  - "tails app"
  - "using tails"

model:
  model_type: conv_attention
  model_size: small
steps: 50000

# Stricter than the default 0.2. A word this common needs the training
# objective itself to prefer silence over a false wake.
target_fp_per_hour: 0.1

data_dir: ./data
output_dir: ./output_tails
```

### `hey_tails.yaml`

```yaml
model_name: hey_tails
target_phrases:
  - "hey tails"
  - "hey TAILS"

n_samples: 25000
n_samples_val: 5000
n_background_samples: 2000
n_background_samples_val: 500

# Fewer are needed: the "hey" prefix does most of the work that the negative
# list has to do for the bare word. These are the ones that survive it.
custom_negative_phrases:
  - "hey fails"
  - "hey sales"
  - "hey tales"
  - "hey details"
  - "hey trails"
  - "hey there"
  - "hey Ty"
  - "tails"
  - "they fail"
  - "hey tail end"

model:
  model_type: conv_attention
  model_size: small
steps: 50000
target_fp_per_hour: 0.2

data_dir: ./data
output_dir: ./output_hey_tails
```

Both use `conv_attention`, which is the head the comparison table above is
about. `dnn` exists and is what openWakeWord uses; it is the worse row.

---

## Running it

```bash
!livekit-wakeword run tails.yaml
```

That runs all four stages in order. To watch them separately, or to re-run one
after a failure:

```bash
!livekit-wakeword generate tails.yaml   # TTS synthesis + adversarial negatives
!livekit-wakeword augment  tails.yaml   # augmentation + feature extraction
!livekit-wakeword train    tails.yaml   # 3-phase adaptive training
!livekit-wakeword export   tails.yaml   # ONNX
!livekit-wakeword eval     tails.yaml   # DET curve, AUT, false positives per hour
```

Then the same five with `hey_tails.yaml`.

### What a good run looks like

- **generate** — the longest stage after the download. Piper synthesises 25,000
  positive clips across ~900 speaker blends and three speaking rates. Expect
  tens of minutes and a lot of progress output.
- **augment** — reverb, background mixing, feature extraction. Quieter.
- **train** — three phases, 50,000 steps, loss falling and then flattening.
- **export** — near-instant.
- **eval** — prints AUT, false positives per hour, recall, and an **optimal
  threshold**. Write that number down; see [Bringing it back](#bringing-it-back).

### What a failed run looks like

- **Out of disk.** 17 GB of download plus generated audio. Check before
  starting; the stages are resumable, so a failure here costs the download and
  not the run.
- **`UnicodeEncodeError` before anything happens** — `PYTHONUTF8=1` was not set.
  See [Setup](#setup).
- **Training on the CPU.** If `torch.__version__` has no `+cu124`, pip resolved
  the CPU wheel. Reinstall from the PyTorch index.
- **CUDA out of memory** during `generate` — lower `tts_batch_size` from 50 to
  25.
- **Loss flat from step zero** — almost always a phrase/config typo, so the
  positives and negatives are the same thing. Check `target_phrases`.

---

## Bringing it back

Each run leaves an ONNX file in its `output_dir` — around 200 KB. Download both.

Put them here, renaming to match what the app expects:

```
~/.tails/models/wake/tails.onnx        # from output_tails/
~/.tails/models/wake/hey_tails.onnx    # from output_hey_tails/
```

On Windows that is `C:\Users\<you>\.tails\models\wake\`.

The two shared front-end graphs — `melspectrogram.onnx` and
`embedding_model.onnx` — are already downloaded if any wake word has been
installed from Settings. If not, install one there first, or the app will report
the models as missing.

Restart the app, open **Settings → Voice**, and the wake word will show as
installed with a toggle instead of a download button.

### Then tell me the eval numbers

Paste the `eval` output for both phrases — specifically **false positives per
hour** and the **optimal threshold**. The app currently ships `tails` with a
placeholder threshold of **0.85**, chosen to be cautious rather than measured. It
should be replaced with the real one.

For reference, livekit's own conv-attention model landed on 0.68 for a
distinctive two-word phrase. A bare common word should end up higher.

I will also run a false-accept pass here against the confusables — *fails,
sales, tales, bales, details, "heads or tails", "tails off"* and the app's name
in ordinary conversation — and report both phrases side by side, so the choice
between them is made on numbers rather than on preference.
