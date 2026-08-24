import { Brain, Check, Copy, Paperclip, X } from 'lucide-react';
import { useEffect, useRef, useState, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { CommandToken, readStyledCommand } from '@/components/chat/commandStyle';
import { Composer, type ComposerHandle } from '@/components/chat/Composer';
import { EmptyState, type ModelBadgeState } from '@/components/chat/EmptyState';
import { rehypeFadeTokens } from '@/components/chat/fade-tokens';
import type { ModelChoice } from '@/types/chat';
import { PetPicker } from '@/components/chat/PetPicker';
import { PermissionBanner } from '@/components/chat/PermissionBanner';
import { PlanCard } from '@/components/chat/PlanCard';
import { QuestionCard } from '@/components/chat/QuestionCard';
import { ThinkingIndicator } from '@/components/chat/ThinkingIndicator';
import { TurnFooter } from '@/components/chat/TurnFooter';
import { PetSprite, type InstalledPet } from '@/components/marketplace';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import { ToolRow } from '@/components/chat/ToolRow';
import { useChatSession } from '@/components/chat/useChatSession';
import { onDesktopPetVoiceToggle, reportVoiceState } from '@/components/petstage/desktop-handoff';
import { DEFAULT_VOICE, readDefaultVoice, resolveVoice, type DefaultVoice } from '@/components/settings/default-voice';
import { useArmedWakeWords } from '@/components/voice/useArmedWakeWords';
import { chimeArmed, chimeOff, chimeWake } from '@/components/voice/voice-chime';
import { useSpeech } from '@/components/voice/useSpeech';
import { useSpokenApproval } from '@/components/voice/useSpokenApproval';
import { useSpokenReply } from '@/components/voice/useSpokenReply';
import { useVoiceDictation } from '@/components/voice/useVoiceDictation';
import { VoiceGlow } from '@/components/voice/VoiceGlow';
import { VoiceModeStrip } from '@/components/voice/VoiceModeStrip';
import { api } from '@/lib/api';
import type { AttachmentPayload, ChatRow, MessageAttachment } from '@/types/chat';

function ThinkingRow({ row }: { row: Extract<ChatRow, { type: 'thinking' }> }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 text-sm">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground"
      >
        <Brain className="size-3.5" aria-hidden="true" />
        {expanded ? 'Hide reasoning' : 'Show reasoning'}
      </button>
      {expanded ? (
        <p className="animate-fade-in whitespace-pre-wrap px-3 pb-2 text-xs text-muted-foreground">
          {row.content}
        </p>
      ) : null}
    </div>
  );
}

/**
 * What the user sent alongside their message.
 *
 * An image shows itself; anything else is a chip. Rendered inside the bubble
 * rather than beside it because the attachment is part of the message — a
 * transcript that shows the words but not the screenshot they refer to is
 * missing half of what was said.
 */
function SentAttachments({ attachments }: { attachments: MessageAttachment[] }) {
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {attachments.map((attachment, index) => (
        attachment.previewUrl ? (
          <img
            key={`${attachment.name}-${index}`}
            src={attachment.previewUrl}
            alt={attachment.name}
            className="max-h-44 max-w-[14rem] rounded-lg border border-primary-foreground/25 object-cover"
          />
        ) : (
          <span
            key={`${attachment.name}-${index}`}
            className="flex items-center gap-1.5 rounded-full border border-primary-foreground/25 bg-primary-foreground/10 px-2 py-1 text-xs"
          >
            <Paperclip className="size-3" aria-hidden="true" />
            <span className="max-w-[12rem] truncate">{attachment.name}</span>
          </span>
        )
      ))}
    </div>
  );
}

/**
 * The user's own words, with a styled command kept styled.
 *
 * The transcript stores what was typed, so the look has to be re-derived on
 * render rather than carried along with the message — which is also what makes
 * it survive a reload and a re-theme.
 */
function UserText({ content }: { content: string }) {
  const command = readStyledCommand(content);
  if (!command) return <>{content}</>;

  // The token is echoed exactly as it was typed — `/ultracode`, `\ultracode`
  // or the bare word — because the transcript should read back as what the
  // user wrote, not as the canonical spelling of what it meant.
  /*
    Split around wherever the command actually sits.

    It used to assume the command was a prefix and slice from the front, which
    was true while only the first word could be one. Now that a slashed command
    is read anywhere, the token has an index and the text has two sides.
  */
  const { name, token, index } = command;
  const before = content.slice(0, index);
  const after = content.slice(index + token.length);

  return (
    <>
      {before}
      {/*
        The chip is a separate element because it has to be: `bg-clip-text`
        clips every background on the token to the glyphs, so the token cannot
        carry its own backing. It earns its place here — a saturated gradient
        on the accent-filled bubble is a contrast gamble that changes with the
        theme, and this gives the colour a consistent ground to sit on.
      */}
      <span className="rounded bg-primary-foreground/90 px-1.5 py-0.5">
        <CommandToken name={name}>{token}</CommandToken>
      </span>
      {after}
    </>
  );
}

function Row({ row, voice }: {
  row: ChatRow;
  /** The pet voicing the replies, when one is. Drawn beside the assistant's. */
  voice?: InstalledPet | null;
}) {
  switch (row.type) {
    case 'user':
      return (
        /*
          The bubble, with its own metadata on hover.

          `group` rather than per-row state: two affordances that appear together
          on hover are one hover, and tracking it in React would re-render the
          transcript on every pointer move across it.
        */
        <div className="group/msg flex items-end justify-end gap-1.5">
          {/*
            To the left of the bubble, because the bubble is right-aligned and
            anything after it would push it off the column. Ordered so the copy
            button is nearest the text it copies.
          */}
          <span className="flex shrink-0 items-center gap-1 pb-1 opacity-0 transition-opacity duration-quick group-hover/msg:opacity-100">
            {row.at ? (
              <time
                dateTime={row.at}
                className="text-[10px] tabular-nums text-muted-foreground"
                // The full date on hover: the short form is a time of day, which
                // is ambiguous the moment a conversation is more than a day old.
                title={new Date(row.at).toLocaleString()}
              >
                {new Date(row.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              </time>
            ) : null}
            <CopyMessageButton content={row.content} />
          </span>

          <div
            data-tails-part="bubbleUser"
            // Same reasoning as the assistant's turn: this element is what a
            // theme borders, so it carries room for a border it cannot know
            // about. No negative margin here — the bubble is meant to read as
            // a bubble, so it may sit inside the column.
            className="max-w-[80%] whitespace-pre-wrap px-5 py-3 text-primary-foreground"
          >
            {row.attachments?.length ? <SentAttachments attachments={row.attachments} /> : null}
            <UserText content={row.content} />
          </div>
        </div>
      );

    case 'assistant':
      return (
        <div className="flex items-start gap-2">
          {/*
            Who is speaking, when it is not the assistant's own voice.

            `sticky` rather than pinned to the top of the message: a long reply
            scrolls past the top of the viewport, and an avatar that scrolls away
            with it stops answering the question it is there to answer. Stuck to
            the top of the scroll container, it stays beside whichever part of
            the reply is being read.

            In its own gutter rather than floated inside the bubble, because the
            bubble is what a theme paints — an absolutely positioned child would
            be clipped by a theme that sets `overflow`, and a floated one would
            reflow the text around it.
          */}
          {voice ? (
            <span
              className="sticky top-1 shrink-0 pt-4 opacity-80"
              title={`Voiced by ${voice.definition.displayName}`}
            >
              <PetSprite pet={voice} size={18} state="idle" facing="right" fps={0} />
            </span>
          ) : null}

        <div
          data-tails-part="bubbleAssistant"
          /*
            Padding is not part of the surface contract — a theme can give this
            box a border, an outline and a fill at (0,2,0) without being able to
            add room for them — so the component has to leave that room itself.
            Hence padding on this element (the one that gets painted) rather
            than on the markdown wrapper inside it, and enough of it that a
            2px border never lands on the text.

            The negative margin is the other half: unstyled, the assistant's
            turn is page text and should stay aligned with the rest of the
            column, so the box grows outward into the gutter instead of pushing
            the words inward.
          */
          className="-mx-6 max-w-none px-6 py-4 text-[0.9375rem] leading-relaxed"
        >
          <div className="prose-tails space-y-3">
            {/*
              The word-splitting plugin only while the words are still arriving.
              A settled message renders as plain markdown — see `fade-tokens.ts`
              for why a span per word is right for one message and wrong for a
              transcript of them.
            */}
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={row.streaming ? [rehypeFadeTokens] : undefined}
            >
              {row.content}
            </ReactMarkdown>
          </div>
          {row.streaming ? (
            <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-foreground align-middle" />
          ) : null}
        </div>
        </div>
      );

    case 'thinking':
      return <ThinkingRow row={row} />;

    case 'tool':
      return <ToolRow row={row} />;

    case 'error':
      return (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {row.content}
        </div>
      );

    case 'status':
      return <p className="text-center text-xs text-muted-foreground">{row.content}</p>;
  }
}

type ChatViewProps = {
  sessionId: string | null;
  cwd: string;
  onFirstMessage?: (content: string) => void;
};

/**
 * Whether tokens are arriving into this row right now.
 *
 * Only the assistant row carries the flag, so this is a type guard rather than a
 * property read — and it is the question the waiting indicator actually wants
 * asked, which is not the same as "is the last row from the assistant".
 */
const isStreaming = (row: ChatRow | undefined): boolean =>
  row?.type === 'assistant' && row.streaming === true;

/**
 * Copies one message's text.
 *
 * Its own component so the "copied" flash is its own state: held on the row it
 * belongs to, it would be state on the transcript, and every copy would
 * re-render every message.
 */
function CopyMessageButton({ content }: { content: string }) {
  /*
    Three states, because two of them are lies.

    The first version set "copied" on a resolved promise and swallowed the
    rejection — so when Electron's permission handler refused the write, the tick
    never appeared and neither did anything else. Silence reads as a dead button,
    and a tick that appears regardless reads as a working one. So a failure says
    so.
  */
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const label = state === 'copied' ? 'Copied'
    : state === 'failed' ? 'Could not copy' : 'Copy message';

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        void copyText(content).then((ok) => {
          setState(ok ? 'copied' : 'failed');
          // Cleared on a timer rather than on blur: the button is inside a
          // hover-revealed group, so a pointer leaving takes the whole thing
          // with it and there would be nothing to clear.
          window.setTimeout(() => setState('idle'), ok ? 1200 : 2000);
        });
      }}
      className={cn(
        'rounded p-0.5 transition-colors duration-quick hover:bg-accent hover:text-foreground',
        state === 'failed' ? 'text-destructive' : 'text-muted-foreground',
      )}
    >
      {state === 'copied' ? <Check className="size-3" aria-hidden="true" />
        : state === 'failed' ? <X className="size-3" aria-hidden="true" />
          : <Copy className="size-3" aria-hidden="true" />}
    </button>
  );
}

export function ChatView({ sessionId, cwd, onFirstMessage }: ChatViewProps) {
  const {
    rows, busy, lastTurnMs, pendingPermissions, pendingPrompts, error, mode, changeMode,
    turnSettings, changeTurnSettings, suggestion, clearSuggestion,
    sendMessage, abort, answerPermission, answerQuestion, answerPlan,
  } = useChatSession(sessionId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);
  const composerRef = useRef<ComposerHandle>(null);
  /*
    Dictated text is appended rather than returned through the contract, so it
    lands in a draft someone may already have started typing. `cwd` goes with
    it because the recogniser seeds its vocabulary from the conversation's
    folder — that is what keeps filenames and identifiers intact.
  */
  const armedWakeWords = useArmedWakeWords();
  const speech = useSpeech();
  /*
    The reply reader. Armed by sending with your voice rather than by voice
    mode being on, so a message typed while the wake word happens to be armed
    is answered on screen and in silence, like every other typed message.
  */
  /**
   * The pet whose voice these replies are in, or null.
   *
   * Only set for `override`: the avatar beside a reply is a claim about who is
   * speaking, so it appears exactly when that claim is true. A chatty pet
   * comments from the sidelines and is not the author of anything.
   */
  const [voicedBy, setVoicedBy] = useState<InstalledPet | null>(null);

  /**
   * The app's own voice, for everything the pet does not answer.
   *
   * Read once. It is a preference rather than a live value, and re-reading it
   * per turn would be a request every time anybody said anything.
   */
  const [appVoice, setAppVoice] = useState<DefaultVoice>(DEFAULT_VOICE);
  useEffect(() => {
    let cancelled = false;
    void readDefaultVoice().then((next) => { if (!cancelled) setAppVoice(next); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  /*
    Which voice reads the reply.

    This was missing, and its absence was the whole gap between "the pet is
    speaking" and "the pet's voice is speaking": a pet in override mode writes
    the reply in character and it was then read aloud in the app's default
    voice, by somebody else.

    `resolveVoice` is the one place that decides — the pet's own, then the app
    default, then the platform's — so this hands it the pet and lets it answer.
  */
  const replyVoice = useMemo(
    () => resolveVoice(voicedBy?.definition.voice ?? null, appVoice, speech.voices) ?? undefined,
    [voicedBy, appVoice, speech.voices],
  );

  const lastAssistant = [...rows].reverse().find((row) => row.type === 'assistant');
  const spokenReply = useSpokenReply({
    reply: lastAssistant?.type === 'assistant' ? lastAssistant.content : '',
    busy,
    speak: speech,
    settings: replyVoice,
  });
  /*
    Approvals, answered out loud.

    Armed off a mirror of the intent rather than off `voice.intent` directly,
    because the two hooks need each other: this one decides when the microphone
    should open for an answer, and the microphone decides what the control says.
    One render of lag is free here — voice mode is turned on long before any
    permission request arrives.
  */
  const [voiceArmed, setVoiceArmed] = useState(false);
  const approval = useSpokenApproval({
    armed: voiceArmed,
    pendingPermissions,
    pendingPrompts,
    speech,
    answerPermission,
    answerQuestion,
    answerPlan,
  });
  const voice = useVoiceDictation({
    /*
      An answer is not a message. While a request is being put to the user, the
      words come back here first and stop here — putting "approve" in the
      composer would leave it to be sent as the next thing the user said.
    */
    onText: (text) => {
      if (approval.hear(text)) return;
      composerRef.current?.append(text);
    },
    // The auto-send, and the one behaviour that separates voice mode from
    // dictation. `sendSpoken` reads the draft synchronously, so the words that
    // arrived a moment ago in `onText` are in the message.
    onSpokenTurn: () => {
      if (approval.swallowTurn()) return;
      composerRef.current?.sendSpoken();
    },
    onWake: () => {
      chimeWake();
      /*
        Barge-in. Saying the wake word while the app is talking should stop it
        talking — otherwise the only way to interrupt a reply being read back is
        the button, which is the thing voice mode exists to not need. Safe when
        nothing is playing, so it needs no guard.
      */
      speech.hush();
    },
    cwd,
    armed: armedWakeWords,
    speech,
    asking: approval.asking,
  });

  /*
    The microphone opens for an answer only once the question has finished being
    asked. Capturing while the app is still talking would record the app.
  */
  /*
    The desktop pet's microphone.

    Registered once and reads the live intent through a ref, because the handler
    is installed on the shell bridge for the lifetime of this component and the
    intent changes underneath it. Starting voice mode rather than dictation on
    purpose: a pet on the desktop is nowhere near the composer, so filling a box
    the user cannot see would be a press that appeared to do nothing.
  */
  const voiceRef = useRef(voice);
  useEffect(() => { voiceRef.current = voice; }, [voice]);
  useEffect(() => {
    onDesktopPetVoiceToggle(() => {
      const live = voiceRef.current;
      if (live.intent === 'voice') live.disable();
      else live.start('voice');
    });
  }, []);

  const awaitingAnswer = approval.asking?.awaiting ?? false;
  const startCapture = voice.capture;
  useEffect(() => {
    if (awaitingAnswer) startCapture();
  }, [awaitingAnswer, startCapture]);

  /*
    The two chimes that are not the wake word. Driven off the intent rather
    than fired from the click handlers because voice mode can also end by
    itself — a failed microphone, or a chat closing — and a mode that ends
    silently after announcing itself is a mode the user will think is still on.
  */
  const voiceOnRef = useRef(false);
  useEffect(() => {
    const on = voice.intent === 'voice';
    if (on === voiceOnRef.current) return;
    voiceOnRef.current = on;
    setVoiceArmed(on);
    // The desktop pet's microphone shows this, and it has to be pushed for the
    // same reason the chimes are driven from here: voice mode can end by itself.
    reportVoiceState(on);
    if (on) chimeArmed();
    else {
      chimeOff();
      spokenReply.cancel();
    }
  }, [voice.intent, spokenReply]);
  const [petPickerOpen, setPetPickerOpen] = useState(false);
  const [pet, setPet] = useState<{ id: string; name: string; phrases: string[] } | null>(null);
  /*
    Starts as "still reading" rather than "nothing": the badge holds its place
    from the first frame, so the name arriving is a text swap and not a jolt.
  */
  const [catalogue, setCatalogueState] = useState<{
    current: ModelChoice | null;
    models: ModelChoice[];
    resolving: boolean;
  }>({ current: null, models: [], resolving: true });

  const setCatalogue = (next: { current: ModelChoice | null; models: ModelChoice[] }) =>
    setCatalogueState({ ...next, resolving: false });

  // Follow the stream only while the user is already at the bottom; yanking
  // them down while they're reading earlier output is the classic chat-UI sin.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !pinnedToBottomRef.current) return;
    container.scrollTop = container.scrollHeight;
  }, [rows]);

  /**
   * Resolves this conversation's pet to something showable.
   *
   * Two calls, and only when there is something to resolve: the session row
   * knows the id, and only the pets library knows the name. An id whose pet is
   * no longer installed resolves to nothing, which is the intended reading of
   * a dangling assignment rather than an error to surface.
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      let resolved: { id: string; name: string; phrases: string[] } | null = null;
      let nextVoicedBy: InstalledPet | null = null;
      try {
        if (sessionId) {
          const session = await api.getSession(sessionId);
          if (session.petId) {
            const library = await api.listPets();
            const match = library.pets.find((entry) => entry.definition.id === session.petId);
            if (match) {
              /*
                A pet that carries a look brings it with him.

                `assignedTheme` has been stored, validated and persisted by the
                pets module all along, and nothing on this side ever read it —
                so choosing a theme for a pet did exactly nothing, which is the
                same "written but never consumed" shape this project keeps
                finding. Bound to the *session* rather than globally: the pet
                belongs to this conversation, so his look should leave with it
                rather than following the user into chats he is not in.

                Failure is silent by design. A stored id whose preset no longer
                exists is documented as meaning "no theme", never an error —
                see `assignedThemeSchema`.
              */
              if (match.assignedTheme) {
                void api.applyTheme({
                  themeId: match.assignedTheme,
                  scope: 'session',
                  sessionId,
                }).catch(() => {});
              }

              // See the note on the state: the avatar is a claim about
              // authorship, so only the mode that changes the reply earns one.
              nextVoicedBy = match.chatMode === 'override' ? match : null;

              resolved = {
                id: match.definition.id,
                // Both of these live where the pets module actually puts them,
                // which is not where they read as belonging. The definition is
                // the pet's own manifest and carries `displayName`; the phrases
                // are ours, stored beside the definition rather than inside it,
                // because a Codex manifest is read-only and cannot hold them.
                // Reading `definition.name` and `definition.thinkingPhrases`
                // silently yielded undefined, so every seeded line reached
                // nothing at all.
                name: match.definition.displayName,
                phrases: match.thinkingPhrases ?? [],
              };
            }
          }
        }
      } catch {
        // A chat with no row yet, or an unreadable pet library. Either way the
        // menu simply shows no assignment.
      }
      if (cancelled) return;
      setPet(resolved);
      setVoicedBy(nextVoicedBy);
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  /**
   * Reads the model this conversation runs on.
   *
   * Per conversation rather than per app, because the folder a chat runs in
   * can carry its own model override. Failure stays silent: the badge is
   * absent rather than approximate, and "unavailable" is what says so.
   *
   * Switching conversations deliberately leaves the previous name on screen
   * until the next one resolves. Dropping back to "resolving" would flash the
   * placeholder for a frame on every switch, which is the flicker this whole
   * change exists to remove.
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      let next: { current: ModelChoice | null; models: ModelChoice[] } = { current: null, models: [] };
      try {
        if (sessionId) next = await api.getSessionModels(sessionId);
      } catch {
        // Nothing to say, so nothing is said.
      }
      if (!cancelled) setCatalogue(next);
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  /*
    One source for both the badge and the picker. The badge showed the model
    the CLI resolves to, and now that the model can be chosen the two would
    disagree the moment anyone chose one — so the badge reads the selection
    first and falls back to the resolved default.
  */
  const chosenModel = turnSettings.model
    ? catalogue.models.find((entry) => entry.id === turnSettings.model) ?? null
    : null;
  const effectiveModel = chosenModel ?? catalogue.current;
  const model: ModelBadgeState = catalogue.resolving
    ? { status: 'resolving' }
    : effectiveModel
      ? { status: 'ready', name: effectiveModel.displayName }
      : { status: 'unavailable' };

  const handleScroll = () => {
    const container = scrollRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    pinnedToBottomRef.current = distanceFromBottom < 80;
  };

  const submit = (
    content: string,
    attachments: AttachmentPayload[],
    origin?: { spoken: boolean },
  ) => {
    pinnedToBottomRef.current = true;
    onFirstMessage?.(content);
    // A spoken turn is answered differently at both ends: the model is asked
    // for something short and conversational, and the answer is read back as
    // it arrives.
    if (origin?.spoken) spokenReply.begin();
    sendMessage(content, { cwd, attachments, spoken: origin?.spoken });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/*
        The stage: everything above the composer, and the frame an overlay
        measures itself against. It is a positioning context that ends exactly
        where the composer begins, so an absolutely-positioned layer inside it
        spans the chat and nothing else — its bottom edge is the floor.
      */}
      <div data-tails-chat-stage className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto px-10 py-6"
        >
          <div data-tails-chat-column className="mx-auto flex max-w-2xl flex-col gap-4">
            {rows.length === 0 && !busy ? (
              <EmptyState
                cwd={cwd}
                model={model}
                onPick={(prompt) => composerRef.current?.fill(prompt)}
              />
            ) : null}

            {rows.map((row) => (
              <Row key={row.id} row={row} voice={voicedBy} />
            ))}

            {/* Only while nothing is streaming — once tokens are arriving the
                text itself is the progress indicator. */}
            {/*
              Shown whenever the turn is running and nothing is arriving.

              The test used to be "the last row is not an assistant message",
              which hid the indicator for the whole gap between a finished text
              block and the tool call that follows it — several seconds of a
              running turn with no sign of life anywhere on screen. That is the
              reported "period of nothingness", and it was this line.

              The right question is whether tokens are *currently* streaming: the
              streaming row has its own caret, so an indicator beside it would be
              two things saying the same thing. Any other moment in a running
              turn is a wait, and a wait needs saying.
            */}
            {/*
              After the rows and before the waiting indicator, so a turn that has
              finished reads as finished. Only when idle: a duration shown while
              the next turn is running would be describing the previous one.
            */}
            {!busy && lastTurnMs !== undefined ? <TurnFooter ms={lastTurnMs} /> : null}

            {busy && !isStreaming(rows[rows.length - 1]) ? (
              <ThinkingIndicator petPhrases={pet?.phrases} />
            ) : null}

            {error ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            ) : null}
          </div>
        </div>

        {/*
          The overlay layer, and the only one: anything that lives *over* the
          chat rather than *in* it mounts here. It does not scroll with the
          transcript, it never takes a click, and it is inert to assistive
          tech, so whatever occupies it stays decorative.

          A component inside it can measure three things from the DOM, which is
          everything it needs and nothing it has to be handed as a prop:
            - `[data-tails-chat-stage]` — the world. Its box is the walkable
              area; the bottom edge is the floor, since the stage stops where
              the composer starts.
            - `[data-tails-chat-column]` — the output column. Its box is the
              region to keep out of; the gaps to its left and right, in stage
              coordinates, are the free bands. It scrolls, so it is worth
              re-reading rather than caching.
            - this element — the layer's own box, to convert between the two.
        */}
        <div
          data-tails-chat-overlay
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
        />

        {/* The wake-word reaction. Inside the stage so it frames the
            conversation and stops at the composer, which is the boundary that
            makes it read as "the chat is listening" rather than as a window
            border. */}
        <VoiceGlow voice={voice} />
      </div>

      {/* No rule above the composer: the input already reads as its own surface,
          and a full-width line under a rounded field is a seam, not structure. */}
      <div className="px-10 pb-4 pt-2">
        <div className="mx-auto max-w-2xl space-y-3">
          {pendingPrompts.map((prompt) => (
            prompt.kind === 'question' ? (
              <QuestionCard
                key={prompt.requestId}
                requestId={prompt.requestId}
                questions={prompt.questions}
                onAnswer={answerQuestion}
              />
            ) : (
              <PlanCard
                key={prompt.requestId}
                requestId={prompt.requestId}
                plan={prompt.plan}
                onAnswer={answerPlan}
              />
            )
          ))}

          <VoiceModeStrip voice={voice} onSpeakIntro={speech.speak} />

          {pendingPermissions.map((permission) => (
            <PermissionBanner
              key={permission.requestId}
              permission={permission}
              onAnswer={answerPermission}
            />
          ))}
        </div>

        <Composer
          ref={composerRef}
          sessionId={sessionId}
          busy={busy}
          mode={mode}
          onModeChange={changeMode}
          onSend={submit}
          onAbort={abort}
          suggestion={suggestion}
          onSuggestionDismiss={clearSuggestion}
          onAssignPet={() => setPetPickerOpen(true)}
          petName={pet?.name ?? null}
          models={catalogue.models}
          fallbackModel={catalogue.current}
          turnSettings={turnSettings}
          onTurnSettingsChange={changeTurnSettings}
          voice={voice}
        />
      </div>

      {petPickerOpen && sessionId ? (
        <PetPicker
          sessionId={sessionId}
          petId={pet?.id ?? null}
          onAssigned={setPet}
          onClose={() => setPetPickerOpen(false)}
        />
      ) : null}
    </div>
  );
}
