import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { appBroadcast } from '@/shared/broadcast.js';
import { createMessage } from '@/shared/utils.js';

import { findChecksum, pickLatestLts, type NodeIndexEntry } from './node-release.js';

/**
 * Installing the runtime that installs the CLI.
 *
 * `install-cli.ts` runs `npm install --global @anthropic-ai/claude-code`, which
 * is a fine plan right up until the machine has no npm. That was the one step
 * of first-run setup with no answer but a link and an apology, and it is the
 * step most likely to be where a non-developer stops.
 *
 * ## Why this is allowed to download and run an installer
 *
 * It is the same act the link asked the user to perform, minus the part where
 * they have to identify the right file on a download page. What makes it
 * defensible rather than merely convenient is that all three of these hold:
 *
 * - **The exact URL is shown before anything is fetched**, the same way
 *   `INSTALL_COMMAND_TEXT` is shown before npm runs.
 * - **The download is verified against the publisher's own `SHASUMS256.txt`**,
 *   fetched over TLS from the same host, and a mismatch deletes the file and
 *   refuses. A downloader that runs whatever arrived is a downloader that runs
 *   whatever a captive portal handed it.
 * - **`msiexec` is run with `/passive`, not `/quiet`.** Windows shows its own
 *   progress and its own elevation prompt. The user is asked by the operating
 *   system, in the dialog they already trust, before anything is written.
 *
 * ## Windows only, and it says so
 *
 * Refused rather than approximated elsewhere. The app has one packaging target,
 * and a plausible-looking macOS path that has never been run is worse than a
 * sentence saying to install Node yourself.
 */

const INDEX_URL = 'https://nodejs.org/dist/index.json';

/** Long enough for an 30 MB MSI on a poor connection, short enough to end. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** The MSI's own UI owns most of this; the timeout is for a wedged process. */
const INSTALL_TIMEOUT_MS = 15 * 60_000;

type Progress = { line: string } | { done: true; ok: boolean; message: string };

function publish(progress: Progress): void {
  appBroadcast.publish(createMessage('setup_progress', 'app', {
    content: JSON.stringify(progress),
  }));
}

let running = false;

export const isInstallingNode = (): boolean => running;

/** Whether this machine can be helped, as opposed to merely told. */
export const canInstallNode = (): boolean => process.platform === 'win32' && process.arch === 'x64';

/**
 * Whether Node is on the PATH.
 *
 * A separate question from "is this process running on Node", which is always
 * yes: the packaged app carries its own runtime inside Electron and never puts
 * it on the PATH, so `npm` can be missing on a machine that is currently
 * running this code. Same reasoning as `hasPackageManager`.
 */
export async function hasNode(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const probe = spawn('node', ['--version'], {
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
 * Which release the button would install, so the panel can name it first.
 *
 * Returns null on any failure, because every caller's response to "we could not
 * reach nodejs.org" is to show the link instead, and distinguishing a DNS
 * failure from a 503 would not change that.
 */
export async function resolveNodeDownload(): Promise<{ version: string; url: string } | null> {
  if (!canInstallNode()) return null;
  try {
    const response = await fetch(INDEX_URL, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return null;
    const release = pickLatestLts(await response.json() as NodeIndexEntry[]);
    return release ? { version: release.version, url: release.url } : null;
  } catch {
    return null;
  }
}

/**
 * Downloads the MSI, checks it, and hands it to `msiexec`.
 *
 * Resolves with the outcome rather than throwing, matching `installCli`: every
 * failure here ends in the same place, which is the panel showing what happened
 * and the link to do it by hand.
 */
export async function installNode(): Promise<{ ok: boolean }> {
  if (running) return { ok: false };
  running = true;

  const say = (line: string) => publish({ line });
  const finish = (ok: boolean, message: string) => {
    running = false;
    publish({ done: true, ok, message });
    return { ok };
  };

  if (!canInstallNode()) {
    return finish(false, 'Automatic install is Windows x64 only. Install Node from nodejs.org.');
  }

  let workspace: string | null = null;
  try {
    say('Asking nodejs.org which release is current…');
    const index = await fetch(INDEX_URL, { signal: AbortSignal.timeout(15_000) });
    if (!index.ok) return finish(false, `nodejs.org answered ${index.status}.`);

    const release = pickLatestLts(await index.json() as NodeIndexEntry[]);
    if (!release) return finish(false, 'No current LTS release offers a Windows x64 installer.');
    say(`Latest LTS is ${release.version}.`);

    say('Fetching the published checksum…');
    const sums = await fetch(release.checksumUrl, { signal: AbortSignal.timeout(15_000) });
    if (!sums.ok) return finish(false, `Could not read the checksum list (${sums.status}).`);
    const expected = findChecksum(await sums.text(), release.fileName);
    if (!expected) return finish(false, `No checksum published for ${release.fileName}.`);

    say(`Downloading ${release.url}`);
    const download = await fetch(release.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!download.ok) return finish(false, `The download failed (${download.status}).`);

    workspace = await mkdtemp(path.join(tmpdir(), 'tails-node-'));
    const file = path.join(workspace, release.fileName);
    await writeFile(file, Buffer.from(await download.arrayBuffer()));

    // Re-read from disk rather than hashing the buffer we just wrote. What runs
    // is the file, so the file is what has to match.
    const actual = createHash('sha256').update(await readFile(file)).digest('hex');
    if (actual !== expected) {
      say(`Expected ${expected}`);
      say(`Received ${actual}`);
      return finish(false, 'The download did not match its published checksum, so it was deleted.');
    }
    say('Checksum matches.');

    say('Handing it to the Windows installer. Approve the prompt it shows.');
    const code = await runMsi(file);
    if (code !== 0) {
      // 1602 is the user cancelling at the elevation prompt, which is a choice
      // rather than a fault and should not be reported as one.
      if (code === 1602) return finish(false, 'The install was cancelled.');
      return finish(false, `The installer exited with code ${code}.`);
    }

    // PATH is set by the MSI for *new* processes. This one inherited its
    // environment at launch and will not see node until it restarts, so the
    // message says so instead of letting the next probe look like a failure.
    return finish(true, `Node ${release.version} is installed. Restart T.A.I.L.S. so it picks it up.`);
  } catch (error) {
    say(error instanceof Error ? error.message : String(error));
    return finish(false, 'The install could not be completed.');
  } finally {
    running = false;
    if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

/** `/passive` so Windows draws the progress and asks for elevation itself. */
function runMsi(file: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('msiexec', ['/i', file, '/passive', '/norestart'], { windowsHide: false });
    const timer = setTimeout(() => { child.kill(); resolve(-1); }, INSTALL_TIMEOUT_MS);
    child.on('error', () => { clearTimeout(timer); resolve(-1); });
    child.on('exit', (code) => { clearTimeout(timer); resolve(code ?? -1); });
  });
}
