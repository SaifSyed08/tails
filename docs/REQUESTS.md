# Open requests

Saif's outstanding asks, in his words where it matters. Kept here rather than in
a chat scrollback so nothing gets dropped between sessions. Numbering continues
the informal list used in conversation.

## Voice

- [x] **V1 — dictation never reaches the input box.** Text is transcribed but no
      words land in the composer.
- [x] **V2 — wake word does nothing.** No reaction when the phrase is spoken.
- [x] **V3 — no wake-word VFX.** Detection is invisible.
- [x] **V4 — no first-run prompt.** Nothing tells you to say the wake word the
      first time voice mode is switched on.
- [x] **V5 — dictation and voice mode look identical.** They are different
      modes and must read differently. Voice mode: loud on first activation
      (`Voice mode on — say "tails"`), subtle-but-obvious afterwards, coloured
      like the `/personalize` slash-command text.
- [x] **V6 — wake-word VFX.** On detection the whole chat interface section
      gets an animated amber inner glow that reacts to voice level, plus a
      subtle sound effect.
- [x] **V7 — brevity steer.** A spoken prompt carries a hidden instruction to
      keep the answer short and conversational (no headings, no bullets).
- [x] **V8 — speak the reply.** Stream the answer to TTS in ~3-sentence chunks
      as it arrives rather than waiting for the turn to finish.
- [x] **V9 — auto-send.** Voice mode sends on end-of-speech; plain dictation
      never does — it only fills the box.

## Pets

- [x] **P1 — unusable desktop pet after navigating.** Show pet, set out of
      window, open a chat with a pet in the interface (do not drag him out),
      then go to another chat / marketplace / new chat: he reappears out of
      window but cannot be used.
- [x] **P2 — pill clipped by the ground.** The enlarged hover pill is cut off
      when the pet stands on the chat interface floor.
- [x] **P3 — X button hides him permanently.** Dismissing the desktop pet with
      the close button leaves him hidden even after hide/unhide from the
      marketplace. Suggested fix: force visibility on "put pet on screen", and
      treat repeated hide/unhide within a short window as a recall.
- [x] **P4 — sidebar pet placement.** The pet on a session row belongs at the
      far right where the options button sits. The options icon appears only on
      hover, shifting the pet left. Today there is dead space at the right edge.
- [x] **P5 — carousel edit opens the wrong panel.** Edit should open pet
      *settings*, not the marketplace detail view. Left-click and right-click on
      a carousel pet should open the same panel. Pet settings needs a large
      **Dock to chat interface** button above sheet / animations / added date
      whenever he is currently out of window.

All fourteen landed in `4102077` (voice) and `b34625b` (pets). What is left
below needs something only Saif can do, or is queued behind it.

## Carried over

- [x] **#54** — wake word: both `tails` and `hey tails` trained locally on the
      4060 and measured against the confusables. `tails` is unusable at any
      threshold — seven negatives at or above the wake word, `tails off` at
      0.982 and `tails app` at 0.979. `hey_tails` separates by 0.012 at a
      threshold of 0.93. Both ship; see `WAKE-WORD-TRAINING.md` for the tables.
- [x] **#28** — the duplicate window background hex, removed when the window
      became transparent for Aurora's acrylic backdrop.
- [ ] **#23** — bundle the fonts rather than relying on the system.

## Newer asks

- [x] Right-click text for copy / cut / paste.
- [x] Pet's assigned theme actually applies — it was stored and persisted all
      along and nothing on the client read it.
- [x] Theme and thinking phrases reachable from the pet settings panel.
- [x] Preview browser the agent can open (`preview_open`), loopback only,
      closable by the user.
- [x] The duplicate settings button in the header, removed.
- [x] Voice-mode steer cut to one sentence, and stopped leaking into the
      transcript — the SDK's echo of the expanded prompt was being rendered.
- [x] Duplicated messages, and the doubled streaming output. Two separate
      faults: an append-only consumer of a replaying protocol, then the same
      thing again for stream deltas, which accumulate rather than re-render.
- [x] Drafts leaking between conversations — the composer was never remounted,
      so unsent text followed you into every chat.

## Open, and needing Saif

- [ ] **Local voice: what goes?** He wants it ditched for now on quality
      grounds, with BYO OpenAI Whisper later — but Whisper is dictation only,
      so it is unclear whether Piper TTS and the trained wake words go with it.
      Three options on the table: dictation only, all of it, or keep it working
      but ship nothing in the installer. The duplicate default-voice section in
      Settings is blocked on the same answer.
- [ ] **The sidebar pet position.** Reported still wrong. The code now renders
      the options button first inside a right-anchored container, collapsed to
      zero width until hover, with the pet last — which should already do what
      was asked. Needs a look rather than a second blind change.
- [ ] **Unusable desktop pet, sixth route.** Put on screen, open a chat with a
      pet in the interface, then any non-pet chat. The shell invariant holds on
      15 harness paths including that sequence, so the cause is app-side.
- [ ] **Kokoro for pets.** Decided, not built. It runs on the `onnxruntime-web`
      already bundled, so it needs no new runtime — but a pet line would land
      ~2.4 s after the trigger, and pets react, which makes them the most
      timing-sensitive thing in the app rather than the least.
