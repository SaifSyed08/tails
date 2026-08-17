"""
The trainer, with phonemisation batched and cached.

## The failure this works around

`generate` phonemises by launching `espeak-ng.exe` **once per clip**, from
inside the per-batch list comprehension in `synthesis.py`:

    phoneme_ids = [get_phonemes(config, t, voice) for t in batch_texts]

On Windows that dies. After enough launches espeak-ng starts returning
**0xC0000142** (`STATUS_DLL_INIT_FAILED`) — new processes can no longer
initialise their DLLs — and five consecutive failures abort the run. The exit
code is what identifies it: a bad path or argument fails on the *first* call,
and this one succeeds hundreds of times first. Only exhaustion behaves that
way.

## Two fixes, because one was not enough

The first attempt cached by phrase. That fixed synthesis of the *positives* —
25,000 clips of "tails" are two distinct strings — and the run got 50× further
before dying on `trackballs`, one of the thousands of *distinct* adversarial
negatives the generator invents. Caching cannot help a set whose members are
all different, so the spawn count came back and so did the crash.

The second fix is the one that actually addresses it: phonemise the whole
adversarial list in **one** launch, up front, and seed the cache with the
results. espeak-ng will read a file of phrases and emit one line per phrase —
but only if each line ends in sentence punctuation, otherwise it runs them all
together on a single line and the mapping back is lost. That detail is the
whole trick.

Between them: two launches for the positives, one for every negative, and a
per-phrase fallback for anything that slips through.

## Why a wrapper and not an edit to site-packages

So the installed package stays exactly what PyPI shipped, the change is
reviewable as one file, and an upgrade cannot silently drop it — the
assertions below fail loudly instead.

    python train_cached.py generate tails.yaml
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

from livekit.wakeword.data import generate as generate_module
from livekit.wakeword.data.piper import synthesis

_original_phonemize = synthesis._espeak_phonemize
_original_adversarial = generate_module.generate_adversarial_phrases

assert callable(_original_phonemize), "synthesis._espeak_phonemize is gone — patch needs updating"
assert callable(_original_adversarial), "generate_adversarial_phrases is gone — patch needs updating"

# A plain dict rather than lru_cache, because the point is to *insert* results
# computed elsewhere, which lru_cache has no way to accept.
_cache: dict[tuple[str, str], str] = {}
_stats = {"hits": 0, "single": 0, "batched": 0, "batch_calls": 0}


def _espeak_binary() -> str:
    from shutil import which

    found = which("espeak-ng")
    if not found:
        raise FileNotFoundError("espeak-ng is not on PATH")
    return found


def phonemize(text: str, voice: str = "en-us") -> str:
    """One phrase. Served from the cache when the batch pass already did it."""
    key = (text, voice)
    cached = _cache.get(key)
    if cached is not None:
        _stats["hits"] += 1
        return cached

    _stats["single"] += 1
    result = _original_phonemize(text, voice)
    _cache[key] = result
    return result


def prewarm(phrases: list[str], voice: str = "en-us") -> None:
    """
    Phonemises every phrase in one espeak-ng launch and seeds the cache.

    Best effort throughout. If the batch disagrees with the input on line count
    — which would mean the phrase-to-result mapping is not trustworthy — the
    whole batch is discarded and every phrase falls back to its own launch.
    A wrong phoneme string is far worse than a slow run: it would train the
    model on the wrong sound and the failure would only show up as a wake word
    that does not work well, months later, with nothing pointing here.
    """
    fresh = [p for p in dict.fromkeys(phrases) if (p, voice) not in _cache]
    if not fresh:
        return

    try:
        # The trailing period is load-bearing. Without sentence punctuation
        # espeak-ng emits every phrase concatenated onto one line, and since
        # phrases contain spaces themselves there is no way to split it back.
        with tempfile.NamedTemporaryFile(
            "w", suffix=".txt", delete=False, encoding="utf-8",
        ) as handle:
            handle.write("\n".join(f"{p}." for p in fresh))
            batch_path = handle.name

        completed = subprocess.run(
            [_espeak_binary(), "-f", batch_path, "--ipa", "-q", "-v", voice],
            capture_output=True, encoding="utf-8", check=True,
        )
        lines = [line.strip() for line in completed.stdout.strip().splitlines()]

        if len(lines) != len(fresh):
            print(
                f"[prewarm] {len(lines)} results for {len(fresh)} phrases — "
                "discarding batch and falling back to one launch each",
                file=sys.stderr,
            )
            return

        for phrase, phonemes in zip(fresh, lines):
            _cache[(phrase, voice)] = phonemes
        _stats["batched"] += len(fresh)
        _stats["batch_calls"] += 1

    except Exception as error:  # noqa: BLE001 - best effort by design
        print(f"[prewarm] batch failed ({error}); falling back", file=sys.stderr)
    finally:
        try:
            os.unlink(batch_path)
        except Exception:  # noqa: BLE001
            pass


def _patched_adversarial(*args, **kwargs):
    """The hook. Thousands of distinct phrases arrive here as one list."""
    phrases = _original_adversarial(*args, **kwargs)
    prewarm(list(phrases))
    return phrases


synthesis._espeak_phonemize = phonemize
generate_module.generate_adversarial_phrases = _patched_adversarial

# Some modules bind the name at import time, so rebinding the definition alone
# is not enough to catch every caller.
for module in list(sys.modules.values()):
    if module is None:
        continue
    if getattr(module, "_espeak_phonemize", None) is _original_phonemize:
        module._espeak_phonemize = phonemize
    if getattr(module, "generate_adversarial_phrases", None) is _original_adversarial:
        module.generate_adversarial_phrases = _patched_adversarial


def _prewarm_from_config() -> None:
    """The phrases the config names, which the adversarial hook never sees."""
    if len(sys.argv) < 3:
        return
    try:
        import yaml

        with open(sys.argv[2], encoding="utf-8") as handle:
            config = yaml.safe_load(handle) or {}
        named = list(config.get("target_phrases") or []) + list(
            config.get("custom_negative_phrases") or []
        )
        # Piper lowercases before phonemising, so both forms are seeded.
        prewarm(named + [p.lower() for p in named])
    except Exception as error:  # noqa: BLE001
        print(f"[prewarm] config phrases skipped ({error})", file=sys.stderr)


def main() -> None:
    from livekit.wakeword.cli import app

    if Path(sys.argv[0]).name == "train_cached.py":
        _prewarm_from_config()

    try:
        app()
    finally:
        # Printed even on failure: it is the evidence the patch was in effect.
        # A run reporting a large `single` count did not get the benefit,
        # whatever else it says, and is heading for the same crash.
        print(
            f"\n[phonemise] {_stats['hits']} cache hits, "
            f"{_stats['batched']} phrases pre-warmed in {_stats['batch_calls']} batch "
            f"launch(es), {_stats['single']} individual launches",
            file=sys.stderr,
        )


if __name__ == "__main__":
    main()
