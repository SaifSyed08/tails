#!/usr/bin/env bash
#
# The whole pipeline, for both phrases, with the environment it needs.
#
# Three things have to be set and each one fails differently if it is not:
#
#   PYTHONUTF8         the CLI prints Unicode through `rich`, and a cp1252
#                      console turns that into an UnicodeEncodeError before any
#                      work happens — a crash that reads as a broken install.
#   PATH               `generate` shells out to `espeak-ng` by bare name.
#   ESPEAK_DATA_PATH   an extracted espeak-ng without it does not error, it
#                      segfaults, and through subprocess.run that surfaces as
#                      an empty phonemisation rather than a failure.
#
# Stages are run separately rather than through `run` so a failure is
# attributable and resumable — re-run from the one that died.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8
export PATH="$HERE/espeak/eSpeak NG:$PATH"
# Lets the allocator give memory back rather than holding fragmented blocks,
# which is what turns a peak that only just fits into one that does not.
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
export ESPEAK_DATA_PATH="$HERE/espeak/eSpeak NG/espeak-ng-data"

PY="$HERE/.venv/Scripts/python.exe"
LOGS="$HERE/logs"
mkdir -p "$LOGS"

# Fail loudly here rather than thirty minutes into synthesis.
if ! "$HERE/espeak/eSpeak NG/espeak-ng.exe" --ipa -q -v en-us tails >/dev/null 2>&1; then
  echo "espeak-ng is not working — check ESPEAK_DATA_PATH" >&2
  exit 1
fi

# How many times a stage may resume after a crash before we call it broken.
#
# `generate` dies partway through with a bare `CUDA error: out of memory` —
# note *bare*, not PyTorch's OutOfMemoryError, which would name the allocation
# it could not satisfy. It happens with 6 GB free, at a different clip count
# every time, and lowering the batch size from 50 to 16 did not move it. That
# is exhaustion accumulating somewhere in the driver or the synthesis loop
# rather than any single allocation being too big, and it is not this project's
# bug to fix.
#
# What makes it survivable is that the stage is resumable: it counts the clips
# already on disk and carries on from there. Verified — a restart picked up at
# exactly 11,776 of 25,000. So each crash costs a process restart, not work,
# and retrying is a real fix rather than papering over one.
#
# The cap exists so a genuinely broken stage still fails instead of spinning.
MAX_RESUMES=12

stage() {
  local config="$1" name="$2" step="$3"
  local log="$LOGS/${name}-${step}.log"
  echo "=== ${name}: ${step} ==="

  local attempt=1
  while [ "$attempt" -le "$MAX_RESUMES" ]; do
    # Through the cached wrapper, not the CLI directly. `generate` otherwise
    # spawns espeak-ng once per clip and Windows starts returning 0xC0000142
    # after a few hundred of them.
    if "$PY" "$HERE/train_cached.py" "$step" "$config" >>"$log" 2>&1; then
      echo "ok ${name}/${step}$([ "$attempt" -gt 1 ] && echo " (after $attempt attempts)")"
      return 0
    fi

    # Only the crash we know is resumable. Anything else is a real failure and
    # retrying it would just hide the reason twelve times over.
    if ! tail -40 "$log" | grep -q "CUDA error: out of memory"; then
      echo "FAILED ${name}/${step} — last lines of $log:" >&2
      tail -20 "$log" >&2
      return 1
    fi

    echo "   resuming ${name}/${step} after CUDA OOM (attempt ${attempt})"
    attempt=$((attempt + 1))
    # A moment for the driver to reclaim before asking again.
    sleep 10
  done

  echo "FAILED ${name}/${step} — still failing after ${MAX_RESUMES} resumes" >&2
  tail -20 "$log" >&2
  return 1
}

for phrase in "${@:-tails hey_tails}"; do
  config="$HERE/${phrase}.yaml"
  [ -f "$config" ] || { echo "no config $config" >&2; continue; }

  for step in generate augment train export eval; do
    stage "$config" "$phrase" "$step" || break
  done

  # The number this whole exercise exists to produce.
  echo "--- ${phrase} eval ---"
  tail -30 "$LOGS/${phrase}-eval.log" 2>/dev/null || echo "(no eval output)"
done
