"""
What feature extraction actually costs on this machine.

`docs/WAKE-WORD-TRAINING.md` sends this job to Colab on the strength of a
contributor's report of ~14 hours of CPU feature extraction. That number was
never reproduced here, and the decision it drives — 17 GB downloaded into
somebody else's runtime instead of onto a machine with an RTX 4060 in it — is
expensive enough to be worth measuring rather than inheriting.

The pipeline is two frozen ONNX graphs per clip:

    audio -> melspectrogram.onnx -> (frames, 32)
    76-frame windows -> embedding_model.onnx -> (n_windows, 96)

For a 2-second clip that is one mel call and one embedding call, because a
2-second clip yields 16 windows and the embedding stage already batches 64 at a
time. So the cost per clip is two ONNX invocations, and the whole question is
how long those take.

Run:  .venv/Scripts/python.exe bench_features.py
"""

from __future__ import annotations

import time
from pathlib import Path

import numpy as np

CLIP_SECONDS = 2.0
SAMPLE_RATE = 16000
CLIPS = 200

# The same two graphs the app itself uses, already on disk because a wake word
# has been installed from Settings. Using these rather than the copies
# livekit-wakeword ships keeps the measurement about the models that will
# actually run.
WAKE_DIR = Path.home() / ".tails" / "models" / "wake"


def main() -> None:
    from livekit.wakeword.models.feature_extractor import (
        MelSpectrogramFrontend,
        SpeechEmbedding,
    )

    mel_path = WAKE_DIR / "melspectrogram.onnx"
    emb_path = WAKE_DIR / "embedding_model.onnx"
    for path in (mel_path, emb_path):
        if not path.exists():
            raise SystemExit(f"missing {path} - install a wake word from Settings first")

    mel = MelSpectrogramFrontend(mel_path)
    emb = SpeechEmbedding(emb_path)

    rng = np.random.default_rng(0)
    audio = rng.standard_normal((CLIPS, int(CLIP_SECONDS * SAMPLE_RATE))).astype(np.float32) * 0.1

    # Warm up: the first call pays for graph optimisation and arena allocation,
    # and including it would make a 200-clip average mostly measure startup.
    warm = mel(audio[:1])
    emb.extract_embeddings(warm)

    started = time.perf_counter()
    frames = mel(audio)
    mel_seconds = time.perf_counter() - started

    started = time.perf_counter()
    features = emb.extract_embeddings(frames)
    emb_seconds = time.perf_counter() - started

    total = mel_seconds + emb_seconds
    per_clip_ms = total / CLIPS * 1000

    print(f"clips                 {CLIPS} x {CLIP_SECONDS}s")
    print(f"feature shape         {features.shape}")
    print(f"mel                   {mel_seconds:.2f}s  ({mel_seconds / CLIPS * 1000:.1f} ms/clip)")
    print(f"embedding             {emb_seconds:.2f}s  ({emb_seconds / CLIPS * 1000:.1f} ms/clip)")
    print(f"total                 {per_clip_ms:.1f} ms/clip")

    # What the real run costs. 25,000 positives plus roughly as many adversarial
    # negatives plus 2,000 backgrounds, for each of two phrases.
    for label, clips in (("one phrase (~52k clips)", 52_000), ("both phrases", 104_000)):
        hours = clips * per_clip_ms / 1000 / 3600
        print(f"{label:<22}{hours:.2f} h")


if __name__ == "__main__":
    main()
