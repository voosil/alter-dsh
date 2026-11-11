import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
 * Self-test for the documentation governance checker (scripts/docs/check.mjs).
 *
 * Each case copies the real knowledge base into a temporary directory, injects
 * one violation (or one legitimate pattern), runs the checker there, and asserts
 * the expected exit code. This keeps the mechanical rules in docs/README.md from
 * silently regressing when the checker changes.
 */
const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const checker = join(repoRoot, 'scripts', 'docs', 'check.mjs');

interface CheckResult {
  status: number | null;
  output: string;
}

function withFixture(mutate?: (dir: string) => void): CheckResult {
  const dir = mkdtempSync(join(tmpdir(), 'docs-check-'));
  try {
    for (const file of ['AGENTS.md', 'README.md']) {
      cpSync(join(repoRoot, file), join(dir, file));
    }
    cpSync(join(repoRoot, 'docs'), join(dir, 'docs'), { recursive: true });
    mkdirSync(join(dir, 'vendor'));
    cpSync(join(repoRoot, 'vendor', 'README.md'), join(dir, 'vendor', 'README.md'));
    mkdirSync(join(dir, 'scripts', 'docs'), { recursive: true });
    cpSync(checker, join(dir, 'scripts', 'docs', 'check.mjs'));
    // The checker loads its budget manifest from next to itself.
    cpSync(
      join(repoRoot, 'scripts', 'docs', 'doc-budgets.json'),
      join(dir, 'scripts', 'docs', 'doc-budgets.json'),
    );
    mutate?.(dir);
    const result = spawnSync(process.execPath, [join(dir, 'scripts', 'docs', 'check.mjs')], {
      cwd: dir,
      encoding: 'utf8',
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function append(dir: string, relativePath: string, text: string): void {
  appendFileSync(join(dir, relativePath), text);
}

/** Replace one literal occurrence; fails loudly when the target moved. */
function replaceOnce(dir: string, relativePath: string, from: string, to: string): void {
  const file = join(dir, relativePath);
  const text = readFileSync(file, 'utf8');
  if (!text.includes(from)) throw new Error(`fixture patch target missing in ${relativePath}: ${from}`);
  writeFileSync(file, text.replace(from, to));
}

/**
 * Rewrite the `updated:` value regardless of the date the real document
 * carries, so the fixture does not drift every time a doc is touched.
 */
function setUpdated(dir: string, relativePath: string, value: string): void {
  const file = join(dir, relativePath);
  const text = readFileSync(file, 'utf8');
  writeFileSync(file, text.replace(/^updated: .*$/m, `updated: ${value}`));
}

/** Duplicate a frontmatter key; the checker must reject the repeated key. */
function duplicateFrontmatterKey(dir: string, relativePath: string): void {
  const file = join(dir, relativePath);
  const text = readFileSync(file, 'utf8');
  writeFileSync(file, text.replace(/^updated: (.*)$/m, 'updated: $1\nstatus: draft'));
}

function addExtraDocuments(dir: string): void {
  const extras = [
    ['specs', 'spec', 6],
    ['designs', 'design', 6],
  ] as const;
  for (const [category, type, count] of extras) {
    const links: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const name = `extra-${index}.md`;
      writeFileSync(
        join(dir, 'docs', category, name),
        `---\ntype: ${type}\nstatus: active\nupdated: 2026-11-09\n---\n\n# Extra\n\ntext\n`,
      );
      links.push(`| [${name}](${name}) | x | active |`);
    }
    append(dir, `docs/${category}/README.md`, `\n${links.join('\n')}\n`);
  }
}

describe('docs-check governance rules', () => {
  it('passes on the real knowledge base', () => {
    const result = withFixture();
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('knowledge documents');
  });

  it('allows code fences with # comments and ./ index links', () => {
    const result = withFixture((dir) => {
      append(dir, 'docs/specs/system-architecture.md', '\n```sh\n# shell comment\n```\n');
      replaceOnce(dir, 'docs/specs/README.md', '(document-model-v0.md)', '(./document-model-v0.md)');
      append(dir, 'AGENTS.md', '\n10. item\n    继续文本\n');
    });
    expect(result.status, result.output).toBe(0);
  });

  it('allows project agent skill markdown outside the knowledge base', () => {
    const result = withFixture((dir) => {
      mkdirSync(join(dir, '.agents', 'skills', 'demo'), { recursive: true });
      writeFileSync(
        join(dir, '.agents', 'skills', 'demo', 'SKILL.md'),
        '---\nname: demo\ndescription: demo skill\n---\n\n# Demo\n',
      );
    });
    expect(result.status, result.output).toBe(0);
  });

  it.each([
    ['source fence with odd info string', '``` ts\nconst x = 1;\n```\n'],
    ['source fence with attributes', '```ts title=demo\nconst x = 1;\n```\n'],
    ['indented code block', '\n    const x = 1;\n'],
    ['changelog heading', '## 版本历史\n- 2026-01-01: x\n'],
  ])('rejects a key document %s', (_label, snippet) => {
    const result = withFixture((dir) => append(dir, 'AGENTS.md', `\n${snippet}\n`));
    expect(result.status, result.output).toBe(1);
  });

  it.each([
    ['link with a title', '[x](missing.md "title")'],
    ['reference-style link', '[x][ref]\n\n[ref]: missing.md'],
    ['link that escapes the repository', '[x](../../../../etc/hosts)'],
    ['broken anchor', '[x](docs/specs/system-architecture.md#no-such-heading)'],
  ])('rejects a %s', (_label, snippet) => {
    const result = withFixture((dir) => append(dir, 'README.md', `\n${snippet}\n`));
    expect(result.status, result.output).toBe(1);
  });

  it('rejects frontmatter, naming and scope violations', () => {
    expect(
      withFixture((dir) =>
        setUpdated(dir, 'docs/specs/document-model-v0.md', '2026-02-30'),
      ).status,
    ).toBe(1);
    expect(
      withFixture((dir) =>
        replaceOnce(dir, 'docs/specs/document-model-v0.md', 'type: spec', 'type: design'),
      ).status,
    ).toBe(1);
    expect(
      withFixture((dir) =>
        duplicateFrontmatterKey(dir, 'docs/specs/document-model-v0.md'),
      ).status,
    ).toBe(1);
    expect(
      withFixture((dir) => {
        cpSync(
          join(dir, 'docs/specs/document-model-v0.md'),
          join(dir, 'docs/specs/Document_Notes.md'),
        );
        append(dir, 'docs/specs/README.md', '\n| [Document_Notes.md](Document_Notes.md) | x | active |\n');
      }).status,
    ).toBe(1);
    expect(withFixture((dir) => writeFileSync(join(dir, 'NOTES.MD'), '# stray\n')).status).toBe(1);
    expect(
      withFixture((dir) => {
        mkdirSync(join(dir, 'host'));
        writeFileSync(join(dir, 'host', 'NOTES.md'), '# stray\n');
      }).status,
    ).toBe(1);
  });

  it('rejects unclosed fences and budget overflows', () => {
    expect(
      withFixture((dir) => append(dir, 'docs/specs/system-architecture.md', '\n```sh\nunclosed\n')).status,
    ).toBe(1);
    expect(
      withFixture((dir) =>
        append(dir, 'docs/specs/system-architecture.md', `\n${'line\n'.repeat(400)}`),
      ).status,
    ).toBe(1);
    expect(withFixture(addExtraDocuments).status).toBe(1);
    expect(
      withFixture((dir) => {
        for (let index = 0; index < 6; index += 1) {
          const name = `overflow-${index}.md`;
          writeFileSync(
            join(dir, 'docs/specs', name),
            '---\ntype: spec\nstatus: active\nupdated: 2026-11-09\n---\n\n# Overflow\n',
          );
          append(dir, 'docs/specs/README.md', `\n| [${name}](${name}) | x | active |\n`);
        }
      }).status,
    ).toBe(1);
  });

  it('rejects malformed link fragments instead of crashing', () => {
    const result = withFixture((dir) =>
      append(dir, 'README.md', '\n[x](docs/specs/system-architecture.md#100%)\n'),
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('malformed link fragment');
  });
});

/**
 * One archived research doc in docs/archive/ plus its seal. The archive keeps no
 * index; `archived:` and the manifest entry are what make the copy frozen.
 */
function addArchivedDocument(
  dir: string,
  name: string,
  opts?: { status?: string; seal?: string | null },
): void {
  const status = opts?.status ?? 'archived';
  const text = `---\ntype: research\nstatus: ${status}\narchived: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Retired\n\ntext\n`;
  mkdirSync(join(dir, 'docs/archive'), { recursive: true });
  writeFileSync(join(dir, 'docs/archive', name), text);
  if (opts?.seal === null) return;
  const sha =
    opts?.seal ?? createHash('sha256').update(text, 'utf8').digest('hex');
  const manifestPath = join(dir, 'docs/archive/manifest.json');
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : { version: 1, archived: {} };
  manifest.archived[name] = { sha256: sha, archivedAt: '2026-01-01' };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

describe('docs-check lifecycle rules', () => {
  it('rejects status: archived outside docs/archive/', () => {
    const result = withFixture((dir) =>
      replaceOnce(dir, 'docs/research/dsh-agent-creation.md', 'status: active', 'status: archived'),
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('archived documents live in docs/archive/');
  });

  it('accepts a properly archived document without any index', () => {
    const result = withFixture((dir) => addArchivedDocument(dir, 'retired-study.md'));
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('archived documents: 1/60');
  });

  it('rejects archived documents that keep an active status', () => {
    const result = withFixture((dir) =>
      addArchivedDocument(dir, 'retired-study.md', { status: 'active' }),
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('must carry status: archived');
  });

  it('rejects any index file in the archive', () => {
    const result = withFixture((dir) => {
      mkdirSync(join(dir, 'docs/archive'), { recursive: true });
      writeFileSync(join(dir, 'docs/archive/README.md'), '# Archive index\n');
    });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('the archive keeps no index files');
  });

  it('rejects active documents linking archived content', () => {
    const result = withFixture((dir) => {
      addArchivedDocument(dir, 'retired-study.md');
      append(dir, 'README.md', '\n[x](docs/archive/retired-study.md)\n');
    });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('must not link archived content');
  });

  it('rejects an archived document edited after it was sealed', () => {
    const result = withFixture((dir) => {
      addArchivedDocument(dir, 'retired-study.md');
      append(dir, 'docs/archive/retired-study.md', '\n加一句不该有的补充。\n');
    });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('archived content changed since it was sealed');
  });

  it('rejects an archived document with no seal', () => {
    const result = withFixture((dir) =>
      addArchivedDocument(dir, 'retired-study.md', { seal: null }),
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('not sealed in docs/archive/manifest.json');
  });

  it('rejects an archived document missing its archived date', () => {
    const result = withFixture((dir) => {
      addArchivedDocument(dir, 'retired-study.md');
      replaceOnce(dir, 'docs/archive/retired-study.md', 'archived: 2026-01-01\n', '');
    });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('need an "archived: YYYY-MM-DD" frontmatter line');
  });

  it('rejects a stale seal for a document that is gone', () => {
    const result = withFixture((dir) => {
      addArchivedDocument(dir, 'retired-study.md');
      writeFileSync(
        join(dir, 'docs/archive/manifest.json'),
        `${JSON.stringify(
          {
            version: 1,
            archived: {
              'retired-study.md': { sha256: 'c'.repeat(64), archivedAt: '2026-01-01' },
              'ghost.md': { sha256: 'd'.repeat(64), archivedAt: '2026-01-01' },
            },
          },
          null,
          2,
        )}\n`,
      );
    });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('seals ghost.md but no such archived document exists');
  });

  it('reports aged research as due for archiving', () => {
    const result = withFixture((dir) =>
      setUpdated(dir, 'docs/research/dsh-agent-creation.md', '2026-01-01'),
    );
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('retirement due (run pnpm docs:archive)');
    expect(result.output).toContain('archive docs/research/dsh-agent-creation.md');
  });

  it('reports settled aged acceptance as due for deletion, not archiving', () => {
    const result = withFixture((dir) => {
      writeFileSync(
        join(dir, 'docs/acceptance/settled-record.md'),
        '---\ntype: acceptance\nstatus: active\nupdated: 2026-01-01\n---\n\n# Settled\n\n- [x] done\n',
      );
      append(dir, 'docs/acceptance/README.md', '\n| [settled-record.md](settled-record.md) | x | 已验收 |\n');
      writeFileSync(
        join(dir, 'docs/acceptance/open-record.md'),
        '---\ntype: acceptance\nstatus: active\nupdated: 2026-01-01\n---\n\n# Open\n\n- [~] pending\n',
      );
      append(dir, 'docs/acceptance/README.md', '\n| [open-record.md](open-record.md) | x | 进行中 |\n');
    });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('delete docs/acceptance/settled-record.md');
    expect(result.output).not.toContain('archive docs/acceptance/settled-record.md');
    expect(result.output).not.toContain('open-record.md (acceptance settled');
  });

  it('never retires specs or designs by age', () => {
    const result = withFixture((dir) => {
      setUpdated(dir, 'docs/specs/document-model-v0.md', '2026-01-01');
      setUpdated(dir, 'docs/designs/agent-doc-tools.md', '2026-01-01');
    });
    expect(result.status, result.output).toBe(0);
    expect(result.output).not.toContain('retirement due (run pnpm docs:archive)');
    expect(result.output).toContain('review for staleness');
  });

  it('tells a stale draft spec to reject or promote, never archive', () => {
    const result = withFixture((dir) => {
      replaceOnce(dir, 'docs/specs/document-model-v0.md', 'status: active', 'status: draft');
      setUpdated(dir, 'docs/specs/document-model-v0.md', '2026-01-01');
    });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('reject or promote, never archive');
    expect(result.output).not.toContain('archive docs/specs/document-model-v0.md');
  });

  it('rejects an overfull archive', () => {
    const result = withFixture((dir) => {
      for (let index = 0; index < 61; index += 1) {
        addArchivedDocument(dir, `retired-${index}.md`);
      }
    });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('exceed the 60-document budget');
  });
});
