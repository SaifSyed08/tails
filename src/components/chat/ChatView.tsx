import { Brain, Paperclip } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { Composer, type ComposerHandle } from '@/components/chat/Composer';
import { EmptyState } from '@/components/chat/EmptyState';
import { PetPicker } from '@/components/chat/PetPicker';
import { PermissionBanner } from '@/components/chat/PermissionBanner';
import { PlanCard } from '@/components/chat/PlanCard';
import { QuestionCard } from '@/components/chat/QuestionCard';
import { ThinkingIndicator } from '@/components/chat/ThinkingIndicator';
import { ToolRow } from '@/components/chat/ToolRow';
import { useChatSession } from '@/components/chat/useChatSession';
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

function Row({ row }: { row: ChatRow }) {
  switch (row.type) {
    case 'user':
      return (
        <div className="flex justify-end">
          <div
            data-tails-part="bubbleUser"
            // Same reasoning as the assistant's turn: this element is what a
            // theme borders, so it carries room for a border it cannot know
            // about. No negative margin here — the bubble is meant to read as
            // a bubble, so it may sit inside the column.
            className="max-w-[80%] whitespace-pre-wrap px-5 py-3 text-primary-foreground"
          >
            {row.attachments?.length ? <SentAttachments attachments={row.attachments} /> : null}
            {row.content}
          </div>
        </div>
      );

    case 'assistant':
      return (
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
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{row.content}</ReactMarkdown>
          </div>
          {row.streaming ? (
            <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-foreground align-middle" />
          ) : null}
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

export function ChatView({ sessionId, cwd, onFirstMessage }: ChatViewProps) {
  const {
    rows, busy, pendingPermissions, pendingPrompts, error, mode, changeMode,
    suggestion, clearSuggestion,
    sendMessage, abort, answerPermission, answerQuestion, answerPlan,
  } = useChatSession(sessionId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);
  const composerRef = useRef<ComposerHandle>(null);
  const [petPickerOpen, setPetPickerOpen] = useState(false);
  const [pet, setPet] = useState<{ id: string; name: string } | null>(null);

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
      let resolved: { id: string; name: string } | null = null;
      try {
        if (sessionId) {
          const session = await api.getSession(sessionId);
          if (session.petId) {
            const library = await api.listPets();
            const match = library.pets.find((entry) => entry.definition.id === session.petId);
            if (match) resolved = { id: match.definition.id, name: match.definition.name };
          }
        }
      } catch {
        // A chat with no row yet, or an unreadable pet library. Either way the
        // menu simply shows no assignment.
      }
      if (!cancelled) setPet(resolved);
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const handleScroll = () => {
    const container = scrollRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    pinnedToBottomRef.current = distanceFromBottom < 80;
  };

  const submit = (content: string, attachments: AttachmentPayload[]) => {
    pinnedToBottomRef.current = true;
    onFirstMessage?.(content);
    sendMessage(content, { cwd, attachments });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto px-10 py-6"
      >
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          {rows.length === 0 && !busy ? (
            <EmptyState cwd={cwd} onPick={(prompt) => composerRef.current?.fill(prompt)} />
          ) : null}

          {rows.map((row) => (
            <Row key={row.id} row={row} />
          ))}

          {/* Only while nothing is streaming — once tokens are arriving the
              text itself is the progress indicator. */}
          {busy && rows[rows.length - 1]?.type !== 'assistant' ? <ThinkingIndicator /> : null}

          {error ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}
        </div>
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
