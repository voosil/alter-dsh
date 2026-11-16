/**
 * Unit half of code-block syntax highlighting: language resolution, detection
 * and the token ranges themselves — no DOM, no editor.
 *
 * The token ranges are a *view* contract: they must be in-bounds, ordered and
 * non-overlapping, because ProseMirror rejects overlapping inline decorations.
 */
import { describe, expect, it } from 'vitest';
import {
  CODE_TOKEN_PREFIX,
  CODE_TOKEN_TYPES,
  MAX_HIGHLIGHT_LENGTH,
  detectLanguage,
  highlightCode,
  normalizeLanguage,
} from '../../../src/document/editors/tiptap/code-highlight';

describe('normalizeLanguage', () => {
  it('maps the spellings documents actually contain', () => {
    expect(normalizeLanguage('ts')).toBe('typescript');
    expect(normalizeLanguage('TS')).toBe('typescript');
    expect(normalizeLanguage('  js ')).toBe('javascript');
    expect(normalizeLanguage('yml')).toBe('yaml');
    expect(normalizeLanguage('sh')).toBe('bash');
    expect(normalizeLanguage('html')).toBe('xml');
    expect(normalizeLanguage('toml')).toBe('ini');
    expect(normalizeLanguage('c++')).toBe('cpp');
  });

  it('refuses languages this bundle does not carry', () => {
    expect(normalizeLanguage('mermaid')).toBeNull();
    expect(normalizeLanguage('scss')).toBeNull();
    expect(normalizeLanguage('')).toBeNull();
    expect(normalizeLanguage('   ')).toBeNull();
    expect(normalizeLanguage(null)).toBeNull();
    expect(normalizeLanguage(42)).toBeNull();
  });
});

describe('detectLanguage', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['json', '{"a": 1, "b": [2, 3]}'],
    ['javascript', 'function f() {\n  return 1;\n}'],
    ['javascript', 'const x = 1;\nexport default x;'],
    ['typescript', 'interface A { a: string }\nconst x: number = 1;'],
    ['python', 'def f(a):\n    return a + 1\n'],
    ['bash', '#!/bin/bash\nnpm install'],
    ['bash', 'echo hello\ncd /tmp'],
    ['xml', '<div class="a"><span>hi</span></div>'],
    ['css', '.a { color: red; margin: 0; }'],
    ['markdown', '# 标题\n\n- 一\n- 二\n'],
    ['yaml', 'name: space\nitems:\n  - a\n  - b\n'],
    ['sql', 'SELECT id FROM users WHERE id = 1'],
    ['go', 'package main\n\nfunc main() {\n  x := 1\n}'],
    ['rust', 'fn main() {\n  let mut x = 1;\n}'],
    ['java', 'public class A {\n  System.out.print(1);\n}'],
    ['diff', 'diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+b'],
    ['cpp', '#include <iostream>\nstd::cout << "x";'],
    ['c', '#include <stdio.h>\nint main() { return 0; }'],
    ['ini', '[section]\nkey = value'],
  ];

  for (const [expected, source] of cases) {
    it(`detects ${expected} from its shapes`, () => {
      expect(detectLanguage(source)).toBe(expected);
    });
  }

  it('stays quiet when nothing matches confidently', () => {
    expect(detectLanguage('这是一段中文说明文字，不是代码。')).toBeNull();
    expect(detectLanguage('安装 npm 依赖')).toBeNull();
    expect(detectLanguage('')).toBeNull();
    expect(detectLanguage('   \n  ')).toBeNull();
  });
});

describe('highlightCode', () => {
  const source = [
    'import { a } from "b";',
    'const n: number = 42; // 注释',
    'function f(s: string) { return `${s}`; }',
  ].join('\n');

  it('returns ordered, in-bounds, non-overlapping runs', () => {
    const runs = highlightCode(source, 'typescript');
    expect(runs.length).toBeGreaterThan(0);
    let previousEnd = 0;
    for (const run of runs) {
      expect(run.from).toBeGreaterThanOrEqual(previousEnd);
      expect(run.to).toBeGreaterThan(run.from);
      expect(run.to).toBeLessThanOrEqual(source.length);
      expect(CODE_TOKEN_TYPES).toContain(run.token);
      previousEnd = run.to;
    }
  });

  it('covers the source exactly (offsets match the block text)', () => {
    const runs = highlightCode(source, 'typescript');
    for (const run of runs) {
      expect(source.slice(run.from, run.to)).not.toBe('');
    }
    expect(source.slice(0, runs[0]!.from)).not.toContain('const');
  });

  it('emits the documented class names', () => {
    const runs = highlightCode('const a = 1; // hi', 'javascript');
    expect(CODE_TOKEN_PREFIX).toBe('alter-code-');
    expect(runs.map((run) => run.token)).toEqual(['keyword', 'number', 'comment']);
  });

  it('returns nothing for empty or oversized bodies', () => {
    expect(highlightCode('', 'javascript')).toEqual([]);
    expect(highlightCode('a'.repeat(MAX_HIGHLIGHT_LENGTH + 1), 'javascript')).toEqual([]);
  });

  it('does not paint embedded sublanguages with the outer colour', () => {
    // `<style>` bodies are wrapped in a bare `css` class; inheriting the tag
    // colour would paint the whole style block red.
    const html = '<div><style>.x { color: red; }</style></div>';
    const runs = highlightCode(html, 'xml');
    const tokenAt = (text: string): string | undefined =>
      runs.find((run) => html.slice(run.from, run.to) === text)?.token;
    expect(tokenAt('div')).toBe('tag');
    expect(tokenAt('.x')).not.toBe('tag');
    expect(tokenAt('.x')).toBeDefined();
  });

  it('survives a grammar with unterminated constructs while typing', () => {
    expect(() => highlightCode('const s = "unterminated', 'javascript')).not.toThrow();
    expect(() => highlightCode('/* 半截注释', 'typescript')).not.toThrow();
  });
});
