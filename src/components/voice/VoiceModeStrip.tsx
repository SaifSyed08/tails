import { AudioLines, Loader2, TriangleAlert, Volume2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { COMMAND_STYLES } from '@/components/chat/commandStyle';
import { listPhrases, type VoiceModeState } from '@/components/chat/voice-contract';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/shared/ui/Motion';

/**
 * What voice mode is doing, said out loud on screen.
 *
 * ## The bug this exists to fix
 *
 * Voice mode could be switched on and then gave no sign of itself whatsoever.
 * There was no way to learn that a wake word was expected, no way to learn
 * which one, and — when nothing was armed — no way to learn that the feature
 * was on but had nothing to listen for. The microphone button showed a state,
 * but a button is not where you look to find out what to *say*.
 *
 * ## Loud once, quiet after
 *
 * The first time is a teaching moment and gets the full treatment, including
 * the phrase read aloud, because someone who has just turned this on does not
 * yet know a wake word is involved. Every time after that it is one line: the
 * user knows, and a banner that keeps explaining itself becomes something you
 * stop seeing. That is the point at which an indicator fails.
 *
 * The phrase itself wears the `/personalize` sweep. It is reused rather than
 * re-invented because it already means "this is the app's own voice speaking
 * to you" everywhere else it appears.
 */

const SEEN_KEY = 'tails.voice.introSeen';

function readSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // A blocked localStorage costs a repeated introduction, nothing more.
  }
}

/** The wake phrase, wearing the rainbow. */
function Phrase({ children }: { children: React.ReactNode }) {
  const reduced = useReducedMotion();
  return (
    <span
      className={cn('bg-clip-text font-semibold text-transparent', !reduced && 'animate-shimmer')}
      style={{
        backgroundImage: COMMAND_STYLES.personalize.gradient,
        backgroundSize: '200% 100%',
      }}
    >
      {children}
    </span>
  );
}

type Props = {
  voice: VoiceModeState | undefined;
  /**
   * Reads the introduction aloud, once.
   *
   * Passed in rather than reached for directly: the synthesiser is shared with
   * pets and with spoken replies, and two owners of one `speechSynthesis`
   * queue would cut each other off.
   */
  onSpeakIntro?: (text: string) => void;
};

export function VoiceModeStrip({ voice, onSpeakIntro }: Props) {
  const on = voice?.intent === 'voice';
  const phrases = listPhrases(voice?.armedLabels ?? []);

  /*
    Whether this activation gets the full introduction.

    Decided at the moment voice mode is switched on and then held for as long
    as it stays on. It cannot be read from storage on each render, because the
    effect below marks it seen — the banner would flip from the introduction to
    the one-liner while the user was still reading it.

    Adjusted during render rather than from an effect. This is React's own
    pattern for state derived from a prop *change*: it re-renders immediately,
    before anything is painted, where an effect would show one frame of the
    wrong banner first.
  */
  const [wasOn, setWasOn] = useState(false);
  const [firstRun, setFirstRun] = useState(false);
  if (on !== wasOn) {
    setWasOn(on);
    setFirstRun(on ? !readSeen() : false);
  }

  // The announcement is a side effect and stays in an effect. It is bound to
  // switching voice mode on, not to mounting: navigating between chats
  // remounts this and must not say anything.
  useEffect(() => {
    if (!on || !firstRun) return;
    markSeen();
    onSpeakIntro?.(phrases
      ? `Voice mode is on. Say ${phrases} when you want me.`
      : 'Voice mode is on, but no wake word is turned on yet.');
  }, [on, firstRun, phrases, onSpeakIntro]);

  if (!voice || !on) return null;

  // Nothing armed is the one case that has to be loud every time, because the
  // feature genuinely cannot work and the fix is two clicks away. Reporting it
  // as a quiet "on" would be the app claiming to listen when it cannot.
  if (voice.armed.length === 0) {
    return (
      <Frame tone="warning">
        <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
        <span>
          Voice mode is on, but no wake word is armed. Turn one on in{' '}
          <span className="font-medium text-foreground">Settings → Voice</span>, or press the
          microphone to dictate.
        </span>
      </Frame>
    );
  }

  if (voice.mode === 'listening') {
    return (
      <Frame tone="live">
        <AudioLines className="size-3.5 shrink-0 animate-pulse" aria-hidden="true" />
        <span>Listening — this sends when you stop talking.</span>
        <Meter level={voice.level} />
      </Frame>
    );
  }

  if (voice.mode === 'transcribing') {
    return (
      <Frame tone="live">
        <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
        <span>Working out what you said…</span>
      </Frame>
    );
  }

  if (voice.mode === 'speaking') {
    return (
      <Frame tone="live">
        <Volume2 className="size-3.5 shrink-0" aria-hidden="true" />
        <span>Reading the reply back. Press the microphone to stop.</span>
      </Frame>
    );
  }

  if (firstRun) {
    return (
      <Frame tone="intro">
        <AudioLines className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="space-y-1">
          <span className="block text-sm font-medium text-foreground">
            Voice mode is on. Say <Phrase>{phrases}</Phrase>
          </span>
          <span className="block text-xs text-muted-foreground">
            Your message sends by itself when you stop talking, and the answer is read back to
            you. Everything stays on this machine.
            {voice.wakeReason ? ` ${voice.wakeReason}.` : ''}
          </span>
        </span>
      </Frame>
    );
  }

  // The quiet resting state. One line, the phrase still coloured so it is
  // findable at a glance, and nothing else.
  return (
    <Frame tone="idle">
      <AudioLines className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
      <span>
        Say <Phrase>{phrases}</Phrase>
        {voice.wakeReason ? (
          <span className="ml-2 text-destructive">{voice.wakeReason}</span>
        ) : null}
      </span>
    </Frame>
  );
}

/** Input level as a five-bar meter, so "it hears me" is visible, not implied. */
function Meter({ level }: { level: number }) {
  return (
    <span className="ml-auto flex items-end gap-0.5" aria-hidden="true">
      {[0.12, 0.3, 0.5, 0.7, 0.88].map((step, index) => (
        <span
          key={step}
          className="w-0.5 rounded-full bg-current transition-[height,opacity] duration-100"
          style={{
            height: `${4 + index * 2}px`,
            opacity: level >= step ? 1 : 0.2,
          }}
        />
      ))}
    </span>
  );
}

const TONES = {
  intro: 'items-start gap-2.5 border-primary/30 bg-primary/5 px-3 py-2.5 text-muted-foreground',
  live: 'items-center gap-2 border-[hsl(38_94%_56%/0.45)] bg-[hsl(38_94%_56%/0.08)] px-3 py-1.5 text-xs text-[hsl(38_80%_38%)] dark:text-[hsl(38_94%_66%)]',
  warning: 'items-center gap-2 border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs text-muted-foreground',
  idle: 'items-center gap-2 border-border/60 px-3 py-1.5 text-xs text-muted-foreground',
} as const;

function Frame({ tone, children }: { tone: keyof typeof TONES; children: React.ReactNode }) {
  return (
    <div
      // `role="status"` rather than an alert: this is state a screen reader
      // should learn about when it settles, not an interruption.
      role="status"
      className={cn('animate-fade-in flex rounded-xl border', TONES[tone])}
    >
      {children}
    </div>
  );
}
