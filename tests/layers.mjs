/**
 * Test layer definitions shared by the Vitest projects, the layer runner and
 * the architecture guard.
 *
 * Every test file lives under `tests/<layer>/…`; the layer decides the runtime
 * environment, when the file runs (PR gate vs nightly) and what it may import.
 * The rules themselves are documented in `docs/specs/system-architecture.md` §5; this
 * module is the single source the tooling reads.
 */

/** Layer names in execution order, cheapest first. */
export const LAYERS = ['unit', 'integration', 'ui'];

/**
 * @typedef {object} LayerDefinition
 * @property {'node' | 'dom'} environment - `dom` runs the file in jsdom.
 * @property {string[]} include - Repository-relative globs owned by the layer.
 * @property {string} description - Human-readable scope of the layer.
 */

/** @type {Record<string, LayerDefinition>} */
export const LAYER_DEFINITIONS = {
  unit: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    description: '纯函数与静态契约：AST 引擎、投影、映射、构建覆盖，无文件系统',
  },
  integration: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    description: 'Host 与持久化：真 SQLite、真 HTTP 服务端、迁移、远程队列',
  },
  ui: {
    environment: 'dom',
    include: ['tests/ui/**/*.test.ts'],
    description: '浏览器行为：冻结旧编辑器的 DOM/CSS 契约（只经 data-* 选择器定位）',
  },
};

/** Globs that only run in `pnpm test:nightly` (long or slow suites). */
export const NIGHTLY_INCLUDE = ['tests/nightly/**/*.test.ts'];

/**
 * Files that sleep or fan out at scale. They stay out of the PR gate and run
 * from the nightly set instead.
 */
export const PR_EXCLUDE = ['tests/integration/document/fuzz.test.ts'];

/**
 * Coverage floors per source directory (percent, line and statement).
 *
 * Enforced by `scripts/coverage-report.mjs` over the JSON summary the coverage
 * run writes. Measured values sit ~10 points above each floor so ordinary
 * refactors do not trip it; raise a floor when the measured value stays higher.
 */
export const COVERAGE_FLOORS = {
  'host/authority': { lines: 90, statements: 85 },
  'host/persistence': { lines: 85, statements: 80 },
  'host/document/ast': { lines: 85, statements: 80 },
  'host/document/editors/legacy': { lines: 80, statements: 75 },
  'host/control': { lines: 70, statements: 65 },
  'host/core': { lines: 70, statements: 65 },
  'host/remote': { lines: 65, statements: 60 },
  'host/workspace': { lines: 85, statements: 80 },
  'server': { lines: 70, statements: 65 },
};