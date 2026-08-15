import zlib from 'node:zlib';

/**
 * Just enough ZIP to read a pet out of a downloaded archive.
 *
 * A whole dependency for two files would be a lot of third-party code on the
 * one path in this app that handles bytes from the public internet, so this
 * reads the central directory directly. It is deliberately a *reader*: it
 * returns buffers and never touches the filesystem, which is what makes
 * zip-slip structurally impossible rather than merely checked for — an archive
 * path here can never become a path there.
 *
 * Everything it refuses, it refuses loudly:
 *
 * - encrypted entries, ZIP64 and compression methods other than stored/deflate,
 *   because a pet archive needs none of them and a surprise is not worth
 *   supporting blind;
 * - entry names that are absolute, drive-lettered, backslashed or contain a
 *   `..` segment, even though the caller cannot use them as paths — a name like
 *   that means the archive was built to escape something, and the right
 *   response is to stop;
 * - anything past the caps, checked against the *declared* sizes before
 *   inflating and again by the decompressor, so a zip bomb is rejected rather
 *   than allocated.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** A ZIP comment may be 64KB, so the end-of-directory record is at most that far back. */
const MAX_EOCD_SCAN = 64 * 1024 + 22;

const STORED = 0;
const DEFLATED = 8;

/** Set in the general-purpose flags when entries are encrypted. */
const ENCRYPTED_FLAG = 0x1;

/** The sentinel both size fields carry when the real values live in a ZIP64 record. */
const ZIP64_SENTINEL = 0xffffffff;

export type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  /** From the central directory, and checked after inflating. */
  crc32: number;
};

export type ZipLimits = {
  /** Refuse archives with more members than this. A pet is two files. */
  maxEntries: number;
  /** Refuse any single member whose declared inflated size exceeds this. */
  maxEntryBytes: number;
  /** Refuse an archive whose members inflate to more than this in total. */
  maxTotalBytes: number;
};

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

/**
 * Whether a member name is one a well-formed archive would contain.
 *
 * The caller never joins these onto a directory, so this is defence in depth —
 * but an archive containing `../../etc/passwd` is hostile, and the useful
 * response to a hostile archive is to reject the whole thing rather than to
 * quietly take the members that happened to look fine.
 */
export function isSafeEntryName(name: string): boolean {
  if (name === '' || name.length > 200) return false;
  if (name.startsWith('/') || name.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(name)) return false;
  if (name.includes('\\')) return false;
  // Control characters in a member name are never legitimate, and terminals
  // and log readers treat several of them as commands.
  for (let index = 0; index < name.length; index += 1) {
    if (name.charCodeAt(index) < 0x20) return false;
  }
  return !name.split('/').includes('..');
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const earliest = Math.max(0, archive.length - MAX_EOCD_SCAN);
  for (let offset = archive.length - 22; offset >= earliest; offset -= 1) {
    if (archive.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new ZipError('That download is not a ZIP archive.');
}

/**
 * Reads the central directory.
 *
 * The central directory rather than a scan of local headers, because local
 * headers may carry zeroed sizes with the real values in a trailing data
 * descriptor — reading those means trusting a length we have not verified yet.
 */
export function listZipEntries(archive: Buffer, limits: ZipLimits): ZipEntry[] {
  if (archive.length < 22) throw new ZipError('That download is too small to be a ZIP archive.');
  if (archive.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw new ZipError('That download does not start with a ZIP header.');
  }

  const eocd = findEndOfCentralDirectory(archive);
  const entryCount = archive.readUInt16LE(eocd + 10);
  const directorySize = archive.readUInt32LE(eocd + 12);
  const directoryOffset = archive.readUInt32LE(eocd + 16);

  if (entryCount > limits.maxEntries) {
    throw new ZipError(`That archive holds ${entryCount} files; the limit is ${limits.maxEntries}.`);
  }
  if (directoryOffset + directorySize > archive.length) {
    throw new ZipError('That archive is truncated.');
  }

  const entries: ZipEntry[] = [];
  let cursor = directoryOffset;
  let totalBytes = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new ZipError('That archive has a damaged directory.');
    }

    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const crc32 = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localHeaderOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    if (flags & ENCRYPTED_FLAG) throw new ZipError('That archive is encrypted.');
    if (compressedSize === ZIP64_SENTINEL || uncompressedSize === ZIP64_SENTINEL) {
      throw new ZipError('ZIP64 archives are not supported.');
    }
    if (!isSafeEntryName(name)) {
      throw new ZipError(`That archive contains an unsafe file name: ${JSON.stringify(name)}`);
    }

    // Directory members carry no data and are simply not interesting here.
    const isDirectory = name.endsWith('/');
    if (!isDirectory) {
      if (method !== STORED && method !== DEFLATED) {
        throw new ZipError(`"${name}" uses an unsupported compression method.`);
      }
      if (uncompressedSize > limits.maxEntryBytes) {
        throw new ZipError(`"${name}" is larger than the ${limits.maxEntryBytes} byte limit.`);
      }
      totalBytes += uncompressedSize;
      if (totalBytes > limits.maxTotalBytes) {
        throw new ZipError('That archive inflates to more than the size limit.');
      }
      entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset, crc32 });
    }

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** Inflates one member, capped again at the decompressor so a lying header cannot allocate. */
export function readZipEntry(archive: Buffer, entry: ZipEntry, maxBytes: number): Buffer {
  const header = entry.localHeaderOffset;
  if (header + 30 > archive.length || archive.readUInt32LE(header) !== LOCAL_SIGNATURE) {
    throw new ZipError(`"${entry.name}" has a damaged header.`);
  }

  const nameLength = archive.readUInt16LE(header + 26);
  const extraLength = archive.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;

  if (end > archive.length) throw new ZipError(`"${entry.name}" runs past the end of the archive.`);

  const raw = archive.subarray(start, end);
  const bytes = entry.method === STORED
    ? Buffer.from(raw)
    : zlib.inflateRawSync(raw, { maxOutputLength: maxBytes });

  if (bytes.byteLength > maxBytes) {
    throw new ZipError(`"${entry.name}" is larger than the ${maxBytes} byte limit.`);
  }

  if (bytes.byteLength !== entry.uncompressedSize) {
    throw new ZipError(`"${entry.name}" is not the size the archive claims.`);
  }

  // The archive's own integrity check, and the cheapest way to notice a
  // download that was truncated, corrupted or rewritten in flight.
  if (zlib.crc32(bytes) !== entry.crc32) {
    throw new ZipError(`"${entry.name}" failed its checksum.`);
  }

  return bytes;
}
