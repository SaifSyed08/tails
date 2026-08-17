import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

/**
 * Finding the Claude Code CLI.
 *
 * The one place that answers "which `claude` is this app driving?". Everything
 * about that question is here — the order, the locations, and the reasoning —
 * because the alternative is the answer being spread across a runtime option, a
 * packaging exclusion and an error string, which is how it becomes unanswerable.
 *
 * ## Why the app has to do this at all
 *
 * `@anthropic-ai/claude-agent-sdk` resolves the CLI out of an *optional
 * platform package* — `@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`,
 * 305 MB — with `createRequire(...).resolve`, and throws if it is missing.
 * There is no `PATH` fallback in the SDK. The installer deliberately does not
 * ship that package: it is 45% of the download, and it is a second copy of a
 * program most users of this app already have installed and signed in. So the
 * app resolves the binary itself and hands the SDK the answer through
 * `pathToClaudeCodeExecutable`, which is the supported hook for exactly this.
 *
 * ## Why this searches `PATH` when `enginePath()` refuses to
 *
 * `whisper.ts` will not look on `PATH` for `whisper-cli`, and that is still
 * right. The two cases look identical and are opposites:
 *
 * - whisper is an **implementation detail**. The user never chose it, never
 *   installed it and cannot tell a good build from a bad one — so adopting a
 *   stray binary would silently change transcription quality for a reason
 *   nobody could ever trace back to this decision.
 * - `claude` is **the user's own program**. They installed it, they signed in
 *   to it, and its settings, MCP servers and CLAUDE.md files are the ones they
 *   expect this app to honour. Finding the `claude` already on their machine is
 *   not a risk being taken, it is the entire point.
 *
 * The rule is the same in both files — never silently substitute something the
 * user did not choose — and it lands on opposite answers because in one case
 * the user chose it and in the other they did not.
 */

/** Where the binary came from. Reported so a support answer needs no guessing. */
export type ClaudeCliSource = 'override' | 'bundled' | 'native' | 'path';

/**
 * Discriminated on `found` so a caller that has checked it cannot then be
 * handed a `string | null` — the guard in `claude-runtime.ts` is the whole
 * reason the SDK never sees a missing path.
 *
 * `searched` is on both arms: "where did it look?" is as worth answering when
 * the answer was the fourth candidate as when there was no answer at all.
 */
export type ClaudeCliStatus =
  | {
    found: true;
    path: string;
    source: ClaudeCliSource;
    searched: string[];
  }
  | {
    found: false;
    path: null;
    source: null;
    searched: string[];
    /** Written for the user, not for a log. */
    reason: string;
    /** Rendered as the notice's action. */
    installUrl: string;
  };

/** The documented install instructions, and the only URL this module hands out. */
const INSTALL_URL = 'https://docs.claude.com/en/docs/claude-code/setup';

/** The environment variable that overrides everything below it. */
export const CLAUDE_PATH_ENV = 'TAILS_CLAUDE_PATH';

const isWindows = process.platform === 'win32';
const EXECUTABLE = isWindows ? 'claude.exe' : 'claude';

const require = createRequire(import.meta.url);

/**
 * The SDK's optional platform packages.
 *
 * Two candidates on Linux because the musl build ships under its own name and
 * only one of the pair is ever installed. Resolution failure is the normal case
 * in a packaged build, so it is not worth distinguishing "wrong libc" from
 * "excluded by the installer" here.
 */
function bundledCandidates(): string[] {
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const names = process.platform === 'linux' ? [`${base}-musl`, base] : [base];
  return names.map((name) => `${name}/${EXECUTABLE}`);
}

/**
 * Where Claude Code's own installer puts things.
 *
 * `~/.local/bin` is the current native install; `~/.claude/local` is where
 * `claude migrate-installer` moved older npm-global installs. Both are checked
 * before `PATH` so that a user with several copies gets the one their installer
 * manages and keeps up to date, rather than whichever shim happens to sort
 * first in an environment variable.
 */
function nativeCandidates(home: string): string[] {
  if (!home) return [];

  return [
    path.join(home, '.local', 'bin', EXECUTABLE),
    path.join(home, '.claude', 'local', EXECUTABLE),
  ];
}

function isExecutableFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Walks `PATH`, and only accepts something Node can actually launch.
 *
 * Deliberately not `PATHEXT`. A `claude.cmd` or `claude.ps1` — what a global
 * npm install leaves behind — is a shim, not a program: Node refuses to
 * `spawn` a `.cmd` without a shell, and the SDK spawns the path it is given
 * directly. Returning one would trade a clear "not found" for an obscure
 * `EINVAL` from inside the SDK. Those shims are reported in `searched` instead,
 * so the user is told what was seen and why it was not used.
 */
export function findOnPath(pathVariable: string): { path: string | null; note: string } {
  const entries = pathVariable.split(path.delimiter).filter(Boolean);
  const shims: string[] = [];

  for (const entry of entries) {
    const candidate = path.join(entry, EXECUTABLE);
    if (isExecutableFile(candidate)) return { path: candidate, note: `PATH → ${candidate}` };

    if (!isWindows) continue;
    for (const shim of ['claude.cmd', 'claude.bat', 'claude.ps1']) {
      const shimPath = path.join(entry, shim);
      if (isExecutableFile(shimPath)) shims.push(shimPath);
    }
  }

  return {
    path: null,
    note: shims.length > 0
      ? `PATH (${entries.length} entries) — found only script shims, which cannot be launched directly: ${shims.join(', ')}`
      : `PATH (${entries.length} entries)`,
  };
}

/**
 * The last successful answer, remembered whole.
 *
 * Only successes are cached, and the cached path is re-checked before it is
 * handed out. A miss stays cheap to repeat — half a dozen `stat` calls — which
 * is what lets a user install Claude Code and have the app notice without
 * restarting it.
 */
let cached: ClaudeCliStatus | null = null;

/**
 * Resolves the CLI, in the documented order.
 *
 * Takes the environment as an argument — including the home directory, read
 * from it rather than from `os.homedir()` — so the answer is a function of
 * exactly two things: this environment and the filesystem. Nothing comes from a
 * global the caller cannot see, which is what makes the order above assertable
 * rather than a paragraph nobody can check.
 *
 * The cache belongs to the real environment and is bypassed for any other, so a
 * caller that supplies its own always gets a fresh answer.
 */
export function resolveClaudeCli(env: NodeJS.ProcessEnv = process.env): ClaudeCliStatus {
  const live = env === process.env;
  if (live && cached?.path && isExecutableFile(cached.path)) return cached;
  if (live) cached = null;

  const searched: string[] = [];
  const found = (candidate: string, source: ClaudeCliSource): ClaudeCliStatus => {
    const status: ClaudeCliStatus = { found: true, path: candidate, source, searched };
    if (live) cached = status;
    return status;
  };

  const override = env[CLAUDE_PATH_ENV];
  if (override) {
    searched.push(`${CLAUDE_PATH_ENV}=${override}`);
    if (isExecutableFile(override)) return found(override, 'override');
  } else {
    searched.push(`${CLAUDE_PATH_ENV} (not set)`);
  }

  // Present in a checkout, absent from the installer. Kept second so that
  // `npm run dev`, `npm run desktop` and `npx electron electron/main.js` go on
  // using the package npm installed, exactly as they did before any of this.
  for (const specifier of bundledCandidates()) {
    try {
      const resolved = require.resolve(specifier);
      searched.push(resolved);
      if (isExecutableFile(resolved)) return found(resolved, 'bundled');
    } catch {
      searched.push(`${specifier} (not installed)`);
    }
  }

  // `os.homedir()` reads exactly these two variables anyway — `USERPROFILE` on
  // Windows, `HOME` elsewhere — so taking them from `env` changes nothing in
  // production and keeps the whole function honest about its inputs.
  const home = env.USERPROFILE || env.HOME || os.homedir();
  for (const candidate of nativeCandidates(home)) {
    searched.push(candidate);
    if (isExecutableFile(candidate)) return found(candidate, 'native');
  }

  const onPath = findOnPath(env.PATH || '');
  searched.push(onPath.note);
  if (onPath.path) return found(onPath.path, 'path');

  return {
    found: false,
    path: null,
    source: null,
    searched,
    reason: 'T.A.I.L.S. runs on the Claude Code CLI, which is a separate install and'
      + ' is not on this machine. Install it, then reopen the app — or, if it is'
      + ` already installed somewhere unusual, set ${CLAUDE_PATH_ENV} to the full path`
      + ` of ${EXECUTABLE} and reopen the app.`,
    installUrl: INSTALL_URL,
  };
}
