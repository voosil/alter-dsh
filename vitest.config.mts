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
import os from 'node:os';
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

/**
 * jsdom 层的并发上限。
 *
 * 每个测试文件都创建一个完整 DOM 环境；文件数超过可用核心后，工作线程互相
 * 抢占会让异步等待（testing-library 的 `waitBy*` 默认 1s）在正确行为下也超时。
 * 限流让并发回归核心数以内，断言强度不变。
 */
const CPU_COUNT = os.availableParallelism?.() ?? os.cpus().length ?? 4;

/** 全局并发上限：不超过可用核心。 */
const GLOBAL_MAX_WORKERS = Math.max(1, Math.min(6, CPU_COUNT));

/** jsdom 层并发上限：DOM 环境创建是主要成本，再多的并发只会互相拖慢。 */
const DOM_LAYER_MAX_WORKERS = Math.max(1, Math.min(4, Math.floor(CPU_COUNT / 2)));

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
function project(name, index) {
  const definition = LAYER_DEFINITIONS[name];
  if (!definition) throw new Error(`unknown test layer: ${name}`);
  const dom = definition.environment === 'dom';
  return {
    resolve: { alias },
    test: {
      name,
      include: definition.include,
      exclude: PR_EXCLUDE,
      environment: dom ? 'jsdom' : 'node',
      testTimeout: 30_000,
      hookTimeout: 30_000,
      // jsdom 层的成本是一次完整 DOM 环境的创建，并发数超过 CPU 的可用核心后
      // 只会互相拖慢：既有的异步断言（testing-library 默认 1s）会因调度排队而
      // 超时。并发是时序类缺陷的直接成因，所以这里按层限流而不是放宽断言。
      // 各项目 maxWorkers 不同，Vitest 要求同时给出唯一的 groupOrder。
      ...(dom
        ? {
          maxWorkers: DOM_LAYER_MAX_WORKERS,
          // 统一放宽 testing-library 的异步等待窗口，见该文件说明。
          setupFiles: [path.join(root, 'tests', 'support', 'ui-setup.ts')],
        }
        : {}),
      sequence: { groupOrder: index },
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
    // 与分层项目不同名不同并发，给一个不与 `LAYERS` 序号冲突的顺序值。
    sequence: { groupOrder: 100 },
  },
};

export default defineConfig({
  test: {
    // 全局并发上限：三个项目并行时，integration 的真 SQLite 与 ui 的 jsdom 会互相
    // 抢占；核心数以内运行才能让异步断言只看行为，不看排队。
    maxWorkers: GLOBAL_MAX_WORKERS,
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