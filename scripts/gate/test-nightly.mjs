#!/usr/bin/env node
/**
 * Nightly verification entry point.
 *
 * Runs the long suites the PR gate skips (the full seeded fuzz pass, anything
 * under `tests/nightly/`) and then the strict lint. Nothing here belongs in the
 * commit gate: the fuzz pass takes ~20 s on its own and the strict lint treats
 * the accepted warning backlog as failures.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const shell = process.platform === 'win32';

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell });
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

run('node', [path.join('scripts', 'gate', 'lint.mjs'), '--strict']);
run('npx', ['vitest', 'run', '--project', 'nightly']);
run('node', [path.join('scripts', 'coverage', 'report.mjs')]);