import React, { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import {
  prefersReducedMotion,
  readDuration,
  readStaggerDelay,
  watchReducedMotion,
} from '@/theme/motion';

/**
 * The entrance gestures available, mapped to Tailwind animations.
 *
 * A closed set rather than free-form class names, so every entrance in the app
 * is one of a handful of recognisable movements — the point of a motion system
 * is that the user learns what a movement means.
 */
const REVEAL_ANIMATIONS = {
  rise: 'animate-rise-in',
  fade: 'animate-fade-in',
  scale: 'animate-scale-in',
  slide: 'animate-slide-in-right',
} as const;

type RevealVariant = keyof typeof REVEAL_ANIMATIONS;

/** Tracks the OS reduced-motion preference reactively. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => prefersReducedMotion());
  useEffect(() => watchReducedMotion(setReduced), []);
  return reduced;
}

type RevealProps = {
  children: React.ReactNode;
  variant?: RevealVariant;
  delayMs?: number;
  className?: string;
  as?: 'div' | 'li' | 'section' | 'span';
};

/**
 * Animates its children in once, on mount.
 *
 * Used wherever something appears in response to the user or the agent, so
 * those arrivals read as the interface responding rather than as a repaint.
 */
export function Reveal({
  children,
  variant = 'rise',
  delayMs = 0,
  className,
  as: Element = 'div',
}: RevealProps) {
  const reduced = useReducedMotion();

  return (
    <Element
      className={cn(!reduced && REVEAL_ANIMATIONS[variant], className)}
      style={reduced || delayMs === 0 ? undefined : { animationDelay: `${delayMs}ms` }}
    >
      {children}
    </Element>
  );
}

type StaggerProps = {
  children: React.ReactNode;
  variant?: RevealVariant;
  className?: string;
  as?: 'div' | 'ul' | 'section';
};

/** Reveals children one after another on a shared, capped ramp. */
export function Stagger({ children, variant = 'rise', className, as: Element = 'div' }: StaggerProps) {
  const items = React.Children.toArray(children);

  return (
    <Element className={className}>
      {items.map((child, index) => (
        <Reveal
          key={(child as React.ReactElement)?.key ?? index}
          variant={variant}
          delayMs={readStaggerDelay(index)}
        >
          {child}
        </Reveal>
      ))}
    </Element>
  );
}

type AnimatedNumberProps = {
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
};

/**
 * Counts from the previously displayed value to the current one.
 *
 * A number that visibly moves tells the user it changed; one that silently
 * swaps does not, and a dashboard that updates itself needs the difference to
 * be noticeable.
 */
export function AnimatedNumber({
  value,
  decimals = 0,
  prefix = '',
  suffix = '',
  className,
}: AnimatedNumberProps) {
  const reduced = useReducedMotion();
  const [tweened, setTweened] = useState(value);
  // Held in a ref so a tween started mid-flight reads the value actually on
  // screen, not the one the last render committed.
  const displayedRef = useRef(value);
  const frameRef = useRef<number | undefined>(undefined);

  // When there is nothing to animate the target is rendered directly rather
  // than pushed through state — writing state from an effect just to land on a
  // value we already have causes an extra render for no benefit.
  const shouldTween = !reduced && Number.isFinite(value);
  const displayed = shouldTween ? tweened : value;

  useEffect(() => {
    if (!shouldTween) {
      displayedRef.current = value;
      return undefined;
    }

    const from = displayedRef.current;
    const distance = value - from;
    if (distance === 0) return undefined;

    const durationMs = readDuration('reflow');
    const startedAt = performance.now();

    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / durationMs);
      // Cubic ease-out, close enough to the `enter` curve that a counting
      // number and a rising card read as the same gesture.
      const eased = 1 - (1 - progress) ** 3;
      const next = from + distance * eased;
      displayedRef.current = next;
      setTweened(next);
      if (progress < 1) frameRef.current = requestAnimationFrame(step);
    };

    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    };
  }, [value, shouldTween]);

  return (
    <span className={cn('tabular-nums', className)}>
      {prefix}
      {displayed.toFixed(decimals)}
      {suffix}
    </span>
  );
}

type AttentionPulseProps = {
  children: React.ReactNode;
  /**
   * Changing this replays the pulse. Callers pass something identifying the
   * event — a revision number, a match id — rather than a boolean, so two
   * consecutive events both animate.
   */
  trigger: string | number;
  className?: string;
};

/**
 * Pulses its children once whenever `trigger` changes.
 *
 * Two beats and self-terminating: a panel that flashes forever stops being a
 * signal within about a minute.
 */
export function AttentionPulse({ children, trigger, className }: AttentionPulseProps) {
  const reduced = useReducedMotion();
  const [pulseKey, setPulseKey] = useState(0);
  const previousTrigger = useRef(trigger);

  useEffect(() => {
    if (previousTrigger.current === trigger) return;
    previousTrigger.current = trigger;
    setPulseKey((current) => current + 1);
  }, [trigger]);

  return (
    <div
      // Remounting restarts the CSS animation; without it a second event on
      // the same element would not replay.
      key={pulseKey}
      className={cn(!reduced && pulseKey > 0 && 'animate-attention-pulse', className)}
    >
      {children}
    </div>
  );
}

type GrowBarProps = {
  /** Fill fraction 0..1; values outside the range are clamped. */
  fraction: number;
  delayMs?: number;
  className?: string;
};

/** A bar that draws itself from its own baseline. */
export function GrowBar({ fraction, delayMs = 0, className }: GrowBarProps) {
  const reduced = useReducedMotion();
  const clamped = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));

  return (
    <div
      className={cn('h-full rounded-full bg-primary', !reduced && 'origin-left animate-grow-x', className)}
      style={{
        width: `${clamped * 100}%`,
        animationDelay: reduced || delayMs === 0 ? undefined : `${delayMs}ms`,
      }}
    />
  );
}
