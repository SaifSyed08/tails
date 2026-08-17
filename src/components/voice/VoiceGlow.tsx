import { useEffect, useRef, useState } from 'react';

import type { VoiceModeState } from '@/components/chat/voice-contract';
import { useReducedMotion } from '@/shared/ui/Motion';

/**
 * The amber inner glow the chat wears while voice mode is listening.
 *
 * ## Why the whole stage and not the composer
 *
 * Because the wake word is not a text-entry event. Pressing the microphone is
 * something you do *to the input box*, and a highlight on the box is the right
 * scale for it. Saying the wake word switches the whole app into a different
 * conversation — it will send on its own and answer out loud — and lighting
 * the entire surface is the only treatment that reads as a mode rather than a
 * field state. It is also the one the user asked for.
 *
 * ## Amber, fixed
 *
 * Not `--primary`, not `--warning`. Those move with the theme, and this glow
 * has to mean one thing — *the microphone is capturing you right now* —
 * everywhere. A recording indicator that is amber in one theme and violet in
 * another is not an indicator. It is the single place in this app where a
 * hard-coded hue is the correct choice, and the reason is that its meaning is
 * about the hardware, not about the look.
 */
const AMBER = '38 94% 56%';

/**
 * How fast the glow chases the input level.
 *
 * The level itself is published about eight times a second, which is visibly
 * steppy if fed straight to a shadow. This is a one-pole filter: each frame
 * moves a fixed fraction of the remaining distance, so a shout arrives quickly
 * and a pause decays smoothly. Asymmetric on purpose — rising is nearly
 * immediate because it is the responsiveness the user reads as "it hears me",
 * falling is slower because a glow that snaps to black between syllables
 * flickers.
 */
const RISE = 0.45;
const FALL = 0.09;

/** Below this the glow is not drawn at all, so silence is genuinely dark. */
const FLOOR = 0.02;

export function VoiceGlow({ voice }: { voice: VoiceModeState | undefined }) {
  const reduced = useReducedMotion();
  const [smoothed, setSmoothed] = useState(0);
  const valueRef = useRef(0);
  const frameRef = useRef<number | undefined>(undefined);

  /*
    Lit only while voice mode is actually capturing. Dictation gets no glow:
    it has its own, smaller indicator on the button, and the two modes have to
    look different or the distinction that matters — one of them sends — stops
    being visible.
  */
  const active = voice?.intent === 'voice'
    && (voice.mode === 'listening' || voice.mode === 'transcribing');
  const target = active ? (voice?.level ?? 0) : 0;

  useEffect(() => {
    const step = () => {
      const current = valueRef.current;
      const rate = target > current ? RISE : FALL;
      const next = current + (target - current) * rate;
      valueRef.current = Math.abs(next - target) < 0.002 ? target : next;
      setSmoothed(valueRef.current);
      frameRef.current = requestAnimationFrame(step);
    };

    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    };
  }, [target]);

  if (smoothed < FLOOR) return null;

  /*
    A resting glow plus a level-driven one. Without the floor the edge
    disappears completely between words, and an indicator that blinks off
    while the microphone is still open is exactly the lie this app must not
    tell — so the base term says "capturing" and the variable term says
    "hearing you".
  */
  const intensity = reduced ? 0.45 : smoothed;
  const spread = 14 + intensity * 52;
  const alpha = 0.2 + intensity * 0.45;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-20"
      style={{
        boxShadow: [
          `inset 0 0 ${spread}px ${spread * 0.28}px hsl(${AMBER} / ${alpha})`,
          `inset 0 0 ${spread * 2.4}px hsl(${AMBER} / ${alpha * 0.35})`,
        ].join(', '),
        // The transition covers the gap between animation frames on a slow
        // machine; the smoothing above is what actually shapes the motion.
        transition: 'box-shadow 60ms linear',
      }}
    />
  );
}
