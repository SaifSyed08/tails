import { Check, FolderOpen, PanelLeftOpen, SquareTerminal, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

type HeaderProps = {
  sessionTitle: string;
  cwd: string;
  sidebarCollapsed: boolean;
  terminalOpen: boolean;
  onToggleSidebar: () => void;
  onRenameSession: (title: string) => void;
  onChangeCwd: (cwd: string) => void;
  onToggleTerminal: () => void;
};

/**
 * An inline field that turns into an input when clicked.
 *
 * Used for both the conversation name and the working folder. Commits on Enter
 * or blur, abandons on Escape — the behaviour people already expect from a
 * renameable label, so it needs no affordance beyond the hover state.
 */
function EditableLabel({
  value,
  onCommit,
  placeholder,
  className,
  inputClassName,
  ariaLabel,
}: {
  value: string;
  onCommit: (next: string) => void;
  placeholder: string;
  className?: string;
  inputClassName?: string;
  ariaLabel: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  // The draft is seeded when edit mode is entered rather than synced from an
  // effect: the display path already renders `value` directly, so there is
  // nothing to keep in step while not editing.
  const beginEdit = () => {
    setDraft(value);
    setEditing(true);
  };

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== value) onCommit(next);
    else setDraft(value);
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={beginEdit}
        title={value || placeholder}
        aria-label={ariaLabel}
        className={cn(
          'app-no-drag max-w-full truncate rounded px-1.5 py-0.5 text-left transition-colors duration-quick hover:bg-accent',
          className,
        )}
      >
        {value || <span className="text-muted-foreground">{placeholder}</span>}
      </button>
    );
  }

  return (
    <span className="app-no-drag flex items-center gap-1">
      <input
        ref={inputRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') {
            setDraft(value);
            setEditing(false);
          }
        }}
        aria-label={ariaLabel}
        className={cn(
          'min-w-0 rounded border border-border bg-background px-1.5 py-0.5 outline-none focus:ring-2 focus:ring-ring',
          inputClassName,
        )}
      />
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={commit}
        aria-label="Save"
        className="rounded p-0.5 text-muted-foreground hover:text-foreground"
      >
        <Check className="size-3.5" />
      </button>
    </span>
  );
}

/**
 * The app's own title bar.
 *
 * With the OS chrome hidden this row is both the header and the window drag
 * handle, so it declares `app-drag` and every control inside opts back out.
 * The right side stops short of the caption buttons, which Electron overlays
 * at the window's trailing edge.
 */
export function Header({
  sessionTitle,
  cwd,
  sidebarCollapsed,
  terminalOpen,
  onToggleSidebar,
  onRenameSession,
  onChangeCwd,
  onToggleTerminal,
}: HeaderProps) {
  return (
    <header
      data-tails-part="header"
      className="app-drag flex h-11 shrink-0 items-center gap-2 border-b border-border px-3"
    >
      {sidebarCollapsed ? (
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label="Show sidebar"
          title="Show sidebar"
          className="app-no-drag rounded-md p-1.5 text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
        >
          <PanelLeftOpen className="size-4" />
        </button>
      ) : null}

      <EditableLabel
        value={sessionTitle}
        onCommit={onRenameSession}
        placeholder="Untitled chat"
        ariaLabel="Conversation name"
        className="min-w-0 flex-1 text-sm font-medium"
        inputClassName="w-64 text-sm font-medium"
      />

      <div className="app-no-drag flex shrink-0 items-center gap-1">
        <FolderOpen className="size-3.5 text-muted-foreground" aria-hidden="true" />
        <EditableLabel
          value={cwd}
          onCommit={onChangeCwd}
          placeholder="Choose a folder"
          ariaLabel="Working folder"
          className="max-w-[22rem] font-mono text-xs text-muted-foreground"
          inputClassName="w-[22rem] font-mono text-xs"
        />

        <button
          type="button"
          onClick={onToggleTerminal}
          aria-label={terminalOpen ? 'Hide terminal' : 'Show terminal'}
          title={terminalOpen ? 'Hide terminal' : 'Show terminal'}
          className={cn(
            'rounded-md p-1.5 transition-colors duration-quick',
            terminalOpen
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          {terminalOpen ? <X className="size-4" /> : <SquareTerminal className="size-4" />}
        </button>
      </div>

      {/* Reserves room for the OS caption buttons that Electron overlays here.
          Without it, the folder field slides under the close button. */}
      <div className="w-[140px] shrink-0" aria-hidden="true" />
    </header>
  );
}
