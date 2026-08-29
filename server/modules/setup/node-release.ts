/**
 * Working out which Node to install, and proving it arrived intact.
 *
 * Separated from the download and the installer run because these two
 * functions are the whole of the security argument and the rest is plumbing.
 * `install-node.ts` fetches bytes and spawns `msiexec`, neither of which can be
 * tested without a network and an administrator; this file is pure, so the part
 * that decides *what* runs on the user's machine has tests.
 */

/** One entry of `https://nodejs.org/dist/index.json`. */
export type NodeIndexEntry = {
  version: string;
  /** The codename when this line is LTS, and literal `false` when it is not. */
  lts: string | false;
  files?: string[];
};

export type NodeRelease = {
  /** With the leading `v`, which is how the dist paths are spelled. */
  version: string;
  fileName: string;
  url: string;
  checksumUrl: string;
};

const DIST = 'https://nodejs.org/dist';

/** The only artefact this app knows how to run, matching its only build target. */
const WINDOWS_X64_MSI = 'win-x64-msi';

/**
 * Picks the newest LTS release that actually ships a Windows x64 MSI.
 *
 * LTS rather than current, because this install exists to make `npm` work for
 * somebody who did not want to think about Node at all, and current is the line
 * that breaks native modules.
 *
 * The index is published newest-first, and this trusts that ordering rather
 * than parsing and comparing semver: a hand-rolled version comparator is a
 * well-known way to decide that `v9` is newer than `v10`. What it does not
 * trust is that the newest LTS has the file, hence the `files` check.
 */
export function pickLatestLts(index: readonly NodeIndexEntry[]): NodeRelease | null {
  for (const entry of index) {
    if (typeof entry.lts !== 'string' || !entry.lts) continue;
    if (!/^v\d+\.\d+\.\d+$/.test(entry.version)) continue;
    // `files` is absent on some historical entries. Absent is not "has it".
    if (!entry.files?.includes(WINDOWS_X64_MSI)) continue;

    const fileName = `node-${entry.version}-x64.msi`;
    return {
      version: entry.version,
      fileName,
      url: `${DIST}/${entry.version}/${fileName}`,
      checksumUrl: `${DIST}/${entry.version}/SHASUMS256.txt`,
    };
  }
  return null;
}

/**
 * Finds one file's SHA-256 in a `SHASUMS256.txt`.
 *
 * The format is `<64 hex>  <name>`, two spaces, one per line. Matched on the
 * exact name rather than a suffix: `node-v22.0.0-x64.msi` is a suffix of
 * nothing here today, but "the checksum line that ends with what I wanted" is
 * the kind of match that silently starts finding the wrong row when the
 * publisher adds a file.
 *
 * Returns lowercase hex, because that is what `createHash().digest('hex')`
 * produces and comparing case-sensitively is what makes the comparison mean
 * something.
 */
export function findChecksum(shasums: string, fileName: string): string | null {
  for (const line of shasums.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (!match) continue;
    if (match[2] !== fileName) continue;
    return match[1].toLowerCase();
  }
  return null;
}
