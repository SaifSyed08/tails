/**
 * Vendors the whisper.cpp CLI so the installer can ship it.
 *
 * ## Why the binary ships and the model does not
 *
 * The engine is 9.5 MB of executable that does nothing on its own and that the
 * user cannot reasonably be asked to source themselves — `enginePath()` refuses
 * to look on `PATH` precisely so that transcription quality never depends on
 * some unrelated `whisper-cli` the app never installed, which leaves the
 * installer as the only honest way to supply one. The 78 MB model is the
 * opposite case: it is the bulk of the download, it is useless to anyone who
 * never dictates, and `downloadModel()` already fetches it behind an explicit
 * click with the size shown. Bundling it would triple the installer to spare a
 * one-time click.
 *
 * ## Why a fetch script rather than committed binaries
 *
 * 9.5 MB of opaque `.exe` and `.dll` in git is 9.5 MB in every clone forever,
 * and it makes "which build is this?" unanswerable. Pinning the release by
 * SHA-256 instead gives a reproducible artifact that anyone can re-derive from
 * upstream, and a mismatch is a hard failure rather than a silent substitution.
 *
 * ## Why the plain build and not OpenBLAS
 *
 * Measured at ~5% faster for +12 MB — see `docs/VOICE.md`. The plain build is
 * already inside the latency budget, so the 12 MB buys nothing a user notices.
 *
 * Windows-only, like the packaging config it feeds. Adding another platform
 * means another entry in `RELEASES` and another `extraResources` mapping.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const VERSION = 'v1.9.2';

/**
 * The upstream archive, pinned by digest.
 *
 * GitHub release assets are mutable in principle — a maintainer can delete and
 * re-upload one under the same URL — so the digest is the actual identity of
 * what we ship, and the URL is only where to find it.
 */
const ARCHIVE = {
  url: `https://github.com/ggml-org/whisper.cpp/releases/download/${VERSION}/whisper-bin-x64.zip`,
  sha256: '49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a',
  bytes: 8_194_445,
};

/**
 * whisper.cpp is MIT, which requires the licence and copyright notice to travel
 * with the binary. Fetched from the same tag rather than transcribed, so it
 * cannot drift from the code it covers.
 */
const LICENSE = {
  url: `https://raw.githubusercontent.com/ggml-org/whisper.cpp/${VERSION}/LICENSE`,
  sha256: '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d',
};

/**
 * What the archive holds that we actually need.
 *
 * The release ships 37 files — benchmarks, the parakeet models' tooling, a
 * whole HTTP server, SDL2 for the live-microphone demos. We run one command
 * line, so everything else is weight and extra licences (SDL2 is zlib, not
 * MIT) for code the app never reaches.
 *
 * The `ggml-cpu-*` set is not optional padding: ggml picks one at *runtime*
 * from the host's instruction set — this machine loads `cascadelake` — so
 * dropping variants silently demotes some CPUs to a slower kernel or, with none
 * left that match, leaves whisper with no backend at all. 6.6 MB for correct
 * behaviour on every x64 machine is the right trade.
 */
const KEEP = [
  'whisper-cli.exe',
  'whisper.dll',
  'ggml.dll',
  'ggml-base.dll',
  'ggml-cpu-alderlake.dll',
  'ggml-cpu-cannonlake.dll',
  'ggml-cpu-cascadelake.dll',
  'ggml-cpu-haswell.dll',
  'ggml-cpu-icelake.dll',
  'ggml-cpu-sandybridge.dll',
  'ggml-cpu-skylakex.dll',
  'ggml-cpu-sse42.dll',
  'ggml-cpu-x64.dll',
];

const OUT_DIR = path.join(REPO_ROOT, 'vendor', 'whisper', 'win32-x64');
const STAMP = path.join(REPO_ROOT, 'vendor', 'whisper', '.win32-x64.stamp');

const digest = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

async function fetchVerified(what, { url, sha256, bytes }) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${what}: ${url} returned ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  if (bytes !== undefined && buffer.length !== bytes) {
    throw new Error(`${what}: expected ${bytes} bytes, got ${buffer.length}`);
  }

  const actual = digest(buffer);
  if (actual !== sha256) {
    throw new Error(`${what}: SHA-256 is ${actual}, expected ${sha256}`);
  }

  return buffer;
}

/**
 * Unpacks the archive.
 *
 * Shelling out to PowerShell's `ZipFile` rather than `tar` because the `tar` a
 * developer gets here depends on their shell: Windows' own is bsdtar and reads
 * zip, but Git Bash puts GNU tar first on `PATH` and GNU tar cannot. The app
 * carries its own zip reader (`server/modules/pets/zip.ts`), but that one is a
 * server module with pet-sized limits and no filesystem access by design — it
 * is not a build tool, and borrowing it would couple packaging to the pets
 * feature and to a prior `npm run build`.
 *
 * Paths go through the environment rather than into the command string so a
 * quote or a space in a developer's home directory cannot rewrite the command.
 */
function extractZip(zipPath, destination) {
  const result = spawnSync('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem;'
    + ' [System.IO.Compression.ZipFile]::ExtractToDirectory($env:TAILS_ZIP, $env:TAILS_DEST)',
  ], {
    env: { ...process.env, TAILS_ZIP: zipPath, TAILS_DEST: destination },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  if (result.status !== 0) {
    throw new Error(`Could not unpack ${path.basename(zipPath)} (PowerShell exited ${result.status})`);
  }
}

/** True when the vendored copy is already the pinned release, byte for byte. */
function alreadyVendored() {
  try {
    if (fs.readFileSync(STAMP, 'utf8').trim() !== ARCHIVE.sha256) return false;
  } catch {
    return false;
  }

  return [...KEEP, 'LICENSE.txt'].every((name) => fs.existsSync(path.join(OUT_DIR, name)));
}

/**
 * Also electron-builder's `beforePack` hook.
 *
 * Wired into the config rather than left to the `dist:win` script alone,
 * because the failure it prevents is the quiet one: a bare `electron-builder`
 * run with an empty `vendor/` produces an installer that looks fine and has no
 * speech engine in it. Cached, so the normal case costs a digest comparison.
 */
export default async function vendorWhisper() {
  if (alreadyVendored()) {
    console.log(`whisper.cpp ${VERSION} already vendored in vendor/whisper/win32-x64`);
    return;
  }

  console.log(`Fetching whisper.cpp ${VERSION} (${(ARCHIVE.bytes / 1_048_576).toFixed(1)} MB)…`);
  const [archive, license] = await Promise.all([
    fetchVerified('whisper-bin-x64.zip', ARCHIVE),
    fetchVerified('whisper.cpp LICENSE', LICENSE),
  ]);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tails-whisper-'));
  try {
    const zipPath = path.join(scratch, 'whisper-bin-x64.zip');
    fs.writeFileSync(zipPath, archive);
    extractZip(zipPath, path.join(scratch, 'unpacked'));

    // Rebuilt rather than merged into, so a KEEP entry removed here actually
    // stops shipping instead of lingering from an earlier run.
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    fs.mkdirSync(OUT_DIR, { recursive: true });

    let bytes = 0;
    for (const name of KEEP) {
      const source = path.join(scratch, 'unpacked', 'Release', name);
      if (!fs.existsSync(source)) throw new Error(`${name} is missing from the archive`);
      fs.copyFileSync(source, path.join(OUT_DIR, name));
      bytes += fs.statSync(source).size;
    }

    fs.writeFileSync(path.join(OUT_DIR, 'LICENSE.txt'), license);
    fs.mkdirSync(path.dirname(STAMP), { recursive: true });
    fs.writeFileSync(STAMP, `${ARCHIVE.sha256}\n`);

    console.log(
      `Vendored ${KEEP.length} files (${(bytes / 1_048_576).toFixed(1)} MB) to vendor/whisper/win32-x64`,
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// Only when run as a script. Imported as a hook, electron-builder calls the
// export itself and a second run here would fetch everything twice.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await vendorWhisper();
}
