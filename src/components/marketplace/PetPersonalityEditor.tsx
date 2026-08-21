import { Loader2, Plus, Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { api, type ThemeSummary } from '@/lib/api';
import { cn } from '@/lib/utils';

import { petsApi, type InstalledPet } from './marketplace-api';

/**
 * The two things a pet carries besides its artwork.
 *
 * A **look**: a theme the conversation adopts while this pet is assigned to it.
 * The list comes from the appearance module's own HTTP API rather than from its
 * code — themes are that module's business, and a preset can be removed at any
 * time. A stored id that no longer matches anything is shown as "no theme"
 * instead of as an error, because a deleted preset is not a broken pet.
 *
 * And a **voice**: the lines it says while the agent is thinking. Sonic gets
 * "collecting rings…"; the point is that waiting should feel like the companion
 * is doing something. Plain text, capped, and never rendered as markup — these
 * are displayed in a small indicator, not parsed.
 *
 * Both are stored in our database, not in the pet's folder: most pets live in
 * `~/.codex/pets`, which belongs to Codex and is read-only to us.
 */

/** Mirrors the server's cap. Enforced here too, so the UI cannot offer a save that fails. */
const MAX_PHRASES = 12;

/** Mirrors `personaPromptSchema`. */
const MAX_PERSONA = 700;

type PetChatMode = 'none' | 'chatty' | 'override';

const CHAT_MODES: { id: PetChatMode; label: string; blurb: string }[] = [
  {
    id: 'none',
    label: 'Quiet',
    blurb: 'He walks about and reacts to being picked up, and never says anything.',
  },
  {
    id: 'chatty',
    label: 'Chimes in',
    blurb: 'After a reply he sometimes says one of his lines below, in a bubble above him. Never in the transcript, and never anything you need. Give him some lines or he stays quiet.',
  },
  {
    id: 'override',
    label: 'In character',
    blurb: 'Replies in his conversations are written in his voice. Only the voice — he still uses every tool and stays accurate. This one outranks the general tone in your own conversation instructions; your specific rules still bind him.',
  },
];

/**
 * A persona from what the app already knows about him.
 *
 * Composed, not generated, and that is the honest trade: instant, free, needs no
 * network, and it is a starting point rather than a character. The description is
 * the only characterisation most pets have, so it does the work; the rest is the
 * framing that stops a voice turning into a refusal to do the job.
 */
function draftPersona(name: string, description: string): string {
  return [
    `Speak as ${name}.`,
    description ? `${name} is: ${description.replace(/\s+/g, ' ').trim()}` : '',
    'Keep their manner and turns of phrase, and let it colour how you explain things rather than what you say.',
    'Stay brief and stay accurate — never bend a fact to fit the character, and answer plainly whenever plainness is what is needed.',
  ].filter(Boolean).join(' ').slice(0, MAX_PERSONA);
}
const MAX_PHRASE_LENGTH = 80;

type PetPersonalityEditorProps = {
  pet: InstalledPet;
  onSaved: () => void;
};

export function PetPersonalityEditor({ pet, onSaved }: PetPersonalityEditorProps) {
  const [themes, setThemes] = useState<ThemeSummary[] | null>(null);
  const [theme, setTheme] = useState<string>(pet.assignedTheme ?? '');
  const [phrases, setPhrases] = useState<string[]>(
    pet.thinkingPhrases.length > 0 ? pet.thinkingPhrases : [''],
  );
  const [mode, setMode] = useState<PetChatMode>(pet.chatMode ?? 'none');
  const [persona, setPersona] = useState(pet.personaPrompt ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.listThemes()
      .then((list) => {
        if (!cancelled) setThemes(list);
      })
      .catch(() => {
        // The picker degrades to "no theme" plus whatever is already stored,
        // which is better than blocking the phrases editor behind it.
        if (!cancelled) setThemes([]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // A stored id the appearance module no longer knows about. Named rather than
  // silently dropped, so the user can see why their pet stopped restyling.
  const themeMissing = theme !== '' && themes !== null
    && !themes.some((candidate) => candidate.id === theme);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const cleaned = phrases.map((phrase) => phrase.trim()).filter(Boolean).slice(0, MAX_PHRASES);
      await petsApi.updatePet(pet.definition.id, {
        assignedTheme: theme === '' ? null : theme,
        thinkingPhrases: cleaned.length > 0 ? cleaned : null,
        chatMode: mode,
        // Only meaningful in `override`, but always sent: a persona written and
        // then parked by switching to "quiet" should still be there when the
        // user switches back, rather than being silently dropped by the save
        // that happened in between.
        personaPrompt: persona.trim(),
      });
      onSaved();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'That did not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-tails-part="card" className="space-y-4 p-3">
      <div>
        <h4 className="flex items-center gap-1.5 text-sm font-semibold">
          <Sparkles className="size-3.5" aria-hidden="true" /> Personality
        </h4>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Kept in T.A.I.L.S.&rsquo;s own database, so this works for pets Codex installed too —
          their folders are never written to.
        </p>
      </div>

      {/*
        How much of a personality he is, above the two decorative settings.

        Three options, and the third differs in kind: the first two change what
        the pet does, and "in character" changes what the *assistant* sounds
        like in every reply in conversations he lives in. That is a large thing
        to hand somebody from a pet panel, so it is described in terms of what it
        does to the answers, and it shows the text that will be sent rather than
        hiding it behind a label.
      */}
      <div className="space-y-1.5">
        <span className="block text-[11px] font-medium text-muted-foreground">
          How much he talks
        </span>
        {CHAT_MODES.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => setMode(option.id)}
            className={cn(
              'block w-full rounded-md border p-2 text-left transition-colors duration-quick',
              mode === option.id ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent',
            )}
          >
            <span className="block text-xs font-medium">{option.label}</span>
            <span className="mt-0.5 block text-[11px] text-muted-foreground">{option.blurb}</span>
          </button>
        ))}
      </div>

      {mode === 'override' ? (
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] font-medium text-muted-foreground">
              How he speaks
            </span>
            <button
              type="button"
              onClick={() => setPersona(draftPersona(
                pet.definition.displayName,
                pet.definition.description ?? '',
              ))}
              className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
            >
              Draft one
            </button>
          </div>

          <textarea
            data-tails-part="input"
            rows={4}
            maxLength={MAX_PERSONA}
            value={persona}
            onChange={(event) => setPersona(event.target.value)}
            placeholder={`How should ${pet.definition.displayName} sound? Or press "Draft one".`}
            className="w-full resize-none px-2 py-1.5 text-xs outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
          />

          <p className="text-[11px] text-muted-foreground">
            Sent with every message in conversations he lives in, so keep it short. You can also ask
            in chat — &ldquo;write {pet.definition.displayName} a persona&rdquo; — and it lands here.
            {!persona.trim() ? ' Left empty, he is played from his name and description.' : ''}
          </p>
        </div>
      ) : null}

      <label className="block">
        <span className="block text-[11px] font-medium text-muted-foreground">
          Theme for chats using this pet
        </span>
        <select
          value={theme}
          disabled={themes === null}
          onChange={(event) => setTheme(event.target.value)}
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground disabled:opacity-60"
        >
          <option value="">No theme — leave the app as it is</option>
          {themeMissing ? (
            <option value={theme}>{theme} (no longer available)</option>
          ) : null}
          {(themes ?? []).map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
              {candidate.builtIn ? ' (built in)' : ''}
            </option>
          ))}
        </select>
        {themeMissing ? (
          <span className="mt-1 block text-[11px] text-warning">
            That theme has been deleted. The pet will not restyle anything until you pick another.
          </span>
        ) : null}
      </label>

      <div className="space-y-1.5">
        <span className="block text-[11px] font-medium text-muted-foreground">
          Thinking phrases
        </span>
        <p className="text-[11px] text-muted-foreground">
          Shown while the agent is working. One per line — &ldquo;collecting rings…&rdquo;,
          &ldquo;pondering at the speed of sound…&rdquo;
        </p>

        {phrases.map((phrase, index) => (
          <div key={index} className="flex items-center gap-1.5">
            <input
              value={phrase}
              maxLength={MAX_PHRASE_LENGTH}
              onChange={(event) => setPhrases((current) => current.map(
                (existing, position) => (position === index ? event.target.value : existing),
              ))}
              placeholder="collecting rings…"
              aria-label={`Thinking phrase ${index + 1}`}
              data-tails-part="input"
              className="w-full px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              type="button"
              onClick={() => setPhrases((current) => {
                const next = current.filter((_unused, position) => position !== index);
                return next.length > 0 ? next : [''];
              })}
              aria-label={`Remove phrase ${index + 1}`}
              className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}

        {phrases.length < MAX_PHRASES ? (
          <button
            type="button"
            onClick={() => setPhrases((current) => [...current, ''])}
            className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs transition-colors duration-quick hover:bg-accent"
          >
            <Plus className="size-3" aria-hidden="true" /> Add a phrase
          </button>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Twelve is the limit — past that they stop being a personality.
          </p>
        )}
      </div>

      {error ? (
        <p
          data-tails-critical
          className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
        >
          {error}
        </p>
      ) : null}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className={cn(
            'flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground',
            'transition-transform duration-instant ease-emphasis active:scale-95 disabled:opacity-60',
          )}
        >
          {saving ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : null}
          {saving ? 'Saving…' : 'Save personality'}
        </button>
      </div>
    </div>
  );
}
