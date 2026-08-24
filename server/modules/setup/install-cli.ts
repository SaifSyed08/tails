import { spawn } from 'node:child_process';

import { appBroadcast } from '@/shared/broadcast.js';
import { createMessage } from '@/shared/utils.js';

/**
 * Installing the thing this app is a front end for.
 *
 * T.A.I.L.S. drives the Claude Code CLI. Without it every conversation ends in
 * the same error, and the error — however well written — is a dead end for
 * somebody who has just installed a desktop app and does not know what a
 * package manager is.
 *
 * ## What is automated, and what cannot be
 *
 * The install itself is one command and there is no reason to make a person
 * type it, so there is a button. Signing in is a browser flow the CLI runs in a
 * terminal, and there is no honest way to do it from here — so that step is
 * handed back, with the terminal this app already has opened at it.
 *
 * The command is shown before it runs and its output is streamed while it does.
 * A button that installs software silently is a button nobody should press.
 */

/** What gets run, and what it is called on screen. */
export const INSTALL_COMMAND = {
  program: 'npm',
  args: ['install', '--global', '@anthropic-ai/claude-code'],
} as const;

export const INSTALL_COMMAND_TEXT = `${INSTALL_COMMAND.program} ${INSTALL_COMMAND.args.join(' ')}`;

/**
 * How long an install may take before it is abandoned.
 *
 * A global npm install over a slow connection is genuinely minutes. The timeout
 * exists so a hung registry cannot leave a spinner running for the rest of the
 * session, not to police a slow download.
 */
const TIMEOUT_MS = 6 * 60_000;

/** Lines kept for the panel. Enough to see what went wrong, not a full log. */
const MAX_LINES = 400;

type Progress = { line: string } | { done: true; ok: boolean; message: string };

function publish(progress: Progress): void {
  appBroadcast.publish(createMessage('setup_progress', 'app', {
    content: JSON.stringify(progress),
  }));
}

let running = false;

export const isInstalling = (): boolean => running;

/**
 * Whether a package manager is here at all.
 *
 * Spawned rather than assumed. This app runs on Node, so Node exists — but the
 * desktop build ships its own runtime, and `npm` being on the user's PATH is a
 * genuinely separate question with a genuinely different answer.
 *
 * `shell: true` on Windows because npm is a `.cmd` shim there and cannot be
 * spawned directly, which is the same trap `claude-cli.ts` documents for the
 * CLI itself.
 */
export async function hasPackageManager(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const probe = spawn(INSTALL_COMMAND.program, ['--version'], {
        shell: process.platform === 'win32',
        stdio: 'ignore',
      });
      const timer = setTimeout(() => { probe.kill(); resolve(false); }, 5_000);
      probe.on('error', () => { clearTimeout(timer); resolve(false); });
      probe.on('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
    } catch {
      resolve(false);
    }
  });
}

/**
 * Runs the install, streaming its output.
 *
 * Resolves with the outcome rather than throwing: a failed install is an
 * ordinary result here — no network, no permission to write globally — and the
 * panel's response to all of them is the same, which is to show the output and
 * offer the command to run by hand.
 */
export async function installCli(): Promise<{ ok: boolean; lines: string[] }> {
  if (running) return { ok: false, lines: ['An install is already running.'] };
  running = true;

  const lines: string[] = [];
  const record = (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      const text = line.trimEnd();
      if (!text) continue;
      lines.push(text);
      // Trimmed from the front, so what is kept is the end — which is where
      // the reason a command failed lives.
      if (lines.length > MAX_LINES) lines.shift();
      publish({ line: text });
    }
  };

  return new Promise((resolve) => {
    const finish = (ok: boolean, message: string) => {
      if (!running) return;
      running = false;
      publish({ done: true, ok, message });
      resolve({ ok, lines });
    };

    let child;
    try {
      child = spawn(INSTALL_COMMAND.program, [...INSTALL_COMMAND.args], {
        shell: process.platform === 'win32',
      });
    } catch (error) {
      record(error instanceof Error ? error.message : String(error));
      finish(false, 'Could not start npm.');
      return;
    }

    const timer = setTimeout(() => {
      child.kill();
      finish(false, 'The install took too long and was stopped.');
    }, TIMEOUT_MS);

    child.stdout?.on('data', (data: Buffer) => record(data.toString()));
    // npm writes progress and warnings to stderr on a *successful* install, so
    // this is output rather than failure. The exit code is the verdict.
    child.stderr?.on('data', (data: Buffer) => record(data.toString()));

    child.on('error', (error) => {
      clearTimeout(timer);
      record(error.message);
      finish(false, 'npm could not be run. Is Node installed?');
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      finish(
        code === 0,
        code === 0 ? 'Claude Code is installed.' : `npm exited with code ${code ?? 'unknown'}.`,
      );
    });
  });
}
