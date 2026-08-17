# Open requests

Saif's outstanding asks, in his words where it matters. Kept here rather than in
a chat scrollback so nothing gets dropped between sessions. Numbering continues
the informal list used in conversation.

## Voice

- [ ] **V1 — dictation never reaches the input box.** Text is transcribed but no
      words land in the composer.
- [ ] **V2 — wake word does nothing.** No reaction when the phrase is spoken.
- [ ] **V3 — no wake-word VFX.** Detection is invisible.
- [ ] **V4 — no first-run prompt.** Nothing tells you to say the wake word the
      first time voice mode is switched on.
- [ ] **V5 — dictation and voice mode look identical.** They are different
      modes and must read differently. Voice mode: loud on first activation
      (`Voice mode on — say "tails"`), subtle-but-obvious afterwards, coloured
      like the `/personalize` slash-command text.
- [ ] **V6 — wake-word VFX.** On detection the whole chat interface section
      gets an animated amber inner glow that reacts to voice level, plus a
      subtle sound effect.
- [ ] **V7 — brevity steer.** A spoken prompt carries a hidden instruction to
      keep the answer short and conversational (no headings, no bullets).
- [ ] **V8 — speak the reply.** Stream the answer to TTS in ~3-sentence chunks
      as it arrives rather than waiting for the turn to finish.
- [ ] **V9 — auto-send.** Voice mode sends on end-of-speech; plain dictation
      never does — it only fills the box.

## Pets

- [ ] **P1 — unusable desktop pet after navigating.** Show pet, set out of
      window, open a chat with a pet in the interface (do not drag him out),
      then go to another chat / marketplace / new chat: he reappears out of
      window but cannot be used.
- [ ] **P2 — pill clipped by the ground.** The enlarged hover pill is cut off
      when the pet stands on the chat interface floor.
- [ ] **P3 — X button hides him permanently.** Dismissing the desktop pet with
      the close button leaves him hidden even after hide/unhide from the
      marketplace. Suggested fix: force visibility on "put pet on screen", and
      treat repeated hide/unhide within a short window as a recall.
- [ ] **P4 — sidebar pet placement.** The pet on a session row belongs at the
      far right where the options button sits. The options icon appears only on
      hover, shifting the pet left. Today there is dead space at the right edge.
- [ ] **P5 — carousel edit opens the wrong panel.** Edit should open pet
      *settings*, not the marketplace detail view. Left-click and right-click on
      a carousel pet should open the same panel. Pet settings needs a large
      **Dock to chat interface** button above sheet / animations / added date
      whenever he is currently out of window.

## Carried over

- [ ] **#54** — wake-word model: Colab training run per
      `docs/WAKE-WORD-TRAINING.md` produces `tails.onnx`; then measure false
      accepts against *fails / sales / tales / details / "heads or tails" /
      "tails off" / "tails app"* and replace the 0.85 placeholder threshold.
- [ ] **#23** — bundle the fonts rather than relying on the system.
- [ ] **#28** — the window background hex duplicates `--background`.

## Closed

- **#59 Chatterbox nano** — 10.8 s to first audio against a 1 s bar. Not
  revisited unless asked.
