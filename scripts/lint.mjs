#!/usr/bin/env node
/**
 * Lint entry point.
 *
 * Runs the oxlint binary shipped in `node_modules/.bin` with the repository
 * config. Any error fails the run; warnings do not (the accepted warning
 * backlog is recorded in `docs/designs/test-strategy.md`). `--strict` treats
 * warnings as failures and is what the nightly job uses.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const strict = process.argv.includes('--strict');
const binary = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'oxlint.cmd' : 'oxlint',
);
const args = ['-c', path.join('build', 'oxlint.json'), ...(strict ? ['--deny-warnings'] : [])];

const result = spawnSync(binary, args, {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (result.error) {
  console.error(`lint: could not run oxlint (${result.error.message})`);
  process.exit(1);
}
process.exit(result.status ?? 1);