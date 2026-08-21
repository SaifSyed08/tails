import { AlertTriangle, Cpu, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

/**
 * Running Claude Code on a model on this machine.
 *
 * ## What the switch actually does
 *
 * Claude Code has no setting for "use a different model". What it has is an
 * address for the API it talks to, so this points that address at TAILS itself —
 * at an endpoint that speaks Anthropic's protocol and forwards the substance to
 * whatever local runner the user already has. The agent, the tools, the file
 * editing and the permission prompts are all unchanged; only the thing doing the
 * thinking is different.
 *
 * ## Why the warning is not hedging
 *
 * Claude Code is a tool-calling loop, and tool calling is the first thing a
 * heavily quantised small model loses. A 3B model at four bits will hold a
 * conversation and will *not* reliably emit a well-formed tool call ten times in
 * a row — which shows up as an agent that reads a file, forgets what it was
 * doing, and edits the wrong thing. That is worth saying plainly, up front, once,
 * rather than being discovered as a bug in this app.
 *
 * So the copy says what works well (offline, private, free, fine for short local
 * tasks) and what does not (long agentic runs), and nothing on this screen
 * downloads a model: the weights belong to the runner the user chose.
 */

type Runner = { id: string; label: string; baseUrl: string };
type Probe = Runner & { reachable: boolean; models: string[] };

type RoutingStatus = {
  provider: 'anthropic' | 'local';
  baseUrl: string;
  model: string;
  keySaved: boolean;
  active: boolean;
  runners: Runner[];
  probe?: Probe;
};

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${path} failed (${response.status})`);
  return response.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(payload?.error?.message ?? `${path} failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export function RoutingSettings() {
  const [status, setStatus] = useState<RoutingStatus | null>(null);
  const [probes, setProbes] = useState<Probe[] | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await get<RoutingStatus>('/api/routing/status').catch(() => null);
      if (cancelled || !next) return;
      setStatus(next);
      setUrl(next.baseUrl);
    })();
    return () => { cancelled = true; };
  }, []);

  const save = useCallback(async (patch: Record<string, unknown>, label: string) => {
    setBusy(label);
    setError(null);
    try {
      const next = await post<RoutingStatus>('/api/routing/settings', patch);
      setStatus(next);
      setUrl(next.baseUrl);
      /*
        The probe comes back with the save, and a failure to reach the address is
        reported here rather than left for the next message to discover — where
        it would surface as a CLI error about a model name, several layers from
        the field that caused it.
      */
      if (next.probe && !next.probe.reachable) {
        setError(`Nothing is answering at ${next.probe.baseUrl}. Is the runner running?`);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  }, []);

  const look = useCallback(async () => {
    setBusy('discover');
    setError(null);
    try {
      const found = await get<{ runners: Probe[] }>('/api/routing/discover');
      setProbes(found.runners);
      if (!found.runners.some((runner) => runner.reachable)) {
        setError('No local model server is running. Start Ollama, LM Studio, or llama.cpp first.');
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not look for runners.');
    } finally {
      setBusy(null);
    }
  }, []);

  if (!status) return null;

  const local = status.provider === 'local';
  const reachable = probes?.filter((probe) => probe.reachable) ?? [];

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">Where the thinking happens</h3>
        <p className="text-xs text-muted-foreground">
          Claude Code can run against a model on this machine instead of Anthropic&apos;s. Everything
          else — the tools, the file editing, the permissions — works the same way.
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void save({ provider: 'anthropic' }, 'provider')}
          className={cn(
            'rounded-lg border p-3 text-left transition-colors duration-quick',
            !local ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent',
          )}
        >
          <span className="flex items-center gap-2 text-sm font-medium">
            <Sparkles className="size-4" aria-hidden="true" />
            Anthropic
          </span>
          <span className="mt-1 block text-xs text-muted-foreground">
            Claude Code as it ships, on your existing login. What everything else in this app assumes.
          </span>
        </button>

        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void save({ provider: 'local' }, 'provider')}
          className={cn(
            'rounded-lg border p-3 text-left transition-colors duration-quick',
            local ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent',
          )}
        >
          <span className="flex items-center gap-2 text-sm font-medium">
            <Cpu className="size-4" aria-hidden="true" />
            A model on this machine
          </span>
          <span className="mt-1 block text-xs text-muted-foreground">
            Offline, private and free. Good for short local tasks; weaker at long agentic runs — see
            below.
          </span>
        </button>
      </div>

      {local ? (
        <div className="space-y-3 rounded-lg border border-border p-3">
          {/*
            Said once, plainly, at the top. The failure mode is specific and it
            is not this app's bug, so it is worth naming before the user spends
            an evening deciding the feature is broken.
          */}
          <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden="true" />
            <p className="text-xs text-amber-200/90">
              <strong className="font-medium">Heavily quantised models are weak at tool calling</strong>,
              and Claude Code is almost entirely tool calling. Expect a small 4-bit model to chat
              well and then lose track partway through a multi-step job. Models around 30B, or 8-bit
              quantisations, hold up much better. Nothing here downloads anything — the weights are
              whichever ones your runner already has.
            </p>
          </div>

          <div>
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-medium" htmlFor="runner-url">Runner address</label>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void look()}
                className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs transition-colors duration-quick hover:bg-accent disabled:opacity-40"
              >
                {busy === 'discover'
                  ? <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                  : <RefreshCw className="size-3" aria-hidden="true" />}
                Look for one
              </button>
            </div>
            <div className="mt-1 flex gap-2">
              <input
                id="runner-url"
                value={url}
                spellCheck={false}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="http://127.0.0.1:11434/v1"
                className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-primary"
              />
              <button
                type="button"
                disabled={busy !== null || url.trim() === status.baseUrl}
                onClick={() => void save({ baseUrl: url }, 'url')}
                className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs transition-colors duration-quick hover:bg-accent disabled:opacity-40"
              >
                Use
              </button>
            </div>
          </div>

          {reachable.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-medium">Running now</p>
              {reachable.map((probe) => (
                <div key={probe.id} className="rounded-md border border-border p-2">
                  <p className="text-xs font-medium">
                    {probe.label}
                    <span className="ml-1.5 font-normal text-muted-foreground">{probe.baseUrl}</span>
                  </p>
                  {probe.models.length === 0 ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Reachable, but serving no models yet.
                    </p>
                  ) : (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {probe.models.map((model) => (
                        <button
                          key={model}
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void save({ baseUrl: probe.baseUrl, model }, 'model')}
                          className={cn(
                            'rounded border px-1.5 py-0.5 text-xs transition-colors duration-quick',
                            status.model === model && status.baseUrl === probe.baseUrl
                              ? 'border-primary bg-primary/15 text-primary'
                              : 'border-border hover:bg-accent',
                          )}
                        >
                          {model}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : null}

          <div>
            <label className="block text-xs font-medium" htmlFor="runner-model">Model name</label>
            <p className="text-xs text-muted-foreground">
              Exactly as your runner names it, e.g. <code>qwen3:30b-a3b-q4_K_M</code>.
            </p>
            <input
              id="runner-model"
              value={status.model}
              spellCheck={false}
              onChange={(event) => setStatus({ ...status, model: event.target.value })}
              onBlur={(event) => {
                if (event.target.value.trim() !== '') void save({ model: event.target.value }, 'model');
              }}
              placeholder="No model chosen yet"
              className="mt-1 w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-primary"
            />
          </div>

          {/*
            The half-finished state, named. A provider set to local with no model
            keeps sending turns to Anthropic — which is the right thing to do and
            completely invisible unless it is said.
          */}
          {status.model.trim() === '' ? (
            <p className="text-xs text-amber-500">
              No model chosen yet, so messages are still going to Anthropic.
            </p>
          ) : (
            <p className="text-xs text-primary">
              Routed to {status.model} at {status.baseUrl}.
            </p>
          )}
        </div>
      ) : null}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </section>
  );
}
