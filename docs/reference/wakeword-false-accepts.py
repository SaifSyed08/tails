"""
Does the wake word fire on things that are not the wake word?

This is the measurement that decides `tails`. The phrase is four phonemes and
one syllable, under the published floor of six and two, and it rhymes with a
lot of ordinary English — so the question is not "does it detect the phrase",
which any trained model will, but "how close do the near misses get".

`eval` inside livekit-wakeword answers a different and more general question:
false positives per hour against a large negative corpus. That number matters
and is reported by the trainer. This answers the specific one: given *these*
words, said deliberately, how high does the score go. A model with an excellent
FPPH can still be unusable if the app's own name reliably lands at 0.9.

Every clip is synthesised locally with the Windows voices, and the same clips
are scored against every model, so the phrases are compared on identical audio.

Usage:
    python false_accepts.py tails.onnx [hey_tails.onnx ...]
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np

WAKE_DIR = Path.home() / ".tails" / "models" / "wake"
SAMPLE_RATE = 16000

# The audio has to be long enough for the classifier to produce any score at
# all: 76 mel frames to fill the first embedding window plus fifteen hops of
# eight, which is about two seconds. A bare word is shorter than that, so every
# clip is padded — a short clip scoring zero would otherwise read as a model
# that never fires.
WARMUP_SECONDS = 2.5

POSITIVES = [
    "tails",
    "TAILS",
    "hey tails",
]

# The near misses, in the order they are likely to matter. Rhymes first, then
# the word inside ordinary sentences, then the app's own name in conversation —
# which is the case that will actually bite, because it gets said aloud
# constantly while the app is open and listening.
NEGATIVES = [
    "fails",
    "sales",
    "tales",
    "bales",
    "gales",
    "whales",
    "trails",
    "details",
    "retails",
    "tail",
    "the tail end",
    "tails off",
    "heads or tails",
    "it fails every time",
    "for sale",
    "tell tales",
    "open tails",
    "using tails",
    "tails app",
    "the tails app is running",
    "I am building tails",
    "check the tails window",
    # Ordinary speech with no relationship to the phrase, as a floor.
    "what is the weather today",
    "run the tests again please",
]

VOICES = ["Microsoft David Desktop", "Microsoft Zira Desktop"]


def synthesise(text: str, voice: str, path: Path) -> None:
    """One clip, via the Windows synthesiser, padded to the warm-up length."""
    script = f"""
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('{voice}')
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo({SAMPLE_RATE}, `
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, `
  [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile('{path}', $fmt)
$s.Speak('{text}')
$s.SetOutputToNull()
$s.Dispose()
"""
    subprocess.run(
        ["powershell", "-NoProfile", "-Command", script],
        check=True, capture_output=True,
    )


def read_padded(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as handle:
        raw = handle.readframes(handle.getnframes())
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0

    # Silence in front rather than behind: the phrase should arrive once the
    # window is already full, which is what happens when somebody speaks into a
    # microphone that has been open.
    pad = int(WARMUP_SECONDS * SAMPLE_RATE)
    return np.concatenate([np.zeros(pad, dtype=np.float32), audio])


def peak_score(model, audio: np.ndarray) -> float:
    """The highest score anywhere in the clip, which is what a gate would see."""
    scores = model(audio)
    return float(np.max(scores)) if len(scores) else 0.0


class Scorer:
    """The app's own front end plus one classifier head."""

    def __init__(self, classifier: Path):
        import onnxruntime as ort

        from livekit.wakeword.models.feature_extractor import (
            MelSpectrogramFrontend,
            SpeechEmbedding,
        )

        self.mel = MelSpectrogramFrontend(WAKE_DIR / "melspectrogram.onnx")
        self.emb = SpeechEmbedding(WAKE_DIR / "embedding_model.onnx")
        self.head = ort.InferenceSession(str(classifier), providers=["CPUExecutionProvider"])
        self.input_name = self.head.get_inputs()[0].name

    def __call__(self, audio: np.ndarray) -> np.ndarray:
        features = self.emb.extract_embeddings(self.mel(audio[np.newaxis, :]))[0]
        if features.shape[0] < 16:
            return np.zeros(0, dtype=np.float32)

        # Every 16-embedding window, exactly as the app's Worker does.
        out = []
        for start in range(features.shape[0] - 15):
            window = features[start : start + 16][np.newaxis, :, :].astype(np.float32)
            out.append(self.head.run(None, {self.input_name: window})[0].ravel()[0])
        return np.array(out, dtype=np.float32)


def main() -> None:
    models = [Path(arg) for arg in sys.argv[1:]]
    if not models:
        raise SystemExit(__doc__)
    for model in models:
        if not model.exists():
            raise SystemExit(f"missing {model}")

    scorers = {model.stem: Scorer(model) for model in models}

    with tempfile.TemporaryDirectory() as tmp:
        clips: dict[str, np.ndarray] = {}
        for phrase in POSITIVES + NEGATIVES:
            for voice in VOICES:
                path = Path(tmp) / f"{abs(hash((phrase, voice)))}.wav"
                synthesise(phrase, voice, path)
                clips[f"{phrase}|{voice.split()[1]}"] = read_padded(path)

        name_width = max(len(k) for k in clips) + 2
        header = "phrase".ljust(name_width) + "".join(n.ljust(14) for n in scorers)
        print(header)
        print("-" * len(header))

        def report(section: str, phrases: list[str]) -> dict[str, float]:
            print(f"\n{section}")
            worst: dict[str, float] = {name: 0.0 for name in scorers}
            for phrase in phrases:
                for key, audio in clips.items():
                    if not key.startswith(f"{phrase}|"):
                        continue
                    row = key.ljust(name_width)
                    for name, scorer in scorers.items():
                        score = peak_score(scorer, audio)
                        worst[name] = max(worst[name], score)
                        row += f"{score:.3f}".ljust(14)
                    print(row)
            return worst

        report("POSITIVES — these must score high", POSITIVES)
        worst = report("NEGATIVES — these must not", NEGATIVES)

        print("\nworst false accept:")
        for name, score in worst.items():
            print(f"  {name:<16}{score:.3f}")
        print(
            "\nA threshold has to sit above every negative and below every positive. "
            "If those two ranges overlap, the phrase is not usable at any threshold "
            "and the two-word form is the answer."
        )


if __name__ == "__main__":
    main()
