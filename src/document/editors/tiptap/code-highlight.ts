/**
 * Syntax highlighting for `codeBlock` bodies — decoration only, never content.
 *
 * The document owns exactly one thing about a code block's language: the `lang`
 * attribute of the AST block (Markdown fences and Agent writes carry it). The
 * highlighting itself is an editing-surface decoration: no mark, no node, no
 * attribute is written back, so opening a document never rewrites it and the
 * Host never sees markup.
 *
 * Two inputs decide the grammar, in order:
 *
 * 1. the block's `lang` attribute, normalized through {@link normalizeLanguage}
 *    (so `ts`, `js`, `yml`, `sh` … are all understood);
 * 2. {@link detectLanguage}, because the editor has no language picker: a block
 *    typed with ``` has no `lang` at all and would otherwise never highlight.
 *    Detection is deliberately conservative — a wrong grammar paints wrong
 *    colours, while plain text is merely unhighlighted.
 *
 * When neither yields a registered grammar the block stays plain text.
 *
 * Cost: a block is tokenized once per distinct `language + text` pair and that
 * result is cached, so a keystroke re-tokenizes only the block being edited.
 * Oversized blocks are skipped on purpose (see {@link MAX_HIGHLIGHT_LENGTH}).
 *
 * @module @alter-dsh/space/document/editors/tiptap/code-highlight
 */
import { Extension } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { createLowlight } from 'lowlight';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/**
 * Grammars that ship inside the client bundle.
 *
 * Every entry is a static import so the library build keeps exactly this set:
 * the handful of languages documents actually contain, not `highlight.js`'s
 * full registry (`common` alone is several times larger).
 */
const GRAMMARS = {
  bash,
  c,
  cpp,
  css,
  diff,
  go,
  ini,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  shell,
  sql,
  typescript,
  xml,
  yaml,
} as const;

/** Registered grammar name (a key of {@link GRAMMARS}). */
export type CodeLanguage = keyof typeof GRAMMARS;

/**
 * Token class prefix handed to the highlighter.
 *
 * The rendered classes are `alter-code-<token>`; `Editor.module.css` paints
 * them under `.surface` (`:global(...)`, because the names are generated in TS,
 * not by CSS Modules) from `--alter-code-*` colour tokens.
 */
export const CODE_TOKEN_PREFIX = 'alter-code-';

/**
 * Token classes the stylesheet paints.
 *
 * The highlighter emits per-grammar scope names (`selector-class`,
 * `title.function`, `built_in`, …); {@link CODE_SCOPE_MAP} folds them into this
 * short set so the palette stays nine colours instead of forty.
 */
export const CODE_TOKEN_TYPES = [
  'comment',
  'keyword',
  'string',
  'number',
  'title',
  'type',
  'variable',
  'tag',
  'meta',
  'regexp',
  'addition',
  'deletion',
] as const;

/** Token class suffix. */
export type CodeTokenType = (typeof CODE_TOKEN_TYPES)[number];

/**
 * Highlighter scope → token class.
 *
 * Scopes that are not listed inherit their parent's token (or stay plain), so
 * an unknown grammar scope degrades to the surrounding colour instead of a
 * missing class. `operator` and `punctuation` are deliberately absent: brackets
 * and operators keep the body ink, which is what GitHub's light theme does and
 * what keeps dense code from turning into confetti.
 */
const CODE_SCOPE_MAP: Readonly<Record<string, CodeTokenType>> = {
  comment: 'comment',
  quote: 'comment',
  doctag: 'comment',
  keyword: 'keyword',
  'meta-keyword': 'keyword',
  'template-tag': 'keyword',
  'selector-tag': 'tag',
  tag: 'tag',
  name: 'tag',
  string: 'string',
  'attr-value': 'string',
  'meta-string': 'string',
  'char-escape': 'string',
  number: 'number',
  literal: 'number',
  symbol: 'number',
  'variable-constant': 'number',
  formula: 'number',
  title: 'title',
  section: 'title',
  function: 'title',
  class: 'title',
  type: 'type',
  'built-in': 'type',
  variable: 'variable',
  'template-variable': 'variable',
  subst: 'variable',
  params: 'variable',
  property: 'variable',
  attr: 'variable',
  attribute: 'variable',
  'attr-name': 'variable',
  'selector-class': 'variable',
  'selector-id': 'variable',
  'selector-attr': 'variable',
  'selector-pseudo': 'variable',
  meta: 'meta',
  regexp: 'regexp',
  addition: 'addition',
  deletion: 'deletion',
};

/** One highlighted run inside a code block's text (offsets are block-local). */
export interface CodeToken {
  from: number;
  to: number;
  /** Class suffix, one of {@link CODE_TOKEN_TYPES}. */
  token: CodeTokenType;
}

/**
 * `lang` attribute spellings that mean one of {@link GRAMMARS}.
 *
 * Markdown fences and pasted code carry whatever the author typed; mapping the
 * spellings people actually write is cheaper than asking them to relearn.
 */
const LANGUAGE_ALIASES: Readonly<Record<string, CodeLanguage>> = {
  js: 'javascript',
  javascript: 'javascript',
  node: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  typescript: 'typescript',
  tsx: 'typescript',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  shellscript: 'bash',
  console: 'shell',
  shell: 'shell',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  markdown: 'markdown',
  md: 'markdown',
  mdx: 'markdown',
  py: 'python',
  python: 'python',
  python3: 'python',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  rs: 'rust',
  rust: 'rust',
  go: 'go',
  golang: 'go',
  sql: 'sql',
  mysql: 'sql',
  pgsql: 'sql',
  postgres: 'sql',
  postgresql: 'sql',
  sqlite: 'sql',
  css: 'css',
  diff: 'diff',
  patch: 'diff',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  env: 'ini',
  properties: 'ini',
};

/**
 * Above this many characters a block is left plain.
 *
 * Tokenizing costs grow with block size and the result becomes thousands of
 * DOM spans; a document that large is not edited by eye anyway, and the plain
 * block is still correct content.
 */
export const MAX_HIGHLIGHT_LENGTH = 20_000;

/** How much of a block {@link detectLanguage} looks at. */
const DETECT_SAMPLE = 4_000;

/** Cached `(language, text)` results; bounded so a session cannot grow. */
const CACHE_LIMIT = 64;

const cache = new Map<string, readonly CodeToken[]>();

/**
 * Map a document `lang` value onto a bundled grammar.
 *
 * @param lang the block's `lang` attribute (AST `string`, at most 32 chars).
 * @returns the grammar name, or `null` when the document names a language this
 *   bundle does not carry (`text`, `mermaid`, `scss`, …).
 */
export function normalizeLanguage(lang: unknown): CodeLanguage | null {
  if (typeof lang !== 'string') return null;
  const key = lang.trim().toLowerCase();
  if (key === '') return null;
  return LANGUAGE_ALIASES[key] ?? null;
}

/** True when `text` looks like Markdown headings, list items or fences. */
function looksLikeMarkdown(sample: string): boolean {
  const lines = sample.split('\n');
  let signals = 0;
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) signals += 1;
    else if (/^\s*([-*+]|\d+\.)\s+\S/.test(line)) signals += 1;
    else if (line.startsWith('```')) signals += 1;
    else if (/^>\s/.test(line)) signals += 0.5;
    if (signals >= 2) return true;
  }
  return false;
}

/** True when `text` looks like a YAML document. */
function looksLikeYaml(sample: string): boolean {
  const lines = sample.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) return false;
  let mapping = 0;
  let items = 0;
  for (const line of lines) {
    if (/^\s{0,3}(#.*|---\s*|\.\.\.\s*)$/.test(line)) continue;
    if (/^\s*-\s+\S/.test(line) || /^\s*-$/.test(line)) items += 1;
    else if (/^\s{0,3}[\w.$-]+:(\s|$)/.test(line)) mapping += 1;
    else if (/^\s{2,}[\w.$-]+:(\s|$)/.test(line)) mapping += 1;
    else return false;
  }
  return mapping + items >= 2 && mapping >= 1;
}

/** True when `text` looks like a CSS rule set. */
function looksLikeCss(sample: string): boolean {
  if (!/[.#\w][^{]{0,80}\{[^}]*\}/.test(sample)) return false;
  if (/\b(?:const|let|function|=>|import\s|export\s|def\s|class\s+\w+\s*:)\b/.test(sample)) {
    return false;
  }
  return /[a-z-]+\s*:\s*[^;{\n]+;/.test(sample);
}

/** True when `text` looks like SQL. */
function looksLikeSql(sample: string): boolean {
  return /\b(?:select\s+[\s\S]{0,200}?\bfrom\b|insert\s+into\b|update\s+\w+\s+set\b|delete\s+from\b|create\s+(?:table|index|view)\b|alter\s+table\b|with\s+\w+\s+as\s*\()/i.test(
    sample,
  );
}

/**
 * Unambiguous command words: a line starting with one of these is a shell
 * command, not prose.
 *
 * Words that double as English (`open`, `time`, `set`, `code`) are deliberately
 * absent — a code block holding a sentence would otherwise read as a terminal.
 */
const SHELL_COMMAND =
  /^(?:sudo|cd|ls|pwd|echo|cat|mkdir|rmdir|rm|cp|mv|touch|ln|git|npm|pnpm|yarn|bun|npx|node|deno|python3?|pip3?|poetry|uv|curl|wget|docker|docker-compose|kubectl|helm|make|cmake|chmod|chown|export|source|brew|apt|apt-get|yum|dnf|systemctl|service|ssh|scp|rsync|tar|unzip|zip|grep|rg|sed|awk|find|jq|ps|kill|tail|head|gcc|g\+\+|clang|go|rustc|cargo|java|javac|mvn|gradle|dotnet|php|composer|bundle|gem|terraform|ansible|conda|nvm|which|alias)\b/;

/**
 * True when every non-empty line reads as a shell command line.
 *
 * Requires the whole block: one command word in a paragraph is not enough.
 */
function looksLikeShell(sample: string): boolean {
  const lines = sample
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) return false;
  let commands = 0;
  let sawCommand = false;
  for (const line of lines) {
    if (line.startsWith('#')) continue;
    const bare = line.replace(/^(?:\$|>|❯)\s+/, '');
    if (/^(?:then|do|done|fi|else|elif|esac)\b/.test(bare)) {
      sawCommand = true;
      continue;
    }
    const continuation =
      /^[A-Z_][A-Z0-9_]*=/.test(bare) ||
      (sawCommand && /^--?[\w-]+/.test(bare)) ||
      bare.includes('|');
    if (SHELL_COMMAND.test(bare) || continuation) {
      commands += 1;
      sawCommand = true;
      continue;
    }
    return false;
  }
  return commands > 0;
}

/**
 * Guess the language of a block that carries no usable `lang`.
 *
 * Ordered from the strongest, least ambiguous signals to the loosest: an
 * explicit shebang or a JSON-parseable body wins outright, then markup and
 * language-specific keywords, then the "whole block has this shape" tests
 * (shell/YAML/Markdown/CSS).
 *
 * Detection is conservative on purpose: a wrong grammar paints wrong colours
 * while plain text is merely unhighlighted, so no rule reports a language on a
 * weak signal.
 *
 * @param text the block body.
 * @returns a grammar name, or `null` when nothing matches confidently.
 */
export function detectLanguage(text: string): CodeLanguage | null {
  const sample = text.slice(0, DETECT_SAMPLE);
  const trimmed = sample.trim();
  if (trimmed === '') return null;

  if (/^(?:diff --git\b|@@\s|\+\+\+\s|---\s)/m.test(trimmed)) return 'diff';

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(text.trim());
      return 'json';
    } catch {
      // Not JSON; the shape tests below decide.
    }
  }

  if (/^#!\s*\S*\b(?:ba|z|k|da)?sh\b/.test(trimmed)) return 'bash';
  if (/^#!\s*\S*\b(?:python[23]?)\b/.test(trimmed)) return 'python';
  if (/^#!\s*\S*\bnode\b/.test(trimmed)) return 'javascript';

  const markup =
    /^(?:<!doctype\s+html|<html\b|<\?xml\b)/i.test(trimmed) ||
    (/<\/[a-z][\w:-]*>\s*$/i.test(trimmed) &&
      /<[a-z][\w:-]*(?:\s[^>]*)?>/i.test(trimmed));
  if (markup) return 'xml';

  if (/^\s*#include\s*[<"]/.test(trimmed)) {
    return /\b(?:std::|#include\s*<iostream>|#include\s*<vector>|template\s*<|class\s+\w+\s*\{)/.test(
      trimmed,
    )
      ? 'cpp'
      : 'c';
  }

  if (/\b(?:public\s+(?:final\s+)?class\s+\w+|import\s+java\.|System\.out\.print)/.test(trimmed)) {
    return 'java';
  }

  if (
    /^\s*(?:package\s+\w+|func\s+(?:\(\w+\s+\*?\w+\)\s*)?\w+\s*\()/m.test(trimmed) &&
    /:=|\bfunc\s+\w+\(|\bpackage\s+main\b/.test(trimmed)
  ) {
    return 'go';
  }

  if (
    /\bfn\s+\w+\s*[(<]/.test(trimmed) &&
    /\blet\s+(?:mut\s+)?\w+|\bimpl\s+\w+|\buse\s+\w+::|->/.test(trimmed)
  ) {
    return 'rust';
  }

  const pythonShape =
    /^\s*(?:def\s+\w+\s*\(|class\s+\w+(?:\([^)]*\))?\s*:|from\s+[\w.]+\s+import\s+\w|import\s+[\w.]+(?:\s+as\s+\w+)?\s*$|print\s*\()/m.test(
      trimmed,
    );
  const pythonSignal =
    /:\s*(?:#.*)?$|\bprint\(|\bself\b|\bNone\b|\bTrue\b|\bFalse\b|\belif\b|\b__\w+__\b/m.test(
      trimmed,
    );
  if (pythonShape && pythonSignal) return 'python';

  const jsShape =
    /(?:\bfunction\s*\w*\s*\(|\bconst\s+\w+\s*[:=]|\blet\s+\w+\s*[:=]|\bvar\s+\w+\s*=\s*|=>|\bexport\s+(?:default|const|function|class)\b|\bimport\s+[\w{}*\s,]+from\s+['"]|\brequire\(|\bconsole\.\w+\()/;
  const tsShape =
    /(?:^\s*(?:interface|type|enum|namespace|declare)\s+\w+|:\s*(?:string|number|boolean|void|any|unknown|never|readonly|Record<|Promise<)|\bas\s+const\b|\bimplements\s+\w+|\breadonly\s+\w+|<[A-Z]\w*(?:,\s*\w+)*>)/m;
  if (jsShape.test(trimmed)) return tsShape.test(trimmed) ? 'typescript' : 'javascript';

  if (looksLikeShell(trimmed)) return 'bash';

  if (looksLikeSql(trimmed)) return 'sql';

  if (looksLikeYaml(trimmed)) return 'yaml';

  if (looksLikeMarkdown(trimmed)) return 'markdown';

  if (looksLikeCss(trimmed)) return 'css';

  if (/^\s*\[[\w ."-]+\]\s*$/m.test(trimmed) && /^\s*[\w.-]+\s*=/m.test(trimmed)) {
    return 'ini';
  }

  return null;
}

/** The lowlight instance: registered once for the whole client bundle. */
const lowlight = createLowlight(GRAMMARS);

/** Minimal shape of the highlighter's tree; `hast` types are not re-exported. */
interface HastText {
  type: 'text';
  value: string;
}
interface HastElement {
  type: 'element';
  properties?: { className?: unknown };
  children?: readonly (HastText | HastElement)[];
}
type HastNode = HastText | HastElement;

/**
 * Whether an element carries any class at all.
 *
 * The highlighter wraps embedded sublanguages (CSS inside `<style>`, JS inside
 * `<script>`) in a **bare** language class (`css`, `javascript`) and prefixes
 * only the scopes inside. Such a wrapper starts a new colour scope: inheriting
 * the outer language's colour would paint e.g. `<style>` bodies as tag colour.
 */
function hasClass(node: HastElement): boolean {
  const raw = node.properties?.className;
  return Array.isArray(raw) ? raw.length > 0 : typeof raw === 'string';
}

/** Read the first `alter-code-*` class of an element as a known token. */
function tokenOf(node: HastElement): CodeTokenType | null {
  const raw = node.properties?.className;
  const names = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  for (const name of names) {
    if (typeof name !== 'string' || !name.startsWith(CODE_TOKEN_PREFIX)) continue;
    const scope = name.slice(CODE_TOKEN_PREFIX.length).replace(/_/g, '-');
    return CODE_SCOPE_MAP[scope] ?? null;
  }
  return null;
}

/**
 * Walk the highlighted tree and emit one run per highlighted text node.
 *
 * Ranges are emitted at text leaves only, carrying the **innermost** token
 * class: nested runs (`string` containing `subst`) then cannot overlap, which
 * is what ProseMirror's inline decorations require, and a parent element that
 * has no text of its own contributes nothing.
 *
 * @param nodes tree nodes to walk.
 * @param offset offset of the first node inside the block's text.
 * @param inherited token class of the enclosing element (or `null`).
 * @param out collected runs.
 * @returns the offset just past the last node.
 */
function collect(
  nodes: readonly HastNode[],
  offset: number,
  inherited: CodeTokenType | null,
  out: CodeToken[],
): number {
  let cursor = offset;
  for (const node of nodes) {
    if (node.type === 'text') {
      const length = node.value.length;
      if (inherited !== null && length > 0) {
        out.push({ from: cursor, to: cursor + length, token: inherited });
      }
      cursor += length;
      continue;
    }
    const token = tokenOf(node);
    const next = token ?? (hasClass(node) ? null : inherited);
    cursor = collect(node.children ?? [], cursor, next, out);
  }
  return cursor;
}

/**
 * Tokenize one code body.
 *
 * @param text block body (block-local offsets are returned).
 * @param language grammar to use; must be registered.
 * @returns runs in document order; empty when nothing is highlighted.
 */
export function highlightCode(text: string, language: CodeLanguage): CodeToken[] {
  if (text === '' || text.length > MAX_HIGHLIGHT_LENGTH) return [];
  const key = `${language}\u0000${text}`;
  const cached = cache.get(key);
  if (cached !== undefined) return [...cached];

  const tokens: CodeToken[] = [];
  try {
    const tree = lowlight.highlight(language, text, { prefix: CODE_TOKEN_PREFIX });
    collect(tree.children as readonly HastNode[], 0, null, tokens);
  } catch {
    // A grammar bug must never break editing: degrade to plain text.
    return [];
  }

  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, tokens);
  return [...tokens];
}

/**
 * Language of one block: its own `lang` first, then detection.
 *
 * A declared-but-unsupported language (`text`, `mermaid`, …) means the author
 * said what this block is; guessing over it would paint prose as code.
 */
function languageOf(node: PmNode): CodeLanguage | null {
  const raw = node.attrs['lang'];
  if (typeof raw === 'string' && raw.trim() !== '') return normalizeLanguage(raw);
  return detectLanguage(node.textContent);
}

/** Build the decoration set for every code block in `doc`. */
function buildDecorations(doc: PmNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'codeBlock') return undefined;
    const text = node.textContent;
    const language = languageOf(node);
    if (language === null) return undefined;
    const start = pos + 1;
    for (const token of highlightCode(text, language)) {
      decorations.push(
        Decoration.inline(start + token.from, start + token.to, {
          class: `${CODE_TOKEN_PREFIX}${token.token}`,
        }),
      );
    }
    return undefined;
  });
  return DecorationSet.create(doc, decorations);
}

const highlightKey = new PluginKey<DecorationSet>('alterCodeHighlight');

/** Plugin options. */
export interface CodeHighlightPluginOptions {
  /**
   * Whether the editor view is inside an IME composition.
   *
   * Composing replaces the text of the block being edited without a settled
   * document; swapping its decoration spans at that moment can drop candidate
   * text, so composition only remaps the existing set.
   */
  isComposing?: () => boolean;
}

/**
 * Decoration plugin for code blocks.
 *
 * Rebuilt only on document changes; a plain selection change reuses the set.
 * Rebuilding is cheap because {@link highlightCode} is cached per block body.
 */
export function createCodeHighlightPlugin(
  options: CodeHighlightPluginOptions = {},
): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: highlightKey,
    state: {
      init: (_config, state) => buildDecorations(state.doc),
      apply: (transaction, previous) => {
        if (!transaction.docChanged) return previous;
        if (options.isComposing?.() === true) {
          return previous.map(transaction.mapping, transaction.doc);
        }
        return buildDecorations(transaction.doc);
      },
    },
    props: {
      decorations(state) {
        return highlightKey.getState(state) ?? null;
      },
    },
  });
}

/** Kernel extension that paints code-block syntax highlighting. */
export function createCodeHighlight(): Extension {
  return Extension.create({
    name: 'codeHighlight',
    addProseMirrorPlugins() {
      const editor = this.editor;
      return [
        createCodeHighlightPlugin({
          isComposing: () => editor.view?.composing === true,
        }),
      ];
    },
  });
}
