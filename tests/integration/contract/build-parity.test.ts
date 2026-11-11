/**
 * Build-time wiring parity.
 *
 * The `@alter/*` aliases and the legacy adapter seam are declared in three
 * places (`build/build.mjs`, `tsconfig.json` paths, `vitest.config.mts`);
 * AGENTS.md requires them to stay in sync. `docs/specs/system-architecture.md` §5 records why.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LAYERS, LAYER_DEFINITIONS } from '../../layers.mjs';

const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

describe('module alias parity', () => {
  /**
   * The alias name appears as a regex source in build/vitest
   * (`/^@alter-space\/legacy-adapter$/`) and as a literal key in tsconfig
   * (`"@alter-space/legacy-adapter"`), so compare the unescaped form.
   */
  const ALIAS = '@alter-space/legacy-adapter';
  const unescape = (text: string): string => text.replace(/\\\//g, '/');

  it('declares the legacy adapter seam in build, tsconfig and vitest', async () => {
    const [build, tsconfig, vitest] = await Promise.all([
      readFile(join(root, 'build', 'build.mjs'), 'utf8'),
      readFile(join(root, 'tsconfig.json'), 'utf8'),
      readFile(join(root, 'vitest.config.mts'), 'utf8'),
    ]);
    const expectedSegments = ['src', 'document', 'editors', 'legacy', 'index.ts'];
    for (const [name, text] of [
      ['build/build.mjs', build],
      ['tsconfig.json', tsconfig],
      ['vitest.config.mts', vitest],
    ] as const) {
      const source = unescape(text);
      expect(source, name).toContain(ALIAS);
      const normalized = source.replace(/['",\s]/g, '/');
      for (const segment of expectedSegments) expect(normalized, `${name}: ${segment}`).toContain(segment);
    }
  });

  it('keeps the directory-field override out of the plain module graph', async () => {
    const build = await readFile(join(root, 'build', 'build.mjs'), 'utf8');
    const override = await readFile(join(root, 'build', 'directory-field-override.mjs'), 'utf8');
    expect(build).toContain('createDirectoryFieldOverride');
    expect(override).toContain('CreateSpaceDialog.tsx');
    expect(override).toContain('ConfigView.tsx');
  });
});

describe('test layer wiring', () => {
  it('gives every layer an include glob under its own directory', () => {
    for (const layer of LAYERS) {
      const definition = LAYER_DEFINITIONS[layer];
      expect(definition, layer).toBeDefined();
      for (const glob of definition.include) {
        expect(glob, layer).toMatch(new RegExp(`^tests/${layer}/`));
      }
    }
  });
});