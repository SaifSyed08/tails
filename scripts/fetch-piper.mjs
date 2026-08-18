/**
 * Vendors the Piper CLI so the installer can ship it.
 *
 * The same shape as `fetch-whisper.mjs` and for the same reasons — a
 * digest-pinned release rather than binaries in git, the engine bundled and
 * the models downloaded on request — so only what differs is written out here.
 *
 * ## What differs: this one carries a GPL dependency
 *
 * Piper's own code is MIT. It phonemises with **espeak-ng, which is GPL-3.0**,
 * and the Windows release ships `espeak-ng.dll` alongside `piper.exe`.
 *
 * That is fine, and the reason it is fine is worth stating precisely, because
 * getting it backwards is what kept this feature shelved for months. GPL
 * copyleft attaches to a *combined work*. `piper.exe` links espeak-ng and is
 * therefore in scope for it; **TAILS does not** — it spawns piper as a separate
 * process and exchanges text over a pipe, which is the relationship an app has
 * with `ffmpeg` or `git`. Nothing here makes an MIT app a derivative of
 * anything.
 *
 * Kokoro's JS distribution fails this test where Piper passes it: `kokoro-js`
 * compiles espeak-ng to WASM and *statically links it into the bundle*, so
 * there is no seam and no second program. The difference is linking, not
 * proximity.
 *
 * What redistribution *does* oblige is section 6: ship the licence, and offer
 * the corresponding source. Both are written next to the binary below. That is
 * not a formality — it is the whole price of using it, and it is cheap.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '2023.11.14-2';

const ARCHIVE = {
  url: `https://github.com/rhasspy/piper/releases/download/${VERSION}/piper_windows_amd64.zip`,
  sha256: 'f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea',
  bytes: 22_477_236,
};

const OUT_DIR = path.join(REPO_ROOT, 'vendor', 'piper', 'win32-x64');
const STAMP = path.join(REPO_ROOT, 'vendor', 'piper', '.win32-x64.stamp');

/**
 * The offer of source, which is a legal obligation and not a comment.
 *
 * GPL-3.0 section 6 requires that anyone receiving the binary can get the
 * corresponding source. Upstream tags are permanent and public, so naming them
 * satisfies it — but it has to actually ship, which is why this is written
 * beside the DLL rather than left in a commit message nobody receives.
 */
const SOURCE_OFFER = `Third-party components bundled with T.A.I.L.S.
=============================================

piper (${VERSION})            MIT        https://github.com/rhasspy/piper
espeak-ng                     GPL-3.0    https://github.com/espeak-ng/espeak-ng
onnxruntime                   MIT        https://github.com/microsoft/onnxruntime

espeak-ng is licensed under the GNU General Public License version 3. It is
distributed here as a separate program (invoked by piper.exe), unmodified, in
binary form.

WRITTEN OFFER OF SOURCE
-----------------------
The complete corresponding source code for espeak-ng, and for any other
GPL-licensed component distributed with this application, is available from the
upstream project above. The exact revision shipped is the one referenced by the
piper release named at the top of this file.

If that source ever becomes unavailable upstream, a copy may be requested from
the distributor of this application, who will provide it at no more than the
cost of physical distribution.

T.A.I.L.S. itself is MIT licensed and is not a derivative work of espeak-ng: it
invokes piper.exe as a separate process and does not link against espeak-ng.
`;

const digest = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

async function fetchVerified(what, { url, sha256, bytes }) {
  process.stdout.write(`fetching ${what} ...`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${what}: HTTP ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  const actual = digest(buffer);

  if (bytes !== undefined && buffer.length !== bytes) {
    throw new Error(`${what}: expected ${bytes} bytes, got ${buffer.length}`);
  }
  if (actual !== sha256) {
    throw new Error(
      `${what}: digest mismatch\n  expected ${sha256}\n  actual   ${actual}\n`
      + 'The upstream asset has changed. Verify the new build before updating the pin.',
    );
  }

  process.stdout.write(` ok (${(buffer.length / 1_048_576).toFixed(1)} MB)\n`);
  return buffer;
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('fetch-piper: Windows-only for now; skipping.');
    return;
  }

  if (fs.existsSync(STAMP) && fs.readFileSync(STAMP, 'utf8').trim() === ARCHIVE.sha256) {
    console.log('fetch-piper: already vendored at the pinned digest.');
    return;
  }

  const archive = await fetchVerified('piper', ARCHIVE);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tails-piper-'));
  const zipPath = path.join(scratch, 'piper.zip');
  fs.writeFileSync(zipPath, archive);

  // PowerShell rather than a zip library: it is already on every Windows
  // machine this script runs on, and the alternative is a dependency whose
  // only job is one call.
  const unzip = spawnSync('powershell', [
    '-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${scratch}' -Force`,
  ], { stdio: 'inherit' });
  if (unzip.status !== 0) throw new Error('failed to extract the piper archive');

  /*
    Everything is kept, unlike whisper's build.

    Piper's release is already minimal — the binary, its ONNX runtime, its
    phonemiser and that phonemiser's data directory. `espeak-ng-data` is not
    optional padding: without it espeak cannot phonemise at all, and the
    failure mode is not an error but *silence*, which is the worst way for this
    to break.
  */
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.cpSync(path.join(scratch, 'piper'), OUT_DIR, { recursive: true });

  fs.writeFileSync(path.join(OUT_DIR, 'THIRD-PARTY-NOTICES.txt'), SOURCE_OFFER, 'utf8');

  fs.mkdirSync(path.dirname(STAMP), { recursive: true });
  fs.writeFileSync(STAMP, `${ARCHIVE.sha256}\n`, 'utf8');
  fs.rmSync(scratch, { recursive: true, force: true });

  const size = fs.readdirSync(OUT_DIR)
    .map((name) => fs.statSync(path.join(OUT_DIR, name)))
    .filter((stat) => stat.isFile())
    .reduce((total, stat) => total + stat.size, 0);

  console.log(`fetch-piper: vendored to ${path.relative(REPO_ROOT, OUT_DIR)} (${(size / 1_048_576).toFixed(1)} MB)`);
}

main().catch((error) => {
  console.error(`fetch-piper: ${error.message}`);
  process.exit(1);
});
