/**
 * Streaming migration bundle: a length-prefixed sequence of file records.
 *
 * Layout per record: `uint32BE header length`, UTF-8 JSON header
 * `{ path, size }`, then exactly `size` bytes. The terminator is a header with
 * an empty path. Only `space.db` and `assets/**` are accepted, so a bundle can
 * never write outside the Space data directory.
 *
 * The format is deliberately simple (no tar/zip dependency) so the browser-
 * free Host and the Docker server can both stream it with bounded memory.
 *
 * @module @alter-dsh/space/control/migration/bundle
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

/** One file packed into a bundle. */
export interface BundleFileEntry {
  /** Path relative to the Space data directory. */
  path: string;
  /** Absolute source file path. */
  source: string;
}

/** Result of {@link writeBundleFile}. */
export interface WrittenBundle {
  size: number;
  sha256: string;
  fileCount: number;
  /** Sum of the file payload bytes (excludes headers). */
  payloadBytes: number;
}

/** Progress sink for pack/unpack. */
export interface BundleProgress {
  (bytes: number): void;
}

const HEADER_LENGTH_BYTES = 4;
const MAX_HEADER_BYTES = 64 * 1024;
const TEMP_SUFFIX = '.tmp-bundle';

/** Validate one normalized relative path. */
export function assertBundlePath(path: string): string {
  const normalized = path.split(sep).join('/');
  if (
    normalized === '' ||
    normalized.startsWith('/') ||
    normalized.includes('..') ||
    normalized.includes('\\')
  )
    throw new Error(`迁移包包含非法路径：${path}`);
  if (normalized === 'space.db') return normalized;
  if (normalized.startsWith('assets/')) return normalized;
  throw new Error(`迁移包包含不允许的路径：${path}`);
}

function headerBuffer(path: string, size: number): Buffer {
  return Buffer.from(JSON.stringify({ path, size }), 'utf8');
}

/**
 * Pack files into one bundle at `destination`.
 * @param destination - absolute bundle file path.
 * @param entries - files to pack in order (later records may overwrite).
 * @param progress - optional byte progress callback (payload bytes).
 */
export async function writeBundleFile(
  destination: string,
  entries: readonly BundleFileEntry[],
  progress?: BundleProgress,
): Promise<WrittenBundle> {
  const hash = createHash('sha256');
  let size = 0;
  let payloadBytes = 0;
  const output = createWriteStream(destination);
  // A write-stream 'error' (ENOSPC, EACCES, …) without a listener crashes the
  // whole process; keep one persistent listener so the failure is reported to
  // the awaiting caller instead. Writes are serialized through `writeChunk`,
  // so memory stays bounded to one chunk.
  let failure: Error | undefined;
  output.on('error', (error: Error) => {
    failure ??= error;
  });
  const writeChunk = async (buffer: Buffer): Promise<void> => {
    if (failure !== undefined) throw failure;
    hash.update(buffer);
    size += buffer.byteLength;
    await new Promise<void>((resolveWrite, rejectWrite) => {
      output.write(buffer, (error) => {
        if (error !== null && error !== undefined) rejectWrite(error);
        else if (failure !== undefined) rejectWrite(failure);
        else resolveWrite();
      });
    });
  };
  try {
    for (const entry of entries) {
      const file = await open(entry.source, 'r');
      try {
        const stat = await file.stat();
        const path = assertBundlePath(entry.path);
        const header = headerBuffer(path, stat.size);
        const length = Buffer.alloc(HEADER_LENGTH_BYTES);
        length.writeUInt32BE(header.byteLength, 0);
        await writeChunk(length);
        await writeChunk(header);
        let offset = 0;
        while (offset < stat.size) {
          const lengthToRead = Math.min(1024 * 1024, stat.size - offset);
          const buffer = Buffer.alloc(lengthToRead);
          const { bytesRead } = await file.read(buffer, 0, lengthToRead, offset);
          if (bytesRead === 0) throw new Error(`读取文件失败：${entry.source}`);
          await writeChunk(buffer.subarray(0, bytesRead));
          offset += bytesRead;
          payloadBytes += bytesRead;
          progress?.(payloadBytes);
        }
      } finally {
        await file.close();
      }
    }
    const terminator = headerBuffer('', 0);
    const length = Buffer.alloc(HEADER_LENGTH_BYTES);
    length.writeUInt32BE(terminator.byteLength, 0);
    await writeChunk(length);
    await writeChunk(terminator);
    output.end();
    try {
      await finished(output);
    } catch (error) {
      throw failure ?? error;
    }
    if (failure !== undefined) throw failure;
  } catch (error) {
    // Stop the stream from emitting after the caller gave up on it.
    output.destroy();
    throw error;
  }
  return {
    size,
    sha256: hash.digest('hex'),
    fileCount: entries.length,
    payloadBytes,
  };
}

/** Buffered byte reader over a Node readable stream. */
class StreamReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private buffered: Buffer = Buffer.alloc(0);

  constructor(stream: Readable) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

  private async fill(): Promise<void> {
    const { value, done } = await this.iterator.next();
    if (done === true) throw new Error('迁移包提前结束');
    this.buffered = Buffer.concat([this.buffered, value as Buffer]);
  }

  async take(bytes: number): Promise<Buffer> {
    while (this.buffered.length < bytes) await this.fill();
    const out = this.buffered.subarray(0, bytes);
    this.buffered = this.buffered.subarray(bytes);
    return out;
  }

  async pipe(bytes: number, sink: (chunk: Buffer) => Promise<void>): Promise<void> {
    let remaining = bytes;
    while (remaining > 0) {
      if (this.buffered.length === 0) await this.fill();
      const chunk = this.buffered.subarray(
        0,
        Math.min(remaining, this.buffered.length),
      );
      this.buffered = this.buffered.subarray(chunk.length);
      remaining -= chunk.length;
      await sink(chunk);
    }
  }
}

/**
 * Unpack one bundle under `dataDirectory`, atomically replacing each file.
 * @param bundleFile - bundle path.
 * @param dataDirectory - destination data directory root.
 * @param progress - optional payload progress.
 * @returns number of unpacked files and payload bytes.
 */
export async function unpackBundleTo(
  bundleFile: string,
  dataDirectory: string,
  progress?: BundleProgress,
): Promise<{ fileCount: number; payloadBytes: number }> {
  const root = resolve(dataDirectory);
  const reader = new StreamReader(createReadStream(bundleFile));
  let fileCount = 0;
  let payloadBytes = 0;
  for (;;) {
    const lengthBuffer = await reader.take(HEADER_LENGTH_BYTES);
    const headerLength = lengthBuffer.readUInt32BE(0);
    if (headerLength === 0 || headerLength > MAX_HEADER_BYTES)
      throw new Error('迁移包头无效');
    const header = JSON.parse(
      (await reader.take(headerLength)).toString('utf8'),
    ) as { path?: unknown; size?: unknown };
    if (typeof header.path !== 'string' || typeof header.size !== 'number')
      throw new Error('迁移包头字段无效');
    if (header.path === '') {
      if (header.size !== 0) throw new Error('迁移包结束记录无效');
      break;
    }
    const relativePath = assertBundlePath(header.path);
    const destination = resolve(join(root, relativePath));
    const resolvedRoot = `${root}${sep}`;
    if (destination !== join(root, 'space.db') && !destination.startsWith(resolvedRoot))
      throw new Error(`迁移包路径越界：${header.path}`);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const temp = `${destination}${TEMP_SUFFIX}`;
    const handle = await open(temp, 'w', 0o600);
    try {
      await reader.pipe(header.size, async (chunk) => {
        await handle.write(chunk);
        payloadBytes += chunk.byteLength;
        progress?.(payloadBytes);
      });
    } finally {
      await handle.close();
    }
    if ((await open(temp, 'r').then(async (probe) => {
      const stat = await probe.stat();
      await probe.close();
      return stat.size;
    })) !== header.size) {
      await rm(temp, { force: true });
      throw new Error(`迁移包文件长度不符：${relativePath}`);
    }
    await rename(temp, destination);
    fileCount += 1;
  }
  return { fileCount, payloadBytes };
}

/** Compute one file's SHA-256 without buffering it in memory. */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Determine whether `relativePath` belongs to the files a bundle may carry.
 * Exported for server-side request validation.
 */
export function isBundlePartName(name: string): boolean {
  return /^part-[a-z0-9-]+\.bundle$/.test(name);
}

/**
 * Count regular files under one unpacked bundle directory.
 *
 * The migration handshake uses this as a cheap "the whole bundle arrived"
 * check: the exchanged file count must equal the number of files the sender
 * packed (database plus assets). Symlinks are ignored because bundles never
 * carry them.
 * @param directory - unpacked bundle root.
 */
export async function countUnpackedFiles(directory: string): Promise<number> {
  let count = 0;
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) count += 1;
    }
  }
  await walk(directory);
  return count;
}

/** Enumerate files under the Space assets directory as bundle entries. */
export async function listAssetEntries(
  dataDirectory: string,
): Promise<BundleFileEntry[]> {
  const { readdir } = await import('node:fs/promises');
  const assetsRoot = join(dataDirectory, 'assets');
  const entries: BundleFileEntry[] = [];
  async function walk(directory: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === '.DS_Store') continue;
      const absolute = join(directory, name);
      const { stat } = await import('node:fs/promises');
      const info = await stat(absolute);
      if (info.isDirectory()) {
        await walk(absolute);
      } else if (info.isFile()) {
        const relativePath = relative(dataDirectory, absolute).split(sep).join('/');
        entries.push({ path: relativePath, source: absolute });
      }
    }
  }
  await walk(assetsRoot);
  return entries;
}
