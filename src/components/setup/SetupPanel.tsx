import { Check, CircleAlert, Download, ExternalLink, Loader2, Terminal, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useWebSocket } from '@/contexts/WebSocketContext';
import { Reveal } from '@/shared/ui/Motion';

/**
 * What to do when the thing this app drives is not installed.
 *
 * T.A.I.L.S. is a front end for the Claude Code CLI. Without it every
 * conversation ends in the same error — and however well that error is written,
 * it is a dead end for somebody who has just installed a desktop app and has no
 * reason to know what a package manager is. This is the difference between an
 * app that does not work and an app that tells you how to make it work.
 *
 * ## Three steps, and only two of them are ours
 *
 * The install is one command, so there is a button. Signing in is a browser
 * flow the CLI runs in a terminal, and there is no honest way to drive it from
 * here — so that step is handed back, with the terminal this app already has
 * opened at it.
 *
 * The command is shown before it runs and its output while it does. A button
 * that installs software silently is a button nobody should press.
 *
 * ## Why it can be dismissed
 *
 * Somebody may be here to look at pets, change the theme, or read an old
 * conversation, none of which need the CLI. A modal that cannot be closed until
 * a download finishes is a worse first impression than a broken chat.
 */

type Status = {
  cli: { found: boolean; reason: string | null; installUrl: string | null };
  packageManager: boolean;
  node: {
    found: boolean;
    canInstall: boolean;
    /** Named before anything is fetched, so the URL is shown beside the button. */
    download: { version: string; url: string } | null;
  };
  command: string;
  installing: boolean;
};

type StepProps = {
  index: number;
  title: string;
  done: boolean;
  children: React.ReactNode;
};

function Step({ index, title, done, children }: StepProps) {
  return (
    <li className="flex gap-3">
      <span
        className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-medium ${
          done ? 'bg-positive text-background' : 'bg-muted text-muted-foreground'
        }`}
        aria-hidden="true"
      >
        {done ? <Check className="size-3" /> : index}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <h4 className="text-sm font-medium">{title}</h4>
        {children}
      </div>
    </li>
  );
}

export function SetupPanel({ onOpenTerminal }: { onOpenTerminal: () => void }) {
  const { subscribe } = useWebSocket();
  const [status, setStatus] = useState<Status | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);
  /*
    Which of the two installs is running.

    They stream to the same broadcast and land in the same log, so sharing that
    state is what keeps them from racing each other into it. This exists only so
    the right button spins, and it is declared up here with the rest because the
    completion handler below closes over it.
  */
  const [busyStep, setBusyStep] = useState<'node' | 'cli' | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);

  const load = useCallback((): void => {
    void fetch('/api/setup')
      .then((response) => response.json() as Promise<Status>)
      .then(setStatus)
      // If this cannot be reached the app has larger problems, and all of them
      // will be reported by something with more to say than a setup panel.
      .catch(() => {});
  }, []);

  useEffect(load, [load]);

  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => subscribe((message) => {
    if (message.kind !== 'setup_progress' || !message.content) return;
    try {
      const progress = JSON.parse(message.content) as
        { line?: string } & { done?: true; ok?: boolean; message?: string };

      if (progress.done) {
        setInstalling(false);
        setBusyStep(null);
        setOutcome({ ok: progress.ok === true, message: progress.message ?? '' });
        // Re-read rather than assume: the verdict is npm's exit code, and
        // whether the binary is now findable is a different question with its
        // own answer.
        load();
        return;
      }
      if (progress.line) setLines((current) => [...current.slice(-300), progress.line as string]);
    } catch {
      // A frame we cannot read changes nothing.
    }
  }), [subscribe, load]);

  // Pinned to the end, so a long install shows what it is doing now rather than
  // what it was doing a minute ago.
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [lines]);

  const run = async (step: 'node' | 'cli'): Promise<void> => {
    setInstalling(true);
    setBusyStep(step);
    setLines([]);
    setOutcome(null);
    try {
      await fetch(step === 'node' ? '/api/setup/install-node' : '/api/setup/install-cli', {
        method: 'POST',
      });
    } catch {
      setInstalling(false);
      setBusyStep(null);
      setOutcome({ ok: false, message: 'The install could not be started.' });
    }
  };

  // Nothing to say while it is working, which is almost always.
  if (!status || status.cli.found || dismissed) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4">
      <Reveal
        variant="scale"
        as="section"
        label="Set up Claude Code"
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-border p-4">
          <div>
            <h3 className="text-sm font-semibold">One thing left to install</h3>
            <p className="mt-0.5 text-sm text-muted-foreground">
              T.A.I.L.S. runs on Claude Code. It is not on this machine yet, so conversations will
              not work until it is.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label="Close"
            className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>

        <ol className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          <Step index={1} title="Node and npm" done={status.packageManager}>
            {status.packageManager ? (
              <p className="text-xs text-muted-foreground">
                Found. Nothing to do here.
              </p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  Not found, and the next step needs it.
                </p>

                {/* The offer, when it can be made. `download` is null whenever
                    nodejs.org could not be reached or this is not a machine
                    the installer was built for, and both of those end at the
                    same link rather than at a button that would fail. */}
                {status.node.canInstall && status.node.download ? (
                  <>
                    <p className="text-xs text-muted-foreground">
                      This downloads the official installer, checks it against the checksum
                      nodejs.org publishes, and hands it to Windows. You will be asked to approve
                      it.
                    </p>
                    {/* The URL before the click, for the same reason the npm
                        command is shown before it runs. */}
                    <pre
                      data-tails-part="code"
                      className="overflow-x-auto p-2 font-mono text-[11px]"
                    >
                      {status.node.download.url}
                    </pre>
                    <button
                      type="button"
                      disabled={installing}
                      onClick={() => void run('node')}
                      className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-transform duration-instant ease-emphasis active:scale-95 disabled:opacity-50"
                    >
                      {busyStep === 'node'
                        ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                        : <Download className="size-3.5" aria-hidden="true" />}
                      {busyStep === 'node'
                        ? 'Installing Node…'
                        : `Install Node ${status.node.download.version} for me`}
                    </button>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Install Node yourself, then reopen T.A.I.L.S.
                  </p>
                )}

                <a
                  href="https://nodejs.org"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs transition-colors duration-quick hover:bg-accent"
                >
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                  nodejs.org
                </a>
              </>
            )}
          </Step>

          <Step index={2} title="Install Claude Code" done={outcome?.ok === true}>
            <p className="text-xs text-muted-foreground">
              This runs one command for you:
            </p>
            {/* Shown before it runs. A button that installs software without
                saying what it will do is a button nobody should press. */}
            <pre
              data-tails-part="code"
              className="overflow-x-auto p-2 font-mono text-xs"
            >
              {status.command}
            </pre>
            <button
              type="button"
              disabled={installing || !status.packageManager}
              onClick={() => void run('cli')}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-transform duration-instant ease-emphasis active:scale-95 disabled:opacity-50"
            >
              {busyStep === 'cli'
                ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                : <Download className="size-3.5" aria-hidden="true" />}
              {busyStep === 'cli' ? 'Installing…' : 'Install it for me'}
            </button>

            {lines.length > 0 ? (
              <pre
                ref={logRef}
                data-tails-part="code"
                className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words p-2 font-mono text-[11px] leading-relaxed"
              >
                {lines.join('\n')}
              </pre>
            ) : null}

            {outcome && !outcome.ok ? (
              <p className="flex items-start gap-1.5 text-xs text-destructive">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>
                  {outcome.message} You can run the command above in a terminal yourself — the
                  output there will say more.
                </span>
              </p>
            ) : null}
          </Step>

          <Step index={3} title="Sign in" done={false}>
            <p className="text-xs text-muted-foreground">
              {/* The honest half. This is a browser flow the CLI runs, and
                  pretending to drive it from here would mean a button that
                  appears to do nothing. */}
              This part has to be you: Claude Code signs in through your browser. Open a terminal,
              run <code className="font-mono">claude</code>, and follow it. Then come back and send
              a message.
            </p>
            <button
              type="button"
              onClick={onOpenTerminal}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs transition-colors duration-quick hover:bg-accent"
            >
              <Terminal className="size-3.5" aria-hidden="true" />
              Open a terminal here
            </button>
          </Step>
        </ol>

        <footer className="flex items-center justify-between gap-2 border-t border-border p-3">
          <span className="text-xs text-muted-foreground">
            {status.cli.reason ?? ''}
          </span>
          <button
            type="button"
            onClick={load}
            className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-xs transition-colors duration-quick hover:bg-accent"
          >
            Check again
          </button>
        </footer>
      </Reveal>
    </div>,
    document.body,
  );
}
