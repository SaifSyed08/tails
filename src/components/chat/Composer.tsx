import { ArrowUp, Paperclip, Square, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { api, type SlashCommand } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * The permission modes offered in the UI.
 *
 * `bypassPermissions` is deliberately absent: it resolves permissions before
 * the app's callback runs, which would silently stop questions and plans ever
 * reaching the user.
 */
export const PERMISSION_MODES = [
  { value: 'default', label: 'Ask each time', hint: 'Approve every tool call' },
  { value: 'acceptEdits', label: 'Auto-accept edits', hint: 'File edits run without asking' },
  { value: 'plan', label: 'Plan first', hint: 'Propose a plan before doing anything' },
] as const;

export type PermissionMode = typeof PERMISSION_MODES[number]['value'];

/** A file staged for the next message. */
export type Attachment = {
  name: string;
  mediaType: string;
  /** Base64 without the data-URL prefix, which is what the SDK expects. */
  data: string;
};

/** 15MB before base64; past that the websocket frame becomes the problem. */
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

/**
 * Reads a File into the base64 shape the wire protocol carries.
 *
 * The data-URL prefix is stripped here rather than server-side so the field
 * means exactly one thing everywhere it appears.
 */
async function readAttachment(file: File): Promise<Attachment | null> {
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

type ComposerProps = {
  sessionId: string | null;
  busy: boolean;
  mode: PermissionMode;
  onModeChange: (mode: PermissionMode) => void;
  onSend: (content: string, attachments: Attachment[]) => void;
  onAbort: () => void;
};

export function Composer({
  sessionId, busy, mode, onModeChange, onSend, onAbort,
}: ComposerProps) {
  const [draft, setDraft] = useState('');
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    setAttachments((current) => [...current, ...read.filter((entry): entry is Attachment => entry !== null)].slice(0, 8));
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

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const activeMode = PERMISSION_MODES.find((entry) => entry.value === mode) ?? PERMISSION_MODES[0];

  return (
    <div className="relative mx-auto max-w-3xl space-y-2">
      {paletteOpen ? (
        <div className="animate-scale-in absolute bottom-full left-0 z-20 mb-2 w-full overflow-hidden rounded-xl border border-border bg-popover shadow-xl">
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
              className="animate-scale-in flex items-center gap-1.5 rounded-md border border-border bg-muted/60 px-2 py-1 text-xs"
            >
              <Paperclip className="size-3 text-muted-foreground" aria-hidden="true" />
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

      <div
        data-tails-part="composer"
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
        className={cn(
          'flex items-end gap-2 rounded-2xl border bg-card p-2 transition-shadow duration-quick ease-standard focus-within:ring-2 focus-within:ring-ring',
          dragging ? 'border-primary ring-2 ring-primary/40' : 'border-border',
        )}
      >
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          title="Attach files or images"
          aria-label="Add attachment"
          className="rounded-lg p-2 text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
        >
          <Paperclip className="size-4" />
        </button>
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

        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            if (files.length === 0) return;
            event.preventDefault();
            void addFiles(files);
          }}
          rows={1}
          placeholder="Ask T.A.I.L.S. anything — / for commands"
          aria-label="Message"
          className="max-h-48 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
        />

        {busy ? (
          <button
            type="button"
            onClick={onAbort}
            aria-label="Stop"
            className="rounded-lg bg-muted p-2 text-muted-foreground transition-colors duration-quick hover:bg-accent"
          >
            <Square className="size-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim()}
            aria-label="Send"
            className={cn(
              'rounded-lg p-2 transition-transform duration-instant ease-emphasis active:scale-95',
              draft.trim() ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
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
          <span className="opacity-50">⇧⇥</span>
        </button>
      </div>
    </div>
  );
}
