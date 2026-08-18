import { useEffect, useRef } from 'react';

import type { VoiceModeState } from '@/components/chat/voice-contract';
import { useReducedMotion } from '@/shared/ui/Motion';

/**
 * Amber light running around the edges of the chat while voice mode listens.
 *
 * ## Why waves and not a glow
 *
 * The first version was an inset box-shadow whose intensity tracked the input
 * level. It worked, and it read as a *state* — the app is listening — but it
 * said nothing about the moment. An indicator that only brightens is
 * indistinguishable from a brightness animation: you cannot tell whether it is
 * reacting to you or to a timer.
 *
 * Travelling waves carry information that intensity cannot. Each crest is
 * launched by a peak in the input, so what you see is your own voice moving
 * away from you around the frame — talk and a crest sets off, stop and the
 * frame goes quiet while the last ones finish their lap. That is the difference
 * between a light that is on and a light that is listening.
 *
 * ## Why canvas
 *
 * Four independently animated gradients that have to stay in phase around a
 * rounded rectangle is not something CSS keyframes do well; it would be four
 * elements kept in sync by wall-clock luck, seaming at every corner. On canvas
 * the frame is one path with one parametric position along it, so a crest
 * rounds a corner without anything handing off to anything.
 *
 * It costs one `requestAnimationFrame` while capturing and nothing otherwise —
 * the loop is not started unless voice mode is actually listening.
 */

/**
 * Amber, fixed, and deliberately not a theme token.
 *
 * This signals that the microphone is capturing, and a recording indicator
 * whose colour changes with the theme is not an indicator. It is the one place
 * in this app where a hard-coded hue is correct, because its meaning is about
 * the hardware rather than about the look.
 */
const AMBER = { r: 255, g: 176, b: 32 };

/** How far a crest travels per second, as a fraction of the full perimeter. */
const WAVE_SPEED = 0.22;

/** Crest length, as a fraction of the perimeter. Wide enough to read as light. */
const WAVE_WIDTH = 0.14;

/** Crests launch no faster than this, so a loud room is not a strobe. */
const MIN_LAUNCH_MS = 260;

/** Input level below which nothing new launches. Silence stays still. */
const LAUNCH_FLOOR = 0.18;

/** A crest retires after this many laps, so the array cannot grow forever. */
const MAX_LAPS = 1.15;

type Wave = {
  /** Position along the perimeter, 0-1. */
  at: number;
  /** How loud the voice was when it launched. Drives width and brightness. */
  power: number;
  /** Distance travelled, so it can be retired after a lap. */
  travelled: number;
};

export function VoiceGlow({ voice }: { voice: VoiceModeState | undefined }) {
  const reduced = useReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wavesRef = useRef<Wave[]>([]);
  const levelRef = useRef(0);
  const lastLaunchRef = useRef(0);

  /*
    Lit only while voice mode is actually capturing. Dictation gets none of
    this: it has its own smaller indicator on the button, and the two modes
    have to look different or the distinction that matters — one of them
    sends — stops being visible.
  */
  const active = voice?.intent === 'voice'
    && (voice.mode === 'listening' || voice.mode === 'transcribing');

  /*
    The level reaches the loop through a ref rather than a dependency.

    It updates about eight times a second, and putting it in the effect's
    dependency array would tear down and rebuild the animation loop that often
    — cancelling and re-requesting the frame, and resetting the crest list
    every time the volume moved. Written from an effect rather than during
    render, which is the same thing a frame later and does not read a ref
    mid-render.
  */
  const liveLevel = active ? (voice?.level ?? 0) : 0;
  useEffect(() => { levelRef.current = liveLevel; }, [liveLevel]);

  useEffect(() => {
    if (!active) {
      wavesRef.current = [];
      return undefined;
    }

    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return undefined;

    let frame = 0;
    let previous = 0;
    let resting = 0;

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);

      const elapsed = previous ? Math.min(0.05, (now - previous) / 1000) : 0;
      previous = now;

      // Backing store in device pixels, drawing in CSS pixels. Without this
      // the whole thing is soft on any display that is not exactly 1x, which
      // on a laptop is most of them.
      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== Math.round(width * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      if (width < 8 || height < 8) return;

      const level = levelRef.current;

      /*
        One crest per peak, rate-limited.

        Launching on every frame above the floor would draw a solid band rather
        than waves. The point is that a crest is *an event*, so there has to be
        a gap between them even while someone is still talking.
      */
      if (level > LAUNCH_FLOOR && now - lastLaunchRef.current > MIN_LAUNCH_MS) {
        lastLaunchRef.current = now;
        wavesRef.current.push({ at: 0, power: Math.min(1, level * 1.3), travelled: 0 });
      }

      // Reduced motion keeps the light and drops the travel. The indicator is
      // evidence rather than decoration, so it must not disappear — but it
      // does not have to move for someone who asked the app to stop moving.
      const speed = reduced ? 0 : WAVE_SPEED;
      wavesRef.current = wavesRef.current.filter((wave) => {
        wave.at = (wave.at + speed * elapsed) % 1;
        wave.travelled += speed * elapsed;
        return wave.travelled < MAX_LAPS;
      });

      /*
        A resting band beneath the crests.

        Without it the frame goes fully dark between words, and an indicator
        that blinks off while the microphone is still open is the one lie this
        feature must not tell. It breathes with the level so it is never
        mistaken for a static border.
      */
      resting += (0.28 + level * 0.35 - resting) * 0.1;

      const inset = 1.5;
      const radius = 14;
      const box = { x: inset, y: inset, w: width - inset * 2, h: height - inset * 2 };
      const perimeter = 2 * (box.w + box.h);

      const trace = () => {
        context.beginPath();
        context.roundRect(box.x, box.y, box.w, box.h, radius);
      };

      context.lineWidth = 2;
      context.strokeStyle = `rgba(${AMBER.r}, ${AMBER.g}, ${AMBER.b}, ${0.1 + resting * 0.16})`;
      trace();
      context.stroke();

      /*
        Each crest, drawn as a dashed stroke whose single dash *is* the crest.

        This is what makes it cheap: `lineDashOffset` walks one dash-and-gap
        pattern around the path, so rounding a corner is the browser's problem
        rather than ours, and there is no seam to hide.
      */
      for (const wave of wavesRef.current) {
        const fade = 1 - wave.travelled / MAX_LAPS;
        const strength = wave.power * fade * fade;
        if (strength < 0.02) continue;

        const dash = perimeter * WAVE_WIDTH * (0.6 + wave.power * 0.6);

        context.save();
        context.setLineDash([dash, perimeter]);
        context.lineDashOffset = -wave.at * perimeter;
        context.lineCap = 'round';

        // Two passes: a wide soft one for the bloom, a tight bright one for the
        // filament. Either alone reads as a smudge or as a wire.
        context.lineWidth = 10 + wave.power * 12;
        context.shadowColor = `rgba(${AMBER.r}, ${AMBER.g}, ${AMBER.b}, ${0.5 * strength})`;
        context.shadowBlur = 22 + wave.power * 26;
        context.strokeStyle = `rgba(${AMBER.r}, ${AMBER.g}, ${AMBER.b}, ${0.16 * strength})`;
        trace();
        context.stroke();

        context.shadowBlur = 0;
        context.lineWidth = 2.5;
        context.strokeStyle = `rgba(255, 214, 140, ${0.75 * strength})`;
        trace();
        context.stroke();
        context.restore();
      }
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [active, reduced]);

  if (!active) return null;

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-20 size-full"
    />
  );
}
