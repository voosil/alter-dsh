#!/usr/bin/env node
/**
 * Coverage report + directory floors.
 *
 * Vitest only takes whole-project thresholds, which is the wrong shape here:
 * the frozen UI and thin wiring would drag a single number around, while the
 * write paths are what actually need a ratchet. This script reads the JSON
 * summary the coverage run writes and enforces one line/statement floor per
 * source directory from `tests/layers.mjs`.
 *
 * Usage: run `pnpm test:coverage` first, then `pnpm coverage:report`.
 *   `pnpm coverage:report --print` only prints measured values.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COVERAGE_FLOORS } from '../tests/layers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const summaryFile = path.join(root, 'coverage', 'coverage-summary.json');

function normalize(file) {
  return path.relative(root, file).split(path.sep).join('/');
}

async function main() {
  let summary;
  try {
    summary = JSON.parse(await readFile(summaryFile, 'utf8'));
  } catch {
    console.error(`FAIL  coverage summary not found at ${normalize(summaryFile)}`);
    console.error('      run `pnpm test:coverage` first');
    process.exit(1);
  }

  const perDirectory = new Map();
  for (const [file, metrics] of Object.entries(summary)) {
    if (file === 'total') continue;
    const relative = normalize(file);
    for (const [directory, floor] of Object.entries(COVERAGE_FLOORS)) {
      if (!relative.startsWith(`${directory}/`)) continue;
      const bucket = perDirectory.get(directory) ?? {
        lines: { covered: 0, total: 0 },
        statements: { covered: 0, total: 0 },
      };
      bucket.lines.covered += metrics.lines.covered;
      bucket.lines.total += metrics.lines.total;
      bucket.statements.covered += metrics.statements.covered;
      bucket.statements.total += metrics.statements.total;
      bucket.floor = floor;
      perDirectory.set(directory, bucket);
    }
  }

  const printOnly = process.argv.includes('--print');
  const failures = [];
  const format = (metric) =>
    metric.total === 0 ? 'n/a' : `${((metric.covered / metric.total) * 100).toFixed(1)}%`;
  for (const directory of Object.keys(COVERAGE_FLOORS).sort()) {
    const bucket = perDirectory.get(directory);
    const floor = COVERAGE_FLOORS[directory];
    if (bucket === undefined) {
      failures.push(`${directory}: no covered files matched the floor target`);
      continue;
    }
    const lineRatio = bucket.lines.total === 0 ? 0 : (bucket.lines.covered / bucket.lines.total) * 100;
    const statementRatio =
      bucket.statements.total === 0 ? 0 : (bucket.statements.covered / bucket.statements.total) * 100;
    console.log(
      `${directory}: lines ${format(bucket.lines)} (floor ${floor.lines}%) ` +
        `statements ${format(bucket.statements)} (floor ${floor.statements}%)`,
    );
    if (printOnly) continue;
    if (lineRatio < floor.lines)
      failures.push(`${directory}: lines ${lineRatio.toFixed(1)}% below the ${floor.lines}% floor`);
    if (statementRatio < floor.statements)
      failures.push(
        `${directory}: statements ${statementRatio.toFixed(1)}% below the ${floor.statements}% floor`,
      );
  }

  if (failures.length > 0) {
    console.error('FAIL');
    for (const failure of failures) console.error(`- ${failure}`);
    console.error('- raise work, or lower a floor in tests/layers.mjs with a reason');
    process.exit(1);
  }
  console.log(printOnly ? 'PASS (print only)' : 'PASS');
}

await main();