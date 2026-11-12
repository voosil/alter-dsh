#!/usr/bin/env node
/**
 * Remove the compiled Host/server output before a TypeScript rebuild.
 *
 * `tsc` only overwrites files, so a module deleted from `host/` would keep its
 * stale `lib/` output forever and ship inside the plugin package. The Host
 * build is fully generated, so clearing it first is always safe.
 */
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
await rm(join(root, 'lib'), { recursive: true, force: true });
