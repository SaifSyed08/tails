import {
  ArrowUp,
  AudioLines,
  Ear,
  ImagePlus,
  Loader2,
  Mic,
  MicOff,
  Paperclip,
  PawPrint,
  Plus,
  Sparkles,
  Square,
  Volume2,
  Wand2,
  X,
} from 'lucide-react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';

import { ModelPicker } from '@/components/chat/ModelPicker';
import {
  describeVoiceControl,
  runVoiceAction,
  type VoiceModeState,
} from '@/components/chat/voice-contract';
import {
  CommandToken,
  readStyledCommand,
  type StyledCommandName,
} from '@/components/chat/commandStyle';
import { api, type SlashCommand } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/shared/ui/Motion';
import type {
  AttachmentPayload,
  ModelChoice,
  PermissionMode,
  TurnSettings,
} from '@/types/chat';

/**
 * The permission modes offered in the UI, with their labels.
 *
 * The values themselves live in `types/chat` because the hook and the server
 * both speak them; this table is only how they are named on screen.
 */
export const PERMISSION_MODES: {
  value: PermissionMode;
  label: string;
  hint: string;
}[] = [
  { value: 'default', label: 'Ask each time', hint: 'Approve every tool call' },
  { value: 'acceptEdits', label: 'Auto-accept edits', hint: 'File edits run without asking' },
  { value: 'plan', label: 'Plan first', hint: 'Propose a plan before doing anything' },
];

/** 15MB before base64; past that the websocket frame becomes the problem. */
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

/**
 * The composer's own corner radius, in terms of the theme's.
 *
 * Set as the surface token rather than a `rounded-*` class: the part rules in
 * `index.css` own `border-radius` at (0,2,0), so a utility here would never
 * paint. Expressed relative to `--radius` so a theme with sharper or softer
 * corners still moves this with it.
 */
const COMPOSER_RADIUS = 'calc(var(--radius) + 0.85rem)';

/**
 * Focus and drop feedback, as a glow rather than a ring.
 *
 * Same reasoning as the radius: `box-shadow` is a themed token, so the focus
 * state sets the token instead of adding a `ring-*` utility that the part
 * rule would outrank.
 */
const DROP_GLOW = '0 0 0 1px hsl(var(--primary) / 0.5), 0 10px 34px -10px hsl(var(--primary) / 0.6)';

/**
 * Reads a File into the base64 shape the wire protocol carries.
 *
 * The data-URL prefix is stripped here rather than server-side so the field
 * means exactly one thing everywhere it appears.
 */
async function readAttachment(file: File): Promise<AttachmentPayload | null> {
  if (file.size > MAX_ATTACHMENT_BYTES) return null;

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;

  return {
    name: file.name || 'pasted',
    mediaType: file.type || 'application/octet-stream',
    data: dataUrl.slice(comma + 1),
  };
}

type ComposerMenuProps = {
  onPickFiles: () => void;
  onPickImages: () => void;
  onPersonalize: () => void;
  onAssignPet: () => void;
  /** The pet this conversation already has, shown so the entry reads as state. */
  petName: string | null;
};

/**
 * An entry that exists but does not work yet, and says so.
 *
 * Shipped as its own shape rather than as a disabled row: a greyed-out item
 * tells the user nothing about why, and these two both have a real reason.
 * Clicking gives the reason instead of silence.
 */
type NotYetEntry = { title: string; detail: string };

const NOT_YET: Record<'generate' | 'dictation' | 'wakeWord', NotYetEntry> = {
  generate: {
    title: 'Generate',
    detail: 'The entry point is here, but nothing is wired behind it yet — no generators have been defined. Ask for one and it lands here.',
  },
  dictation: {
    // The old copy blamed the browser's speech API for uploading audio. That
    // stopped being the reason the day on-device transcription was benchmarked
    // as workable, and a blocker that no longer exists is just a wrong answer.
    title: 'Dictation',
    detail: 'Dictation runs on-device — nothing is uploaded. It needs a one-time 78 MB model download first. The microphone button beside the send arrow is where it lives.',
  },
  wakeWord: {
    /*
      Not a to-do. Both usable engines are ruled out for reasons that will not
      change by working harder at them, and an entry reading "soon" would imply
      otherwise — so this says unavailable, and says why.
    */
    title: 'Wake word',
    detail: '"Hey T.A.I.L.S." is not planned. The two usable engines are out: openWakeWord’s pretrained weights are non-commercial, which an MIT app cannot ship, and Porcupine now validates over the network and ended its free tier. A wake name you could choose yourself needs a classifier trained per phrase.',
  },
};

/**
 * How long the menu survives the pointer leaving it.
 *
 * Long enough to round the corner of the button or clip the edge of the panel
 * without losing the menu, short enough that a deliberate exit still reads as
 * a dismissal.
 */
const MENU_CLOSE_DELAY_MS = 200;

/**
 * The `+` and the menu behind it.
 *
 * Three things keep it reachable, and it needed all three. The trigger and the
 * panel share one hover region, so travelling between them never leaves it.
 * The space between them is padding inside that region rather than margin
 * outside it — that gap was the bug: the panel is a DOM child, so arriving is
 * fine, but the 8px of dead space on the way closed the menu before the
 * pointer could get there. And leaving is deferred, so clipping an edge does
 * not dismiss it.
 *
 * A menu opened by click or by keyboard is pinned: pointer drift must not take
 * away something deliberately opened. Those close on Escape, on a click
 * outside, or when focus leaves.
 */
function ComposerMenu({
  onPickFiles, onPickImages, onPersonalize, onAssignPet, petName,
}: ComposerMenuProps) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [notYet, setNotYet] = useState<NotYetEntry | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeTimerRef = useRef<number | undefined>(undefined);

  // Both stable: they touch only refs and setters. That matters for the
  // outside-click listener below, which would otherwise be torn down and
  // re-attached on every render.
  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== undefined) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = undefined;
    }
  }, []);

  const close = useCallback((returnFocus = false) => {
    cancelClose();
    setOpen(false);
    setPinned(false);
    setNotYet(null);
    if (returnFocus) triggerRef.current?.focus();
  }, [cancelClose]);

  /** Pointer-driven exit only; a pinned menu ignores it. */
  const scheduleClose = () => {
    if (pinned) return;
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = undefined;
      setOpen(false);
      setNotYet(null);
    }, MENU_CLOSE_DELAY_MS);
  };

  useEffect(() => cancelClose, [cancelClose]);

  // A pinned menu has to answer to the rest of the window, since the pointer
  // leaving is no longer what dismisses it.
  useEffect(() => {
    if (!open || !pinned) return undefined;

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node | null)) close();
    };

    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, pinned, close]);

  const choose = (pick: () => void) => {
    close();
    pick();
  };

  // `whitespace-nowrap`: the trailing state labels ("Blue Slime", "soon")
  // otherwise squeeze the two-word entries onto a second line.
  const itemClass = 'flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm transition-colors duration-instant hover:bg-accent focus-visible:bg-accent focus-visible:outline-none';

  return (
    <div
      ref={rootRef}
      className="relative"
      onPointerEnter={() => {
        cancelClose();
        setOpen(true);
      }}
      onPointerLeave={scheduleClose}
      onFocus={() => {
        // Arriving by keyboard pins it: there is no pointer to keep it alive.
        cancelClose();
        setOpen(true);
        setPinned(true);
      }}
      onBlur={(event) => {
        // Only when focus actually left the group; moving between the button
        // and a menu item fires blur too.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          close(true);
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (open && pinned) {
            close();
            return;
          }
          // Opened deliberately, so it stays until dismissed deliberately.
          cancelClose();
          setOpen(true);
          setPinned(true);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More"
        title="Attach, personalize, and more"
        className={cn(
          'rounded-full p-2 text-muted-foreground transition-all duration-quick ease-standard',
          'hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none',
          open && 'bg-accent text-foreground',
        )}
      >
        <Plus className={cn('size-4 transition-transform duration-quick ease-emphasis', open && 'rotate-45')} />
      </button>

      {open ? (
        // `pb-2` here rather than `mb-2` on the panel: the spacing sits inside
        // this element's box, so it is part of the hover region instead of a
        // hole between two of them.
        <div className="absolute bottom-full left-0 z-30 pb-2">
        <div
          role="menu"
          data-tails-part="popover"
          // The composer sets a much larger radius on itself, and custom
          // properties inherit — without this the menu would take the
          // composer's pill corners.
          style={{ '--t-radius': 'var(--radius)' } as React.CSSProperties}
          className="animate-scale-in w-60 overflow-hidden py-1 shadow-lg"
        >
          {notYet ? (
            <div className="px-3 py-2">
              <p className="text-sm font-medium">{notYet.title}</p>
              <p className="mt-1 text-xs text-muted-foreground">{notYet.detail}</p>
              <button
                type="button"
                autoFocus
                onClick={() => setNotYet(null)}
                className="mt-2 rounded-md border border-border px-2 py-1 text-xs transition-colors duration-quick hover:bg-accent"
              >
                Back
              </button>
            </div>
          ) : (
            <>
              <button type="button" role="menuitem" onClick={() => choose(onPickFiles)} className={itemClass}>
                <Paperclip className="size-4 text-muted-foreground" aria-hidden="true" />
                Attach files
              </button>
              <button type="button" role="menuitem" onClick={() => choose(onPickImages)} className={itemClass}>
                <ImagePlus className="size-4 text-muted-foreground" aria-hidden="true" />
                Attach images
              </button>

              <div className="my-1 h-px bg-border" role="separator" />

              <button type="button" role="menuitem" onClick={() => choose(onPersonalize)} className={itemClass}>
                <Wand2 className="size-4 text-muted-foreground" aria-hidden="true" />
                Personalize
              </button>
              <button type="button" role="menuitem" onClick={() => choose(onAssignPet)} className={itemClass}>
                <PawPrint className="size-4 text-muted-foreground" aria-hidden="true" />
                Assign pet
                {petName ? (
                  <span className="ml-auto max-w-[7rem] truncate text-xs text-muted-foreground">{petName}</span>
                ) : null}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => setNotYet(NOT_YET.generate)}
                className={itemClass}
              >
                <Sparkles className="size-4 text-muted-foreground" aria-hidden="true" />
                Generate
                <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground/70">soon</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => setNotYet(NOT_YET.dictation)}
                className={itemClass}
              >
                <Mic className="size-4 text-muted-foreground" aria-hidden="true" />
                Dictation
                <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground/70">on-device</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => setNotYet(NOT_YET.wakeWord)}
                className={itemClass}
              >
                <Ear className="size-4 text-muted-foreground" aria-hidden="true" />
                Wake word
                {/* Not "soon": this one is not coming, and the label should
                    not promise otherwise. */}
                <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground/70">unavailable</span>
              </button>
            </>
          )}
        </div>
        </div>
      ) : null}
    </div>
  );
}

type ComposerProps = {
  sessionId: string | null;
  busy: boolean;
  mode: PermissionMode;
  onModeChange: (mode: PermissionMode) => void;
  onSend: (content: string, attachments: AttachmentPayload[]) => void;
  onAbort: () => void;
  /**
   * The agent's guess at the user's next message, if it offered one.
   *
   * Shown as ghost text and accepted with Tab. It is a suggestion, never
   * content: nothing is sent until the user sends it.
   */
  suggestion?: string | null;
  /** Called once the suggestion has been accepted or typed over. */
  onSuggestionDismiss?: () => void;
  /** Opens the pet picker. Owned above so the dialog is not trapped in here. */
  onAssignPet: () => void;
  /** The models this account may pick, and the one running by default. */
  models: ModelChoice[];
  fallbackModel: ModelChoice | null;
  turnSettings: TurnSettings;
  onTurnSettingsChange: (settings: TurnSettings) => void;
  /** The conversation's assigned pet, shown against the menu entry. */
  petName?: string | null;
  /**
   * The dictation control, owned by the voice module.
   *
   * Absent means unavailable, which is the honest default until that module is
   * wired: the button renders disabled and explains itself rather than
   * pretending to work.
   */
  voice?: VoiceModeState;
};

/**
 * What the rest of the app can do to the composer from outside.
 *
 * Imperative rather than a `value` prop for the same reason `focus()` is: the
 * draft belongs to the composer, and picking an opener on the empty state is
 * an event, not a new state to keep two components agreeing about.
 */
export type ComposerHandle = {
  /** Replaces the draft and puts the caret in it. */
  fill: (text: string) => void;
  /**
   * Adds to the draft rather than replacing it.
   *
   * This is how dictated text arrives: someone may have typed half a sentence
   * before reaching for the microphone, and losing it would be the worst
   * possible response to speaking.
   */
  append: (text: string) => void;
};

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer({
  sessionId, busy, mode, onModeChange, onSend, onAbort, suggestion, onSuggestionDismiss,
  onAssignPet, petName, models, fallbackModel, turnSettings, onTurnSettingsChange, voice,
}, ref) {
  const reduced = useReducedMotion();
  const voiceControl = describeVoiceControl(voice);
  const [draft, setDraft] = useState('');
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [attachments, setAttachments] = useState<AttachmentPayload[]>([]);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  // Commands are fetched once per conversation rather than per keystroke:
  // enumerating them spawns a CLI subprocess.
  useEffect(() => {
    if (!sessionId) return undefined;
    let cancelled = false;

    api.listCommands(sessionId)
      .then((entries) => {
        if (!cancelled) setCommands(entries);
      })
      .catch(() => {
        if (!cancelled) setCommands([]);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useImperativeHandle(ref, () => ({
    fill: (text: string) => {
      setDraft(text);
      textareaRef.current?.focus();
    },
    append: (text: string) => {
      const addition = text.trim();
      if (!addition) return;
      // Spaced against whatever is already there, unless the draft is empty or
      // already ends in whitespace.
      setDraft((current) => (current && !/\s$/.test(current) ? `${current} ${addition}` : `${current}${addition}`));
      textareaRef.current?.focus();
    },
  }), []);

  // The palette opens only for a slash at the very start of the input, so a
  // path like `src/a.ts` mid-sentence never triggers it.
  const paletteQuery = useMemo(() => {
    const match = /^\/([\w-]*)$/.exec(draft);
    return match ? match[1].toLowerCase() : null;
  }, [draft]);

  const matches = useMemo(() => {
    if (paletteQuery === null) return [];
    return commands
      .filter((command) => command.name.toLowerCase().startsWith(paletteQuery))
      .slice(0, 8);
  }, [commands, paletteQuery]);

  const paletteOpen = matches.length > 0;

  // Clamped at read time rather than reset from an effect: the selection only
  // needs to be valid for the list currently on screen, and resetting through
  // state would re-render the palette an extra time on every keystroke.
  const selectedIndex = Math.min(paletteIndex, Math.max(0, matches.length - 1));

  const addFiles = async (files: FileList | File[]) => {
    const read = await Promise.all([...files].map(readAttachment));
    // Cap at eight; a caller dropping a folder should not silently send fifty.
    setAttachments((current) => [
      ...current,
      ...read.filter((entry): entry is AttachmentPayload => entry !== null),
    ].slice(0, 8));
  };

  const submit = () => {
    const content = draft.trim();
    if ((!content && attachments.length === 0) || busy) return;
    setDraft('');
    setAttachments([]);
    onSend(content || 'Have a look at this.', attachments);
  };

  /**
   * Starts a `/personalize`.
   *
   * Filled rather than sent, and with the trailing space the palette leaves,
   * so the look can be described in the same breath — sending it bare is a
   * valid move (the command asks what you want), but it should be the user's
   * move, not the menu's.
   */
  const personalize = () => {
    setDraft('/personalize ');
    onSuggestionDismiss?.();
    textareaRef.current?.focus();
  };

  const acceptCommand = (command: SlashCommand) => {
    // Leaves a trailing space so an argument hint can be typed straight away.
    setDraft(`/${command.name} `);
    textareaRef.current?.focus();
  };

  const cycleMode = (backwards: boolean) => {
    const index = PERMISSION_MODES.findIndex((entry) => entry.value === mode);
    const next = (index + (backwards ? -1 : 1) + PERMISSION_MODES.length) % PERMISSION_MODES.length;
    onModeChange(PERMISSION_MODES[next].value);
  };

  /**
   * Whether the suggestion is currently on offer.
   *
   * Only against an empty input: once there are words in the box, the user is
   * writing their own message and Tab belongs to whatever it normally does.
   */
  const ghostVisible = Boolean(suggestion) && draft.length === 0 && !busy;

  const acceptSuggestion = () => {
    if (!suggestion) return;
    // Into the draft, not out the door. "Accept" means the user gets to look
    // at it and edit it; auto-sending would make a mistyped Tab unrecoverable.
    setDraft(suggestion);
    onSuggestionDismiss?.();
    textareaRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Shift+Tab cycles permission mode, matching Claude Code's own shortcut.
    if (event.key === 'Tab' && event.shiftKey && !paletteOpen) {
      event.preventDefault();
      cycleMode(true);
      return;
    }

    if (paletteOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setPaletteIndex((selectedIndex + 1) % matches.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setPaletteIndex((selectedIndex - 1 + matches.length) % matches.length);
        return;
      }
      if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault();
        acceptCommand(matches[selectedIndex]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDraft('');
        return;
      }
    }

    // Third in line for Tab, behind the mode cycle and the command palette:
    // both of those are things the user has deliberately invoked, and this is
    // an offer they can simply ignore.
    if (event.key === 'Tab' && !event.shiftKey && ghostVisible) {
      event.preventDefault();
      acceptSuggestion();
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const activeMode = PERMISSION_MODES.find((entry) => entry.value === mode) ?? PERMISSION_MODES[0];
  const armedCommand = readStyledCommand(draft);

  return (
    <div className="relative mx-auto max-w-2xl space-y-2">
      {paletteOpen ? (
        <div
          data-tails-part="popover"
          className="animate-scale-in absolute bottom-full left-0 z-20 mb-2 w-full overflow-hidden"
        >
          {matches.map((command, index) => (
            <button
              key={command.name}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => acceptCommand(command)}
              className={cn(
                'flex w-full items-baseline gap-2 px-3 py-2 text-left transition-colors duration-instant',
                index === selectedIndex ? 'bg-accent' : 'hover:bg-accent/50',
              )}
            >
              {readStyledCommand(`/${command.name}`) ? (
                <CommandToken
                  name={command.name as StyledCommandName}
                  className="font-mono text-sm"
                />
              ) : (
                <span className="font-mono text-sm">/{command.name}</span>
              )}
              {command.argumentHint ? (
                <span className="font-mono text-xs text-muted-foreground">{command.argumentHint}</span>
              ) : null}
              <span className="ml-auto truncate text-xs text-muted-foreground">
                {command.description}
              </span>
              {command.local ? (
                /*
                  Filled with the accent rather than tinted by it. As
                  `text-primary` on `bg-primary/15` this measured 4.27:1 — the
                  same hue tinting its own background, so every step of tint
                  moves the ground *toward* the ink and makes it worse, not
                  better (at /30 it is 3.40:1). No token value fixes that
                  either, and `--t-accent-on` resolves to `--primary` on the
                  built-in ramp, so it would change nothing here.

                  `--primary` against `--primary-foreground` is the one accent
                  pairing the appearance module's contrast gate asserts for
                  every generated theme, so this stays legible under a re-theme
                  rather than only under today's ramp: 5.28:1 light, 7.53:1
                  dark, against the 4.5:1 that 10px label text needs.
                */
                <span className="rounded bg-primary px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-primary-foreground">
                  tails
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      {attachments.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {attachments.map((attachment, index) => (
            <span
              key={`${attachment.name}-${index}`}
              className="animate-scale-in flex items-center gap-1.5 rounded-full border border-border bg-muted/60 py-1 pl-1.5 pr-2 text-xs"
            >
              {attachment.mediaType.startsWith('image/') ? (
                <img
                  src={`data:${attachment.mediaType};base64,${attachment.data}`}
                  alt=""
                  className="size-5 rounded-full object-cover"
                />
              ) : (
                <Paperclip className="size-3 text-muted-foreground" aria-hidden="true" />
              )}
              <span className="max-w-[14rem] truncate">{attachment.name}</span>
              <button
                type="button"
                onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}
                aria-label={`Remove ${attachment.name}`}
                className="text-muted-foreground hover:text-destructive"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {/* `input` rather than a composer-specific part: the surface list is
          closed, and the composer is the app's primary text field — a theme
          that styles typing should style it here too. */}
      <div
        data-tails-part="input"
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (event.dataTransfer.files.length > 0) void addFiles(event.dataTransfer.files);
        }}
        style={{
          '--t-radius': COMPOSER_RADIUS,
          // Inline so it outranks the focus glow below: while a file is over
          // the composer, that is the state worth showing.
          ...(dragging ? { '--t-shadow': DROP_GLOW } : {}),
        } as React.CSSProperties}
        className={cn(
          // Roomier than the old shell: at this corner radius, tight padding
          // puts the round buttons inside the curve.
          'flex items-end gap-2 p-2.5 transition-shadow duration-settle ease-standard',
          // A glow instead of an outline, but still an unmistakable one: this
          // is the focus indicator for anyone navigating by keyboard.
          'focus-within:[--t-shadow:0_0_0_1px_hsl(var(--ring)/0.45),0_12px_36px_-12px_hsl(var(--ring)/0.55),0_0_0_6px_hsl(var(--ring)/0.1)]',
        )}
      >
        <ComposerMenu
          onPickFiles={() => fileInputRef.current?.click()}
          onPickImages={() => imageInputRef.current?.click()}
          onPersonalize={personalize}
          onAssignPet={onAssignPet}
          petName={petName ?? null}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files) void addFiles(event.target.files);
            event.target.value = '';
          }}
        />
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files) void addFiles(event.target.files);
            event.target.value = '';
          }}
        />

        <div className="relative flex-1">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              // The moment the user writes anything of their own, the guess is
              // stale — including if they delete back to empty.
              if (suggestion) onSuggestionDismiss?.();
            }}
            onKeyDown={onKeyDown}
            onPaste={(event) => {
              const files = [...event.clipboardData.files];
              if (files.length === 0) return;
              event.preventDefault();
              void addFiles(files);
            }}
            rows={1}
            // The ghost text draws itself; leaving the placeholder on would
            // print the two on top of each other.
            placeholder={ghostVisible ? '' : 'Ask anything'}
            aria-label="Message"
            aria-describedby={ghostVisible ? 'composer-suggestion' : undefined}
            className="max-h-48 w-full resize-none bg-transparent px-1 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
          />

          {ghostVisible ? (
            <>
              {/* Muted and italic so it never reads as something the user
                  typed, and inert so a click lands in the textarea under it. */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 flex items-start gap-2 px-1 py-1.5 text-sm"
              >
                <span className="min-w-0 truncate italic text-muted-foreground/70">{suggestion}</span>
                <span className="shrink-0 rounded border border-border px-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                  tab
                </span>
              </div>
              {/* Announced as what it is — an offer — rather than read out as
                  the contents of the user's own input. */}
              <span id="composer-suggestion" className="sr-only">
                {`Suggested reply: ${suggestion}. Press Tab to accept it.`}
              </span>
            </>
          ) : null}
        </div>

        {/*
          The microphone, and the only honest indicator that this app is
          listening.

          `waiting` — armed for a wake word — is the state that matters here.
          The microphone is open and nothing is being captured, and it must not
          read as "off": it gets its own icon, its own accessible name that says
          the microphone is on, its own ring, and a live level meter. A
          permanently open microphone that looks identical to a closed one is
          the failure this whole feature exists to avoid.

          State is carried by shape and by name as well as by colour and motion.
          An indicator that exists only as a pulse is invisible to anyone who
          has motion turned off, and "is my microphone on?" must never be a
          guess.
        */}
        <button
          type="button"
          onClick={() => runVoiceAction(voice, voiceControl.action)}
          disabled={voiceControl.disabled}
          aria-label={voiceControl.label}
          aria-pressed={voiceControl.pressed}
          aria-busy={voiceControl.mode === 'transcribing'}
          title={voiceControl.title}
          className={cn(
            'relative rounded-full p-2 transition-colors duration-quick',
            voiceControl.mode === 'listening' && 'bg-primary text-primary-foreground',
            // Open-but-idle is deliberately not the capture colour: it reads as
            // armed rather than recording, while still being unmistakably on.
            voiceControl.mode === 'waiting'
              && 'text-primary ring-2 ring-inset ring-primary/60',
            voiceControl.mode === 'speaking' && 'text-primary',
            !voiceControl.live && voiceControl.mode !== 'listening'
              && 'text-muted-foreground hover:bg-accent hover:text-foreground',
            voiceControl.disabled && 'opacity-40 hover:bg-transparent hover:text-muted-foreground',
          )}
        >
          {voiceControl.mode === 'listening' && !reduced ? (
            // The same ping the thinking indicator uses, so "something is
            // live" reads the same way everywhere in the app.
            <span
              className="absolute inset-0 animate-ping rounded-full bg-primary opacity-60"
              aria-hidden="true"
            />
          ) : null}

          {voiceControl.live ? (
            /*
              The level meter. Scaled from the actual input, so it moves when
              the room is heard and sits still when it is not — which is what
              makes an open microphone believable rather than merely claimed.
              Rendered regardless of reduced-motion: it is not decoration, it
              is the evidence.
            */
            <span
              className="pointer-events-none absolute inset-0 rounded-full bg-primary/25"
              style={{ transform: `scale(${1 + Math.min(0.6, (voice?.level ?? 0) * 1.6)})` }}
              aria-hidden="true"
            />
          ) : null}

          {voiceControl.glyph === 'working' ? (
            <Loader2 className={cn('relative size-4', !reduced && 'animate-spin')} />
          ) : voiceControl.glyph === 'muted' ? (
            <MicOff className="relative size-4" />
          ) : voiceControl.glyph === 'armed' ? (
            <AudioLines className="relative size-4" />
          ) : voiceControl.glyph === 'speaking' ? (
            <Volume2 className="relative size-4" />
          ) : (
            <Mic className="relative size-4" />
          )}
        </button>

        {busy ? (
          <button
            type="button"
            onClick={onAbort}
            aria-label="Stop"
            className="rounded-full bg-muted p-2 text-muted-foreground transition-colors duration-quick hover:bg-accent"
          >
            <Square className="size-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim() && attachments.length === 0}
            aria-label="Send"
            className={cn(
              'rounded-full p-2 transition-transform duration-instant ease-emphasis active:scale-95',
              draft.trim() || attachments.length > 0
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground',
            )}
          >
            <ArrowUp className="size-4" />
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 px-1">
        <button
          type="button"
          onClick={() => cycleMode(false)}
          title={`${activeMode.hint} — Shift+Tab to cycle`}
          className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
        >
          <span
            className={cn(
              'size-1.5 rounded-full',
              mode === 'default' && 'bg-muted-foreground',
              mode === 'acceptEdits' && 'bg-warning',
              mode === 'plan' && 'bg-primary',
            )}
            aria-hidden="true"
          />
          {activeMode.label}
          <span className="opacity-50">shift + tab</span>
        </button>

        {/* A textarea cannot style a run of its own text, so the command the
            draft is carrying is shown beside it rather than inside it — which
            also survives the user scrolling the input. */}
        {armedCommand ? (
          <span className="flex items-center gap-1 text-xs">
            <CommandToken name={armedCommand.name} className="text-xs">
              {armedCommand.token}
            </CommandToken>
            {/* Named, not just coloured. `ultracode` arms on the bare word, so
                someone who typed it without meaning to needs to be told what
                it is about to do, not merely that something is highlighted. */}
            <span className="text-muted-foreground">
              {armedCommand.name === 'ultracode' ? 'subagents, in parallel' : 'redesigning the app'}
            </span>
          </span>
        ) : null}

        {/*
          Right-aligned, and last in the row so the margin does the work rather
          than a spacer element. It sits opposite the permission mode on
          purpose: both answer "how will this turn run", and putting them at
          either end keeps the middle free for the armed-command chip, which
          appears and disappears as you type and would otherwise shove them
          both sideways mid-sentence.
        */}
        <div className="ml-auto">
          <ModelPicker
            models={models}
            fallback={fallbackModel}
            settings={turnSettings}
            onChange={onTurnSettingsChange}
          />
        </div>
      </div>
    </div>
  );
});
