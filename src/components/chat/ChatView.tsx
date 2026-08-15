import { Brain } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { Composer, type PermissionMode } from '@/components/chat/Composer';
import { PermissionBanner } from '@/components/chat/PermissionBanner';
import { PlanCard } from '@/components/chat/PlanCard';
import { QuestionCard } from '@/components/chat/QuestionCard';
import { ThinkingIndicator } from '@/components/chat/ThinkingIndicator';
import { ToolRow } from '@/components/chat/ToolRow';
import { useChatSession } from '@/components/chat/useChatSession';
import { Reveal } from '@/shared/ui/Motion';
import type { ChatRow } from '@/types/chat';

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

function Row({ row }: { row: ChatRow }) {
  switch (row.type) {
    case 'user':
      return (
        <div className="flex justify-end">
          <div
            data-tails-part="bubbleUser"
            className="max-w-[80%] whitespace-pre-wrap px-4 py-2 text-primary-foreground"
          >
            {row.content}
          </div>
        </div>
      );

    case 'assistant':
      return (
        <div data-tails-part="bubbleAssistant" className="max-w-none text-[0.9375rem] leading-relaxed">
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
    rows, busy, pendingPermissions, pendingPrompts, error,
    sendMessage, abort, answerPermission, answerQuestion, answerPlan,
  } = useChatSession(sessionId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);
  // Per-conversation rather than global: "plan first" is usually something you
  // want for one piece of work, not as a standing preference.
  const [mode, setMode] = useState<PermissionMode>('default');

  // Follow the stream only while the user is already at the bottom; yanking
  // them down while they're reading earlier output is the classic chat-UI sin.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !pinnedToBottomRef.current) return;
    container.scrollTop = container.scrollHeight;
  }, [rows]);

  const handleScroll = () => {
    const container = scrollRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    pinnedToBottomRef.current = distanceFromBottom < 80;
  };

  const submit = (content: string) => {
    pinnedToBottomRef.current = true;
    onFirstMessage?.(content);
    sendMessage(content, cwd, mode);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-6"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {rows.length === 0 && !busy ? (
            <Reveal variant="rise" className="pt-24 text-center">
              <p className="font-display text-2xl font-semibold tracking-tight">
                What are we building?
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                T.A.I.L.S. runs Claude Code with your tools, your files, and your machine.
              </p>
            </Reveal>
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

      <div className="border-t border-border px-6 py-4">
        <div className="mx-auto max-w-3xl space-y-3">
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
          sessionId={sessionId}
          busy={busy}
          mode={mode}
          onModeChange={setMode}
          onSend={submit}
          onAbort={abort}
        />
      </div>
    </div>
  );
}
