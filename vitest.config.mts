/**
 * Vitest workspace configuration.
 *
 * Three projects mirror the test layers in `tests/layers.mjs`: `unit` runs
 * without I/O, `integration` drives real SQLite and a real HTTP server, and
 * `ui` runs the frozen legacy editor in jsdom. The environment is declared per
 * project instead of per file, so a browser-environment file cannot pull a
 * `node:sqlite` chain into the jsdom bundle by accident.
 *
 * `pnpm test` runs the gated projects and skips the long fuzz suite;
 * `pnpm test:nightly` adds the nightly set. The rules and the rationale live in
 * `docs/specs/system-architecture.md` §5.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import {
  LAYERS,
  LAYER_DEFINITIONS,
  NIGHTLY_INCLUDE,
  PR_EXCLUDE,
} from './tests/layers.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const vendorSrc = (name) => path.join(root, 'vendor', name, 'src');
const nightly = process.env.SPACE_NIGHTLY === '1';

const alias = [
  {
    find: /^@alter\/ui-space\/(.*)$/,
    replacement: path.join(vendorSrc('ui-space'), '$1'),
  },
  {
    find: /^@alter\/ui-space$/,
    replacement: path.join(vendorSrc('ui-space'), 'index.ts'),
  },
  {
    find: /^@alter\/ui-settings\/SettingsPage$/,
    replacement: path.join(vendorSrc('ui-settings'), 'SettingsPage.tsx'),
  },
  {
    find: /^@alter\/ui-system$/,
    replacement: path.join(vendorSrc('ui-system'), 'index.ts'),
  },
  {
    find: /^@alter\/ui-system\/tokens\.css$/,
    replacement: path.join(vendorSrc('ui-system'), 'styles', 'tokens.css'),
  },
  {
    find: /^@alter\/ui-workbench$/,
    replacement: path.join(vendorSrc('ui-workbench'), 'index.ts'),
  },
  {
    find: /^@alter\/mock-workbench$/,
    replacement: path.join(vendorSrc('mock-workbench'), 'index.ts'),
  },
  {
    find: /^@alter\/protocol$/,
    replacement: path.join(vendorSrc('protocol'), 'index.ts'),
  },
  {
    find: /^@alter\/client-modules$/,
    replacement: path.join(vendorSrc('client-modules'), 'index.ts'),
  },
  {
    // Document-runtime seam (frozen page keeps DOM/CSS; runtime owns saves,
    // drafts, snapshots and HTML projection).
    find: /^@alter-space\/document-runtime$/,
    replacement: path.join(root, 'src', 'document', 'runtime', 'index.ts'),
  },
];

/**
 * Build one Vitest project entry for a test layer.
 * @param {string} name - layer name from `tests/layers.mjs`.
 */
function project(name) {
  const definition = LAYER_DEFINITIONS[name];
  if (!definition) throw new Error(`unknown test layer: ${name}`);
  return {
    resolve: { alias },
    test: {
      name,
      include: definition.include,
      exclude: PR_EXCLUDE,
      environment: definition.environment === 'dom' ? 'jsdom' : 'node',
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  };
}

/**
 * The nightly project re-runs the long suites that the gate excludes.
 * `SPACE_NIGHTLY=1` swaps the gated set for this one.
 */
const nightlyProject = {
  resolve: { alias },
  test: {
    name: 'nightly',
    include: [...NIGHTLY_INCLUDE, ...PR_EXCLUDE],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
};

export default defineConfig({
  test: {
    projects: nightly ? [nightlyProject] : LAYERS.map(project),
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage',
      include: ['host/**/*.ts', 'src/**/*.ts', 'src/**/*.tsx', 'server/**/*.ts'],
      exclude: ['**/*.test.ts', 'src/entry.js', 'src/app/**', 'src/settings/**'],
      // Vitest only takes whole-project thresholds, so the directory floors in
      // `tests/layers.mjs` are enforced by `scripts/coverage/report.mjs`.
    },
  },
});