/**
 * Layering guards.
 *
 * `docs/specs/system-architecture.md` §5 allows exactly three layers; a test file outside them, or
 * one that reaches across a forbidden boundary, is a review finding that this
 * suite turns into a build failure. oxlint enforces the per-file import rules;
 * this suite enforces the layout and the rules oxlint cannot express.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LAYERS, LAYER_DEFINITIONS } from '../../layers.mjs';

const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

/** Every file under a directory, recursively. */
async function walk(directory: string, found: string[] = []): Promise<string[]> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) await walk(full, found);
    else found.push(full);
  }
  return found;
}

/** Files that are part of the test surface (tests and test support). */
const TEST_FILE = /\.test\.ts$/;
const SUPPORT_DIR = join(root, 'tests', 'support');

describe('test layout', () => {
  it('keeps every test file inside a declared layer directory', async () => {
    const files = (await walk(join(root, 'tests'))).filter((file) => TEST_FILE.test(file));
    const strays = files
      .map((file) => relative(join(root, 'tests'), file).split(sep))
      .filter(([layer]) => !LAYERS.includes(layer) && layer !== 'nightly')
      .map((parts) => parts.join('/'));
    expect(strays).toEqual([]);
  });

  it('keeps test files out of the support directory', async () => {
    const files = (await walk(SUPPORT_DIR)).filter((file) => TEST_FILE.test(file));
    expect(files.map((file) => relative(root, file))).toEqual([]);
  });

  it('never imports a test file from test support', async () => {
    const offenders: string[] = [];
    for (const file of await walk(SUPPORT_DIR)) {
      if (!file.endsWith('.ts')) continue;
      const text = await readFile(file, 'utf8');
      if (/from '[^']*\.test'/.test(text)) offenders.push(relative(root, file));
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the ui layer free of host and server imports', async () => {
    const uiDir = join(root, 'tests', 'ui');
    const offenders: string[] = [];
    // The pure AST modules are the client-editor contract: `src/` already
    // depends on them, so the ui layer may too. Everything that touches a
    // store, router, runtime or remote link is forbidden.
    const pureContracts = [
      /\/host\/document\/ast\/(operations|schema|projection)\.js$/,
      /\/host\/document\/editors\/legacy\/(types|markdown)\.js$/,
    ];
    for (const file of await walk(uiDir)) {
      if (!TEST_FILE.test(file)) continue;
      const text = await readFile(file, 'utf8');
      for (const match of text.matchAll(/^import (?!type)[^\n]*from '([^']+)'/gm)) {
        const target = match[1];
        if (!/(?:\.\.\/)+(?:host|server)\//.test(target)) continue;
        if (match[0].startsWith('import type')) continue;
        if (pureContracts.some((pattern) => pattern.test(target))) continue;
        offenders.push(`${relative(root, file)} -> ${target}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('declares one environment per layer', () => {
    for (const layer of LAYERS) {
      expect(['node', 'dom']).toContain(LAYER_DEFINITIONS[layer].environment);
    }
  });
});