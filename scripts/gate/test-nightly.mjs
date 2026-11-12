#!/usr/bin/env node
/**
 * Nightly verification entry point.
 *
 * Runs the long suites the PR gate skips (the full seeded fuzz pass, anything
 * under `tests/nightly/`), the per-directory coverage floors and finally the
 * strict lint. Nothing here belongs in the commit gate: the fuzz pass takes
 * ~20 s on its own and the strict lint treats the accepted warning backlog as
 * failures.
 *
 * Order matters: the strict lint runs last, because a single warning there
 * would otherwise hide the test and coverage results behind one exit code.
 * The suites need `SPACE_NIGHTLY=1`, which is the only mode where
 * `vitest.config.mts` registers the `nightly` project; coverage is produced by
 * the same run because `coverage/report.mjs` only reads what `--coverage`
 * wrote.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAYERS } from '../../tests/layers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const shell = process.platform === 'win32';

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell,
    env: { ...process.env, ...env },
  });
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

// Coverage is measured over the whole gated suite, so the PR projects are run
// *in addition* to the nightly ones: `SPACE_NIGHTLY=1` alone would replace
// them and every Host floor would read 0%.
const vitest =
  process.platform === 'win32'
    ? path.join('node_modules', '.bin', 'vitest.cmd')
    : path.join('node_modules', '.bin', 'vitest');
// The repository binary, not `npx`: the gate must not depend on registry access.
const gated = LAYERS.map((name) => `--project=${name}`);
run(vitest, ['run', '--coverage', ...gated]);
// Coverage is reported before the nightly suites run: every `--coverage` run
// rewrites the summary, so a nightly pass afterwards would replace the numbers
// with fuzz-only measurements and fail every floor.
run('node', [path.join('scripts', 'coverage', 'report.mjs')]);
run(vitest, ['run'], { SPACE_NIGHTLY: '1' });
run('node', [path.join('scripts', 'gate', 'lint.mjs'), '--strict']);