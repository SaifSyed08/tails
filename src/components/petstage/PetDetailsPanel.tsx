import { EyeOff, MessageSquare, Monitor, Volume2, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { PetSprite, type InstalledPet, type PetStateName } from '@/components/marketplace';
import { describeGrid, formatAdded, SOURCE_LABEL } from '@/components/marketplace/pet-filters';
import { resolvePetVoice } from '@/components/voice/pet-voice';
import { useSpeech } from '@/components/voice/useSpeech';
import { cn } from '@/lib/utils';

import {
  DEFAULT_VOICE,
  MAX_PET_SCALE,
  MIN_PET_SCALE,
  type PetStage,
  type PetVoice,
} from './chat-pet-api';

/**
 * The pet's own page, opened from his pill.
 *
 * What the marketplace's detail dialog is for a pet you are *choosing*, this is
 * for the pet you already have standing next to you: who he is, how his sheet
 * is cut, what he can do — playable rather than described, because "waving:
 * frames 24-27" tells you nothing about whether the wave is any good — and the
 * two settings that are about him being here rather than about him existing.
 *
 * It is a panel rather than the small menu it replaces because the menu could
 * only ever hold a list, and a list is the wrong shape for "show me this pet".
 * It deliberately borrows the marketplace's furniture — the same card, the same
 * fact rows, the same formatters — so the same pet does not describe himself
 * two different ways in two places.
 *
 * Fields with no value are left out rather than shown empty: most pets carry no
 * author, and "Author: unknown" is a page full of the absence of data.
 */

export type PetDetailsPanelProps = {
  pet: InstalledPet;
  stage: PetStage;
  onChange: (stage: PetStage) => void;
  /** Saves the voice, or `null` to hand the question back to his manifest. */
  onChangeVoice: (voice: PetVoice | null) => void;
  onClose: () => void;
  /** Puts him on the desktop, out of the chat. Absent when he is already there. */
  onSendToDesktop?: () => void;
  /**
   * Gives him to the conversation on screen. Absent when there is no
   * conversation to give him to, or when he is already in it.
   */
  onSendToChat?: () => void;
  onHide: () => void;
};

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2 border-b border-border py-1.5 last:border-b-0">
      <dt className="w-24 shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 flex-1 break-words text-xs">{children}</dd>
    </div>
  );
}

export function PetDetailsPanel({
  pet,
  stage,
  onChange,
  onChangeVoice,
  onClose,
  onSendToDesktop,
  onSendToChat,
  onHide,
}: PetDetailsPanelProps) {
  const { definition } = pet;
  const [previewState, setPreviewState] = useState<PetStateName>('idle');

  /*
   * The platform's own synthesiser, read from the voice module rather than
   * reached for directly: it owns the voice list (which arrives asynchronously
   * on Chromium and is empty on the first call), the chunking, and the
   * name-matching that makes a pet authored on another operating system find
   * the same speaker here. Building a second one of those was the wrong move
   * available.
   */
  const speech = useSpeech();
  const voice = definition.voice ?? null;

  /** What a chosen voice would say, so it can be judged by ear rather than by name. */
  const previewLine = pet.thinkingPhrases[0] ?? `Hello, I am ${definition.displayName}.`;
  const speakPreview = (next: PetVoice) => {
    const settings = resolvePetVoice(next, speech.voices);
    if (settings) speech.speak(previewLine, settings);
  };

  // Only the rows this sheet actually has. A pet with nine animations and a pet
  // with eleven are both correct, and offering a button for a row that is not
  // there would play the fallback and look like a bug in the sprite.
  const states = Object.keys(definition.states) as PetStateName[];
  const added = formatAdded(pet.installedAt);

  return createPortal(
    <div
      data-tails-part="scrim"
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        data-tails-part="card"
        role="dialog"
        aria-label={`${definition.displayName} details`}
        className="flex max-h-full w-full max-w-md flex-col overflow-hidden"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate font-display text-sm font-semibold">{definition.displayName}</h2>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {SOURCE_LABEL[pet.source]}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close pet details"
            className="rounded-md p-1.5 text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <div className="flex items-end justify-center rounded-lg border border-border bg-muted/30 py-3">
            <PetSprite pet={pet} size={112} state={previewState} />
          </div>

          <div className="flex flex-wrap gap-1.5">
            {states.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setPreviewState(name)}
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[11px] transition-colors duration-quick',
                  name === previewState
                    ? 'border-primary bg-primary/15 text-foreground'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {name}
              </button>
            ))}
          </div>

          {definition.description ? (
            <p className="text-xs text-muted-foreground">{definition.description}</p>
          ) : null}

          <dl>
            {definition.author ? <Fact label="Author">{definition.author}</Fact> : null}
            <Fact label="Sheet">{describeGrid(pet)}</Fact>
            <Fact label="Animations">{states.length}</Fact>
            {added ? <Fact label="Added">{added}</Fact> : null}
          </dl>

          <section className="space-y-3 rounded-lg border border-border p-3">
            <h3 className="font-display text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              On screen
            </h3>

            <label className="block space-y-1 text-sm">
              <span className="flex items-baseline justify-between">
                <span>Size</span>
                <span className="text-xs text-muted-foreground">
                  {Math.round(stage.scale * 100)}%
                </span>
              </span>
              <input
                type="range"
                min={MIN_PET_SCALE}
                max={MAX_PET_SCALE}
                step={0.05}
                value={stage.scale}
                onChange={(event) => onChange({ ...stage, scale: Number(event.target.value) })}
                className="w-full accent-primary"
              />
            </label>

            <label className="flex items-center justify-between gap-3 text-sm">
              <span>
                Wander
                <span className="block text-xs text-muted-foreground">
                  He strolls about when nothing is happening.
                </span>
              </span>
              <input
                type="checkbox"
                checked={stage.walks}
                onChange={(event) => onChange({ ...stage, walks: event.target.checked })}
                className="size-4 accent-primary"
              />
            </label>
          </section>

          {/*
            His voice.
            
            Three states, and they are deliberately distinct: no choice stored
            (his manifest decides, which for every pet shipped so far means
            silence), a chosen voice, and *chosen* silence. The last two look
            the same from outside and are not the same thing — a pet authored to
            be quiet is a decision, not an empty field.
          */}
          <section className="space-y-3 rounded-lg border border-border p-3">
            <h3 className="font-display text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Voice
            </h3>

            {speech.supported ? (
              <>
                <label className="block space-y-1 text-sm">
                  <span>Speaks with</span>
                  <select
                    data-tails-part="input"
                    className="w-full px-2 py-1 text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
                    value={voice ? (voice.engine === 'none' ? '__none' : voice.name ?? '') : '__unset'}
                    onChange={(event) => {
                      const picked = event.target.value;
                      if (picked === '__unset') {
                        onChangeVoice(null);
                        return;
                      }
                      const next: PetVoice = picked === '__none'
                        ? { ...(voice ?? DEFAULT_VOICE), engine: 'none' }
                        : { ...(voice ?? DEFAULT_VOICE), engine: 'system', name: picked };
                      onChangeVoice(next);
                      if (next.engine === 'system') speakPreview(next);
                    }}
                  >
                    <option value="__unset">Not set — whatever his file says</option>
                    <option value="__none">No voice — he stays quiet</option>
                    {speech.voices.map((available) => (
                      <option key={available.name} value={available.name}>
                        {available.name}
                        {available.lang ? ` (${available.lang})` : ''}
                      </option>
                    ))}
                  </select>
                </label>

                {voice && voice.engine !== 'none' ? (
                  <>
                    <label className="block space-y-1 text-sm">
                      <span className="flex items-baseline justify-between">
                        <span>Pitch</span>
                        <span className="text-xs text-muted-foreground">{voice.pitch.toFixed(1)}</span>
                      </span>
                      <input
                        type="range"
                        min={0.5}
                        max={2}
                        step={0.1}
                        value={voice.pitch}
                        onChange={(event) => onChangeVoice({ ...voice, pitch: Number(event.target.value) })}
                        className="w-full accent-primary"
                      />
                    </label>

                    <label className="block space-y-1 text-sm">
                      <span className="flex items-baseline justify-between">
                        <span>Speed</span>
                        <span className="text-xs text-muted-foreground">{voice.rate.toFixed(1)}</span>
                      </span>
                      <input
                        type="range"
                        min={0.5}
                        max={2}
                        step={0.1}
                        value={voice.rate}
                        onChange={(event) => onChangeVoice({ ...voice, rate: Number(event.target.value) })}
                        className="w-full accent-primary"
                      />
                    </label>

                    {/*
                      Nobody can pick a voice from a name, and nobody can judge
                      a pitch from a number. Both are decided by ear.
                    */}
                    <button
                      type="button"
                      onClick={() => (speech.speaking ? speech.hush() : speakPreview(voice))}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs transition-colors duration-quick hover:bg-accent hover:text-foreground"
                    >
                      <Volume2 className="size-3.5" aria-hidden="true" />
                      {speech.speaking ? 'Stop' : 'Hear him'}
                    </button>
                  </>
                ) : null}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                This machine has no speech synthesiser, so pets cannot be given a voice here.
              </p>
            )}
          </section>
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-4 py-3">
          <div className="flex items-center gap-1">
            {onSendToDesktop ? (
              <button
                type="button"
                onClick={onSendToDesktop}
                className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
              >
                <Monitor className="size-3.5" aria-hidden="true" />
                Put on the desktop
              </button>
            ) : null}

            {/*
              The way back in. Carrying him out is a flick of the wrist, and
              until this existed undoing it meant opening the marketplace and
              dropping him on the right conversation.
            */}
            {onSendToChat ? (
              <button
                type="button"
                onClick={onSendToChat}
                className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
              >
                <MessageSquare className="size-3.5" aria-hidden="true" />
                Send to this chat
              </button>
            ) : null}
          </div>

          <button
            type="button"
            onClick={onHide}
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
          >
            <EyeOff className="size-3.5" aria-hidden="true" />
            Hide him
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
