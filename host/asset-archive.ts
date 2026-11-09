/**
 * Minimal streaming tar.gz writer for the document asset directory.
 *
 * Daily snapshots back up the SQLite database; asset bytes live outside it and
 * are archived next to the database snapshot so a restore can cover both.
 * The writer is intentionally dependency-free (ustar subset + gzip).
 *
 * @module @alter-dsh/space/asset-archive
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createGzip } from 'node:zlib';
import { finished } from 'node:stream/promises';

const BLOCK = 512;

function writeString(buffer: Buffer, value: string, offset: number, length: number): void {
  const bytes = Buffer.from(value, 'utf8');
  for (let index = 0; index < length; index += 1)
    buffer[offset + index] = index < bytes.length ? bytes[index]! : 0;
}

function tarHeader(name: string, size: number, mtime: number): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  writeString(header, name, 0, 100);
  writeString(header, '0000644\0', 100, 8);
  writeString(header, '0000000\0', 108, 8);
  writeString(header, '0000000\0', 116, 8);
  writeString(header, `${size.toString(8).padStart(11, '0')}\0`, 124, 12);
  writeString(header, `${Math.floor(mtime / 1000).toString(8).padStart(11, '0')}\0`, 136, 12);
  writeString(header, '        ', 148, 8);
  header[156] = '0'.charCodeAt(0);
  writeString(header, 'ustar\0', 257, 6);
  writeString(header, '00', 263, 2);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeString(header, `${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return header;
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parentPath = entry.parentPath ?? root;
    files.push(join(parentPath, entry.name));
  }
  files.sort();
  return files;
}

export interface AssetArchiveResult {
  files: number;
  bytes: number;
}

/**
 * Write `<sourceDirectory>/assets` as a gzipped tar at `destination`.
 * A missing/empty asset directory produces an empty archive unless
 * `skipWhenEmpty` is true.
 */
export async function writeAssetArchive(options: {
  dataDirectory: string;
  destination: string;
  skipWhenEmpty?: boolean;
}): Promise<AssetArchiveResult> {
  const root = join(options.dataDirectory, 'assets');
  let files: string[] = [];
  try {
    files = await listFiles(root);
  } catch {
    files = [];
  }
  if (files.length === 0 && options.skipWhenEmpty === true)
    return { files: 0, bytes: 0 };

  const gzip = createGzip({ level: 6 });
  const output = createWriteStream(options.destination, { mode: 0o600 });
  gzip.pipe(output);
  gzip.on('error', (error) => output.destroy(error));
  const write = async (chunk: Buffer): Promise<void> => {
    if (!gzip.write(chunk)) await new Promise<void>((resolve) => gzip.once('drain', resolve));
  };
  let bytes = 0;
  try {
    for (const file of files) {
      const info = await stat(file);
      const name = `assets/${relative(root, file).replaceAll('\\', '/')}`;
      await write(tarHeader(name, info.size, info.mtimeMs));
      for await (const chunk of createReadStream(file)) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        await write(buffer);
      }
      const remainder = info.size % BLOCK;
      if (remainder !== 0) await write(Buffer.alloc(BLOCK - remainder, 0));
    }
    await write(Buffer.alloc(BLOCK * 2, 0));
    gzip.end();
    await finished(output);
  } catch (error) {
    gzip.destroy();
    output.destroy();
    throw error;
  }
  return { files: files.length, bytes };
}
