import { ArrowUp, ImagePlus, Paperclip, Plus, Square, X } from 'lucide-react';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';

import { api, type SlashCommand } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { AttachmentPayload, PermissionMode } from '@/types/chat';

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

type AttachMenuProps = {
  onPickFiles: () => void;
  onPickImages: () => void;
};

/**
 * The `+` and the menu behind it.
 *
 * Hover opens it, but so does focus and so does a click — a menu that only
 * exists on hover is a menu a keyboard cannot reach. Closing is deliberately
 * lazier than opening: `pointerleave` on the whole group rather than on the
 * button, so crossing the gap between the button and the menu does not
 * dismiss it mid-reach.
 */
function AttachMenu({ onPickFiles, onPickImages }: AttachMenuProps) {
  const [open, setOpen] = useState(false);
  const groupRef = useRef<HTMLDivElement>(null);

  const choose = (pick: () => void) => {
    setOpen(false);
    pick();
  };

  return (
    <div
      ref={groupRef}
      className="relative"
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        // Only when focus actually left the group; moving between the button
        // and a menu item fires blur too.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Add attachment"
        title="Add attachment"
        className={cn(
          'rounded-full p-2 text-muted-foreground transition-all duration-quick ease-standard',
          'hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none',
          open && 'bg-accent text-foreground',
        )}
      >
        <Plus className={cn('size-4 transition-transform duration-quick ease-emphasis', open && 'rotate-45')} />
      </button>

      {open ? (
        <div
          role="menu"
          data-tails-part="popover"
          // The composer sets a much larger radius on itself, and custom
          // properties inherit — without this the menu would take the
          // composer's pill corners.
          style={{ '--t-radius': 'var(--radius)' } as React.CSSProperties}
          className="animate-scale-in absolute bottom-full left-0 z-30 mb-2 w-48 overflow-hidden py-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => choose(onPickFiles)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors duration-instant hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
          >
            <Paperclip className="size-4 text-muted-foreground" aria-hidden="true" />
            Attach files
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => choose(onPickImages)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors duration-instant hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
          >
            <ImagePlus className="size-4 text-muted-foreground" aria-hidden="true" />
            Attach images
          </button>
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
};

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer({
  sessionId, busy, mode, onModeChange, onSend, onAbort, suggestion, onSuggestionDismiss,
}, ref) {
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
              <span className="font-mono text-sm">/{command.name}</span>
              {command.argumentHint ? (
                <span className="font-mono text-xs text-muted-foreground">{command.argumentHint}</span>
              ) : null}
              <span className="ml-auto truncate text-xs text-muted-foreground">
                {command.description}
              </span>
              {command.local ? (
                <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-primary">
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
        <AttachMenu
          onPickFiles={() => fileInputRef.current?.click()}
          onPickImages={() => imageInputRef.current?.click()}
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
      </div>
    </div>
  );
});
