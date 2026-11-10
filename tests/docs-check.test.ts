import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
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
 * Self-test for the documentation governance checker (scripts/docs-check.mjs).
 *
 * Each case copies the real knowledge base into a temporary directory, injects
 * one violation (or one legitimate pattern), runs the checker there, and asserts
 * the expected exit code. This keeps the mechanical rules in docs/README.md from
 * silently regressing when the checker changes.
 */
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const checker = join(repoRoot, 'scripts', 'docs-check.mjs');

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
    mkdirSync(join(dir, 'scripts'));
    cpSync(checker, join(dir, 'scripts', 'docs-check.mjs'));
    mutate?.(dir);
    const result = spawnSync(process.execPath, [join(dir, 'scripts', 'docs-check.mjs')], {
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

function replace(dir: string, relativePath: string, from: string, to: string): void {
  const file = join(dir, relativePath);
  const text = readFileSync(file, 'utf8');
  if (!text.includes(from)) throw new Error(`fixture patch target missing in ${relativePath}: ${from}`);
  writeFileSync(file, text.replace(from, to));
}

function addExtraDocuments(dir: string): void {
  const extras = [
    ['specs', 'spec', 3],
    ['designs', 'design', 4],
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
      replace(dir, 'docs/specs/README.md', '(document-model-v0.md)', '(./document-model-v0.md)');
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
        replace(dir, 'docs/specs/document-model-v0.md', 'updated: 2026-11-10', 'updated: 2026-02-30'),
      ).status,
    ).toBe(1);
    expect(
      withFixture((dir) =>
        replace(dir, 'docs/specs/document-model-v0.md', 'type: spec', 'type: design'),
      ).status,
    ).toBe(1);
    expect(
      withFixture((dir) =>
        replace(dir, 'docs/specs/document-model-v0.md', 'updated: 2026-11-10', 'updated: 2026-11-10\nstatus: draft'),
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
        for (let index = 0; index < 4; index += 1) {
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
