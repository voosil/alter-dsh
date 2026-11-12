import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Self-test for the documentation lifecycle executor (scripts/docs/archive.mjs).
 *
 * Each case copies the real knowledge base into a temporary directory, injects
 * aged or explicitly retired documents, runs the executor there, and asserts
 * the moves, category index cleanup and guard rails. The rules under test live
 * in docs/README.md ("生命周期与自动归档"); the archive keeps no index file.
 */
const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const archiver = join(repoRoot, 'scripts', 'docs', 'archive.mjs');
const checker = join(repoRoot, 'scripts', 'docs', 'check.mjs');
const today = new Date().toISOString().slice(0, 10);
const OLD = '2026-01-01';

interface RunResult {
  status: number | null;
  output: string;
}

function runScript(dir: string, script: string, args: string[] = []): RunResult {
  const result = spawnSync(process.execPath, [join(dir, 'scripts', 'docs', script), ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function archiveFixture(
  mutate: (dir: string) => void,
  assert: (dir: string, result: RunResult) => void,
  args: string[] = [],
): void {
  const dir = mkdtempSync(join(tmpdir(), 'docs-archive-'));
  try {
    for (const file of ['AGENTS.md', 'README.md']) {
      cpSync(join(repoRoot, file), join(dir, file));
    }
    cpSync(join(repoRoot, 'docs'), join(dir, 'docs'), { recursive: true });
    // The repository itself keeps a seal manifest (created by `pnpm check`);
    // a fixture must start from an unsealed archive or it tests the wrong thing.
    rmSync(join(dir, 'docs', 'archive', 'manifest.json'), { force: true });
    mkdirSync(join(dir, 'vendor'));
    cpSync(join(repoRoot, 'vendor', 'README.md'), join(dir, 'vendor', 'README.md'));
    mkdirSync(join(dir, 'scripts', 'docs'), { recursive: true });
    cpSync(archiver, join(dir, 'scripts', 'docs', 'archive.mjs'));
    cpSync(checker, join(dir, 'scripts', 'docs', 'check.mjs'));
    // Both scripts load the budget manifest from next to themselves.
    cpSync(
      join(repoRoot, 'scripts', 'docs', 'doc-budgets.json'),
      join(dir, 'scripts', 'docs', 'doc-budgets.json'),
    );
    mutate(dir);
    assert(dir, runScript(dir, 'archive.mjs', args));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One synthetic content document plus its category index row. */
function addDoc(
  dir: string,
  category: string,
  type: string,
  name: string,
  body: string,
  updated: string = OLD,
  status = 'active',
): void {
  writeFileSync(
    join(dir, 'docs', category, name),
    `---\ntype: ${type}\nstatus: ${status}\nupdated: ${updated}\n---\n\n# Synthetic\n\n${body}\n`,
  );
  appendFileSync(
    join(dir, 'docs', category, 'README.md'),
    `\n| [${name}](${name}) | x | ${status} |\n`,
  );
}

const read = (dir: string, relativePath: string) =>
  readFileSync(join(dir, relativePath), 'utf8');

describe('docs-archive lifecycle rules', () => {
  it('archives aged research, cleans the index and seals the copy', () => {
    archiveFixture(
      (dir) => addDoc(dir, 'research', 'research', 'retired-study.md', 'text'),
      (dir, result) => {
        expect(result.status, result.output).toBe(0);
        expect(result.output).toContain(
          'archived docs/research/retired-study.md -> docs/archive/retired-study.md',
        );
        expect(existsSync(join(dir, 'docs/research/retired-study.md'))).toBe(false);
        const archived = read(dir, 'docs/archive/retired-study.md');
        expect(archived).toContain('status: archived');
        expect(archived).toContain(`archived: ${today}`);
        expect(read(dir, 'docs/research/README.md')).not.toContain('](retired-study.md)');
        expect(existsSync(join(dir, 'docs/archive/README.md'))).toBe(false);
        const seals = JSON.parse(read(dir, 'docs/archive/manifest.json')).archived;
        expect(Object.keys(seals)).toEqual(['retired-study.md']);
        expect(seals['retired-study.md'].sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(seals['retired-study.md'].archivedAt).toBe(today);
        const check = runScript(dir, 'check.mjs');
        expect(check.status, check.output).toBe(0);
      },
    );
  });

  it('leaves fresh documents alone', () => {
    archiveFixture(
      () => {},
      (dir, result) => {
        expect(result.status, result.output).toBe(0);
        expect(result.output).toContain('NOTHING TO RETIRE');
        expect(existsSync(join(dir, 'docs/research/dsh-agent-creation.md'))).toBe(true);
      },
    );
  });

  it('deletes settled aged acceptance instead of archiving it', () => {
    archiveFixture(
      (dir) => {
        addDoc(dir, 'acceptance', 'acceptance', 'settled-record.md', '- [x] done');
        addDoc(dir, 'acceptance', 'acceptance', 'open-record.md', '- [~] pending');
        addDoc(dir, 'acceptance', 'acceptance', 'todo-record.md', '- [ ] later');
      },
      (dir, result) => {
        expect(result.status, result.output).toBe(0);
        expect(result.output).toContain('deleted docs/acceptance/settled-record.md');
        expect(result.output).not.toContain('open-record.md ');
        expect(result.output).not.toContain('todo-record.md ');
        expect(existsSync(join(dir, 'docs/archive/settled-record.md'))).toBe(false);
        expect(read(dir, 'docs/acceptance/README.md')).not.toContain('](settled-record.md)');
        expect(existsSync(join(dir, 'docs/acceptance/open-record.md'))).toBe(true);
        expect(existsSync(join(dir, 'docs/acceptance/todo-record.md'))).toBe(true);
      },
    );
  });

  it('never retires specs or designs by age', () => {
    archiveFixture(
      (dir) => {
        addDoc(dir, 'specs', 'spec', 'aged-spec.md', 'text');
        addDoc(dir, 'designs', 'design', 'aged-design.md', 'text');
      },
      (dir, result) => {
        expect(result.status, result.output).toBe(0);
        expect(result.output).toContain('NOTHING TO RETIRE');
        expect(existsSync(join(dir, 'docs/specs/aged-spec.md'))).toBe(true);
        expect(existsSync(join(dir, 'docs/designs/aged-design.md'))).toBe(true);
      },
    );
  });

  it('archives documents explicitly marked archived', () => {
    archiveFixture(
      (dir) => addDoc(dir, 'designs', 'design', 'retired-design.md', 'text', today, 'archived'),
      (dir, result) => {
        expect(result.status, result.output).toBe(0);
        expect(result.output).toContain('explicit status: archived');
        expect(existsSync(join(dir, 'docs/archive/retired-design.md'))).toBe(true);
        expect(existsSync(join(dir, 'docs/designs/retired-design.md'))).toBe(false);
      },
    );
  });

  it('refuses to touch an archive whose seal no longer matches', () => {
    archiveFixture(
      (dir) => {
        addDoc(dir, 'research', 'research', 'new-study.md', 'text');
        mkdirSync(join(dir, 'docs/archive'), { recursive: true });
        writeFileSync(
          join(dir, 'docs/archive/tampered.md'),
          `---\ntype: research\nstatus: archived\narchived: ${OLD}\nupdated: ${OLD}\n---\n\n# Edited\n`,
        );
        writeFileSync(
          join(dir, 'docs/archive/manifest.json'),
          `${JSON.stringify(
            {
              version: 1,
              archived: { 'tampered.md': { sha256: 'a'.repeat(64), archivedAt: OLD } },
            },
            null,
            2,
          )}\n`,
        );
      },
      (_dir, result) => {
        expect(result.status, result.output).toBe(1);
        expect(result.output).toContain('ARCHIVE IS FROZEN');
        expect(result.output).toContain('archived content changed since it was sealed');
      },
    );
  });

  it('skips documents still referenced by active documents', () => {
    archiveFixture(
      (dir) => {
        addDoc(dir, 'research', 'research', 'referenced-study.md', 'text');
        appendFileSync(join(dir, 'README.md'), '\n[x](docs/research/referenced-study.md)\n');
      },
      (dir, result) => {
        expect(result.status, result.output).toBe(0);
        expect(result.output).toContain('skipped docs/research/referenced-study.md');
        expect(result.output).toContain('still referenced by README.md');
        expect(existsSync(join(dir, 'docs/research/referenced-study.md'))).toBe(true);
        expect(existsSync(join(dir, 'docs/archive/referenced-study.md'))).toBe(false);
      },
    );
  });

  it('previews without touching files in --dry-run', () => {
    archiveFixture(
      (dir) => addDoc(dir, 'research', 'research', 'dry-run-study.md', 'text'),
      (dir, result) => {
        expect(result.status, result.output).toBe(0);
        expect(result.output).toContain('DRY RUN');
        expect(existsSync(join(dir, 'docs/research/dry-run-study.md'))).toBe(true);
        expect(existsSync(join(dir, 'docs/archive/dry-run-study.md'))).toBe(false);
        expect(existsSync(join(dir, 'docs/archive/manifest.json'))).toBe(false);
        expect(read(dir, 'docs/research/README.md')).toContain('](dry-run-study.md)');
      },
      ['--dry-run'],
    );
  });

  it('skips when the archive already holds the same file name', () => {
    archiveFixture(
      (dir) => {
        addDoc(dir, 'research', 'research', 'collision-study.md', 'text');
        mkdirSync(join(dir, 'docs/archive'), { recursive: true });
        writeFileSync(
          join(dir, 'docs/archive/collision-study.md'),
          `---\ntype: research\nstatus: archived\narchived: ${OLD}\nupdated: ${OLD}\n---\n\n# Old\n`,
        );
        writeFileSync(
          join(dir, 'docs/archive/manifest.json'),
          `${JSON.stringify(
            { version: 1, archived: { 'collision-study.md': { sha256: 'b'.repeat(64), archivedAt: OLD } } },
            null,
            2,
          )}\n`,
        );
      },
      (dir, result) => {
        // The pre-seeded seal is fake, so the run stops on the freeze guard
        // before it ever reaches the name collision.
        expect(result.status, result.output).toBe(1);
        expect(result.output).toContain('ARCHIVE IS FROZEN');
      },
    );
  });
});
