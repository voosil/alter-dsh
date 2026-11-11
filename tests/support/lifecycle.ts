/**
 * Test support: shared lifecycle, builders and fakes.
 *
 * Tests never import another test file; everything reusable lives here. Each
 * helper owns one lifecycle concern so a test file only declares what it needs
 * and inherits cleanup semantics instead of re-implementing them.
 */
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

/** Fixed business clock shared by assertions that pin timestamps. */
export const FIXED_NOW = () => new Date('2026-11-09T00:00:00.000Z');

const directories: string[] = [];
const disposers: Array<() => Promise<void> | void> = [];

/**
 * Create a temporary directory owned by the current test file.
 *
 * The directory is removed after each test (after registered disposers ran),
 * so callers never write their own `rm` bookkeeping.
 * @param prefix - temp-dir prefix, e.g. `space-store-`.
 */
export async function tempDir(prefix = 'alter-space-'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/**
 * Register a teardown that runs after each test, before temp dirs are removed.
 * Disposers run in reverse registration order (last created, first closed).
 */
export function dispose(fn: () => Promise<void> | void): void {
  disposers.push(fn);
}

/**
 * Create a directory under `base` and return it.
 * @param base - parent directory (usually a {@link tempDir}).
 * @param name - child directory name or nested relative path.
 */
export async function subDir(base: string, name: string): Promise<string> {
  const directory = join(base, name);
  await mkdir(directory, { recursive: true });
  return directory;
}

/** A logger that swallows both channels; Host code logs warnings by design. */
export function quietLogger(): { info: (message: string) => void; warn: (message: string) => void } {
  return { info: () => undefined, warn: () => undefined };
}

/**
 * Poll `predicate` until it holds.
 * @param predicate - condition to observe.
 * @param options.timeoutMs - give up after this many milliseconds.
 * @param options.message - error text when the deadline is reached.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 5_000, message = 'condition was not met in time' }: { timeoutMs?: number; message?: string } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  for (const fn of disposers.splice(0).reverse()) await fn();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});