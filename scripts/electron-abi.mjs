/**
 * Puts an Electron-ABI `better-sqlite3` into the packaged app.
 *
 * ## The problem this exists for
 *
 * `ensureServer()` runs the server as a separate process because
 * `better-sqlite3` and `node-pty` are native modules and, in development, are
 * built against Node's ABI — loading them inside Electron fails on
 * `NODE_MODULE_VERSION`. In development that process is `node` off the user's
 * `PATH`. A packaged app has no such guarantee, so the shipped build runs the
 * server on Electron's own binary in Node mode (`ELECTRON_RUN_AS_NODE=1`),
 * which is a plain Node 22 runtime with no Chromium attached and costs nothing
 * extra to ship. What it does change is the ABI: `NODE_MODULE_VERSION` is a
 * property of the binary, not of the mode, so that child is ABI 139 (Electron
 * 38) rather than the 127 (Node 22) that `npm install` built for.
 *
 * Measured, not assumed:
 *
 * - `node-pty` is a Node-API addon and ships one prebuild per platform rather
 *   than one per ABI. Its `conpty.node` `dlopen`s cleanly under 139. Nothing to
 *   do.
 * - `better-sqlite3` is not, and fails with exactly the mismatch above.
 *
 * ## Why a hook and not `npmRebuild`
 *
 * electron-builder's default is to rebuild native modules **in place**, in the
 * project's own `node_modules`. That would leave the tree ABI 139 after every
 * package run, so `npm run dev` and `npx electron electron/main.js` — which
 * still spawn plain `node` — would break until someone thought to run
 * `npm rebuild`. Packaging is supposed to be additive. This hook writes only
 * into the packaged output, so the working tree is exactly as it was.
 *
 * It also needs no compiler: WiseLibs publish an Electron-ABI prebuild for
 * every release, and `prebuild-install` (already a `better-sqlite3` dependency)
 * knows how to pick the right one. Running it with `--path` pointed at the
 * staged copy downloads and unpacks in one step.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const PREBUILD_INSTALL = require.resolve('prebuild-install/bin.js');
const SOURCE_PACKAGE = path.dirname(require.resolve('better-sqlite3/package.json'));

/**
 * The `.node` we hand to the packaged app, and the proof that it is the right
 * one. `dlopen` under the very binary that will load it at runtime is a
 * stronger check than a digest: a digest only says we downloaded what we asked
 * for, this says what we downloaded actually loads.
 */
function assertLoadsUnderElectron(electronBinary, addon) {
  const result = spawnSync(electronBinary, [
    '-e',
    `process.dlopen({ exports: {} }, ${JSON.stringify(addon)});`
    + ' process.stdout.write(process.versions.modules);',
  ], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(
      `The packaged better-sqlite3 does not load under Electron: ${(result.stderr || '').trim()}`,
    );
  }

  return result.stdout.trim();
}

/** electron-builder's `Arch` enum, by value — read here rather than imported so
 * this hook stays loadable on its own. */
const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];

export default async function rebuildNativesForElectron(context) {
  if (context.electronPlatformName !== 'win32') return;

  const arch = ARCH_NAMES[context.arch];
  if (arch !== 'x64') {
    throw new Error(`This hook has only been verified for x64; asked for ${arch ?? context.arch}.`);
  }

  const electronVersion = context.packager.info.framework.version
    ?? require('electron/package.json').version;
  const appDir = path.join(context.appOutDir, 'resources', 'app');
  const target = path.join(appDir, 'node_modules', 'better-sqlite3');

  if (!fs.existsSync(target)) {
    throw new Error(`better-sqlite3 was not packaged into ${appDir}; check the \`files\` globs.`);
  }

  // Run from the source package so `prebuild-install` reads *its* name and
  // version — the tool takes the package identity from the working directory
  // and only the output location from `--path`, which is easy to get backwards
  // and produces a confident 404 for a release that never existed.
  const result = spawnSync(process.execPath, [
    PREBUILD_INSTALL,
    '--runtime', 'electron',
    '--target', electronVersion,
    '--platform', 'win32',
    '--arch', arch,
    '--force',
    '--path', target,
  ], { cwd: SOURCE_PACKAGE, encoding: 'utf8' });

  if (result.status !== 0) {
    throw new Error(
      `No better-sqlite3 prebuild for Electron ${electronVersion}: ${(result.stderr || '').trim()}`,
    );
  }

  const addon = path.join(target, 'build', 'Release', 'better_sqlite3.node');
  const abi = assertLoadsUnderElectron(
    path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`),
    addon,
  );

  console.log(`  • better-sqlite3 rebuilt for Electron ${electronVersion} (ABI ${abi})`);
}
