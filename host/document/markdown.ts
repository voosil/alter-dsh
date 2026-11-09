/**
 * Markdown → block tree parser (new content only).
 *
 * The parser accepts exactly the subset the projection emits (see
 * `docs/specs/document-model-v0.md` "Markdown 投影规范") plus the directive
 * forms for callout / mindmap / component. Anything else — unknown
 * directives, inline HTML, non `space-asset://` images — fails with a
 * `DocumentError` carrying the source line number, because silently changing
 * content is worse than asking the caller for structured operations.
 *
 * @module @alter-dsh/space/document/markdown
 */
import { NODE_TYPES, validateAlterDoc } from './schema.js';
import {
  ALTER_DOC_FORMAT,
  ALTER_DOC_SCHEMA_VERSION,
  DocumentError,
  type BlockNode,
  type DocumentErrorCode,
  type InlineNode,
  type JsonValue,
  type Mark,
  type MarkType,
} from './types.js';

/** Options for {@link parseMarkdownBlocks}. */
export interface MarkdownParseOptions {
  createBlockId: () => string;
  /** When provided, image assets must exist or parsing fails. */
  hasAsset?: (assetId: string) => boolean;
}

/** One source line with its original 1-based line number. */
interface SourceLine {
  text: string;
  no: number;
}

/** Canonical order of marks on one text run (matches the registry order). */
const MARK_TYPE_ORDER: readonly MarkType[] = [
  'bold',
  'italic',
  'underline',
  'strike',
  'code',
  'highlight',
  'link',
];

const SAFE_HREF = /^(https?:\/\/|mailto:|\/|#)/i;
const ASSET_REF = /^space-asset:\/\/(asset_[A-Za-z0-9._-]+)$/;
const ANCHOR_COMMENT = /^<!--\s*blk:[\w.-]+\s*-->$/;
const ESCAPABLE = /[!-/:-@[-`{-~]/;
const IMAGE_LINE =
  /^!\[((?:[^\\\]]|\\.)*)\]\(((?:[^\\()\s]|\\.)+?)(?:\s+"((?:[^\\"]|\\.)*)")?\)$/;

function fail(code: DocumentErrorCode, line: number, message: string): never {
  throw new DocumentError(code, `第 ${line} 行：${message}`);
}

/** Create one empty block node; empty payloads are omitted. */
function makeBlock(
  ctx: MarkdownParseOptions,
  type: string,
  attrs: Record<string, JsonValue> = {},
  extra: { content?: InlineNode[]; children?: BlockNode[] } = {},
): BlockNode {
  const block: BlockNode = { id: ctx.createBlockId(), type, attrs };
  if (extra.content !== undefined && extra.content.length > 0) block.content = extra.content;
  if (extra.children !== undefined && extra.children.length > 0) block.children = extra.children;
  return block;
}

function unescapePunctuation(text: string): string {
  return text.replaceAll(/\\([!-/:-@[-`{-~])/g, '$1');
}

/** Replace `\n` / `\t` / `\"` / `\\` escapes of a directive attribute value. */
function unescapeDirectiveChar(char: string): string {
  if (char === 'n') return '\n';
  if (char === 't') return '\t';
  if (char === 'r') return '\r';
  return char;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

function canonicalizeMarks(marks: readonly Mark[]): Mark[] {
  const byType = new Map<MarkType, Mark>();
  for (const mark of marks) {
    if (!byType.has(mark.type)) byType.set(mark.type, mark);
  }
  return [...byType.values()].sort(
    (left, right) => MARK_TYPE_ORDER.indexOf(left.type) - MARK_TYPE_ORDER.indexOf(right.type),
  );
}

function marksKey(marks: readonly Mark[] | undefined): string {
  if (marks === undefined || marks.length === 0) return '';
  return canonicalizeMarks(marks)
    .map((mark) => `${mark.type}:${mark.attrs?.href ?? ''}`)
    .join('|');
}

function addMarks(base: readonly Mark[], extra: readonly Mark[]): Mark[] {
  return canonicalizeMarks([...base, ...extra]);
}

function makeText(text: string, marks: readonly Mark[]): InlineNode {
  const canonical = canonicalizeMarks(marks);
  return canonical.length === 0 ? { type: 'text', text } : { type: 'text', text, marks: canonical };
}

/** Merge adjacent text runs with identical marks and drop empty runs. */
function normalizeInline(nodes: readonly InlineNode[]): InlineNode[] {
  const result: InlineNode[] = [];
  for (const node of nodes) {
    if (node.type === 'text') {
      if (node.text === '') continue;
      const last = result[result.length - 1];
      if (
        last !== undefined &&
        last.type === 'text' &&
        marksKey(last.marks) === marksKey(node.marks)
      ) {
        last.text += node.text;
        continue;
      }
      result.push(node);
      continue;
    }
    if (node.type === 'hardBreak') result.push(node);
  }
  return result;
}

function countRun(text: string, start: number, char: string): number {
  let end = start;
  while (end < text.length && text[end] === char) end += 1;
  return end - start;
}

/**
 * Find the end of a backtick run of exactly `size` backticks starting at or
 * after `from`; returns the run start or -1.
 */
function findBacktickRun(text: string, from: number, size: number): number {
  let index = from;
  while (index < text.length) {
    if (text[index] !== '`') {
      index += 1;
      continue;
    }
    const run = countRun(text, index, '`');
    if (run === size) return index;
    index += run;
  }
  return -1;
}

/** Parse inline Markdown into the v0 InlineNode subset. */
function parseInline(
  text: string,
  line: number,
  baseMarks: readonly Mark[] = [],
): InlineNode[] {
  const nodes: InlineNode[] = [];
  let buffer = '';
  const flush = (): void => {
    if (buffer !== '') {
      nodes.push(makeText(buffer, baseMarks));
      buffer = '';
    }
  };

  let i = 0;
  while (i < text.length) {
    const char = text[i]!;

    if (char === '\\') {
      const next = text[i + 1];
      if (next !== undefined && ESCAPABLE.test(next)) {
        buffer += next;
        i += 2;
        continue;
      }
      buffer += '\\';
      i += 1;
      continue;
    }

    if (char === '`') {
      const run = countRun(text, i, '`');
      const close = findBacktickRun(text, i + run, run);
      if (close < 0) {
        buffer += '`'.repeat(run);
        i += run;
        continue;
      }
      let code = text.slice(i + run, close);
      if (code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') {
        code = code.slice(1, -1);
      }
      flush();
      if (code !== '') nodes.push(makeText(code, addMarks(baseMarks, [{ type: 'code' }])));
      i = close + run;
      continue;
    }

    if (text.startsWith('***', i)) {
      const end = text.indexOf('***', i + 3);
      if (end >= 0) {
        const inner = parseInline(
          text.slice(i + 3, end),
          line,
          addMarks(baseMarks, [{ type: 'bold' }, { type: 'italic' }]),
        );
        if (inner.length > 0) {
          flush();
          nodes.push(...inner);
          i = end + 3;
          continue;
        }
      }
    }
    if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2);
      if (end >= 0) {
        const inner = parseInline(
          text.slice(i + 2, end),
          line,
          addMarks(baseMarks, [{ type: 'bold' }]),
        );
        if (inner.length > 0) {
          flush();
          nodes.push(...inner);
          i = end + 2;
          continue;
        }
      }
    }
    if (char === '*') {
      const end = text.indexOf('*', i + 1);
      if (end >= 0) {
        const inner = parseInline(
          text.slice(i + 1, end),
          line,
          addMarks(baseMarks, [{ type: 'italic' }]),
        );
        if (inner.length > 0) {
          flush();
          nodes.push(...inner);
          i = end + 1;
          continue;
        }
      }
    }
    if (text.startsWith('~~', i)) {
      const end = text.indexOf('~~', i + 2);
      if (end >= 0) {
        const inner = parseInline(
          text.slice(i + 2, end),
          line,
          addMarks(baseMarks, [{ type: 'strike' }]),
        );
        if (inner.length > 0) {
          flush();
          nodes.push(...inner);
          i = end + 2;
          continue;
        }
      }
    }
    if (text.startsWith('==', i)) {
      const end = text.indexOf('==', i + 2);
      if (end >= 0) {
        const inner = parseInline(
          text.slice(i + 2, end),
          line,
          addMarks(baseMarks, [{ type: 'highlight' }]),
        );
        if (inner.length > 0) {
          flush();
          nodes.push(...inner);
          i = end + 2;
          continue;
        }
      }
    }

    if (text.slice(i).toLowerCase().startsWith('<u>')) {
      const close = text.toLowerCase().indexOf('</u>', i + 3);
      if (close < 0) fail('parse/unsupported', line, '未闭合的 <u> 下划线');
      const inner = parseInline(
        text.slice(i + 3, close),
        line,
        addMarks(baseMarks, [{ type: 'underline' }]),
      );
      flush();
      nodes.push(...inner);
      i = close + 4;
      continue;
    }

    if (/^<br\s*\/?>/i.test(text.slice(i))) {
      const match = /^<br\s*\/?>/i.exec(text.slice(i))!;
      flush();
      nodes.push({ type: 'hardBreak' });
      i += match[0].length;
      continue;
    }

    if (char === '<') {
      const tag = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[\s>/]|$)/.exec(text.slice(i));
      if (tag !== null) {
        fail('parse/unsupported', line, `不支持的 HTML 标签 <${tag[1]}>`);
      }
      buffer += '<';
      i += 1;
      continue;
    }

    if (char === '!' && text[i + 1] === '[') {
      fail('parse/unsupported', line, '图片必须独占一行，不能内联在段落中');
    }

    if (char === '[') {
      const link = tryParseLink(text, i, line, baseMarks);
      if (link !== null) {
        flush();
        nodes.push(...link.nodes);
        i = link.next;
        continue;
      }
    }

    buffer += char;
    i += 1;
  }

  flush();
  return normalizeInline(nodes);
}

interface ParsedLink {
  nodes: InlineNode[];
  next: number;
}

function tryParseLink(
  text: string,
  start: number,
  line: number,
  baseMarks: readonly Mark[],
): ParsedLink | null {
  let depth = 1;
  let close = start + 1;
  while (close < text.length) {
    const char = text[close]!;
    if (char === '\\') {
      close += 2;
      continue;
    }
    if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) break;
    }
    close += 1;
  }
  if (close >= text.length) return null;
  if (text[close + 1] !== '(') return null;
  const destination = parseLinkDestination(text, close + 2, line);
  if (destination === null) return null;
  const href = unescapePunctuation(destination.href);
  if (!SAFE_HREF.test(href)) {
    fail('node/schema-invalid', line, `链接 href 不合法：${href}`);
  }
  const inner = parseInline(
    text.slice(start + 1, close),
    line,
    addMarks(baseMarks, [{ type: 'link', attrs: { href } }]),
  );
  return { nodes: inner, next: destination.next };
}

/** Parse a link destination and optional quoted title after `(`. */
function parseLinkDestination(
  text: string,
  start: number,
  line: number,
): { href: string; next: number } | null {
  let index = start;
  let href: string;
  if (text[index] === '<') {
    const end = text.indexOf('>', index + 1);
    if (end < 0) return null;
    href = text.slice(index + 1, end);
    index = end + 1;
  } else {
    let depth = 0;
    const begin = index;
    while (index < text.length) {
      const char = text[index]!;
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === '(') depth += 1;
      else if (char === ')') {
        if (depth === 0) break;
        depth -= 1;
      } else if (/\s/.test(char) && depth === 0) break;
      index += 1;
    }
    href = text.slice(begin, index);
  }
  while (index < text.length && /\s/.test(text[index]!)) index += 1;
  if (text[index] === '"' || text[index] === "'") {
    const quote = text[index]!;
    index += 1;
    while (index < text.length) {
      const char = text[index]!;
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === quote) break;
      index += 1;
    }
    if (text[index] !== quote) fail('parse/unsupported', line, '链接 title 未闭合');
    index += 1;
    while (index < text.length && /\s/.test(text[index]!)) index += 1;
  }
  if (text[index] !== ')') return null;
  return { href, next: index + 1 };
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

function leadingIndent(text: string): number {
  return /^[ \t]*/.exec(text)![0].length;
}

function isBlank(text: string): boolean {
  return text.trim() === '';
}

/** Dedent nested lines by their common indentation (blank lines stay blank). */
function dedentLines(lines: readonly SourceLine[]): SourceLine[] {
  let min = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (!isBlank(line.text)) min = Math.min(min, leadingIndent(line.text));
  }
  if (!Number.isFinite(min) || min <= 0) return [...lines];
  return lines.map((line) =>
    isBlank(line.text) ? { text: '', no: line.no } : { text: line.text.slice(min), no: line.no },
  );
}

interface ListMarker {
  indent: number;
  ordered: boolean;
  number: number;
  content: string;
}

function matchListMarker(text: string): ListMarker | null {
  const match = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/.exec(text);
  if (match === null) return null;
  const marker = match[2]!;
  const ordered = /^\d/.test(marker);
  return {
    indent: match[1]!.length,
    ordered,
    number: ordered ? Number.parseInt(marker, 10) : 1,
    content: match[4]!,
  };
}

function checkboxOf(content: string): { checked: boolean; text: string } | null {
  const match = /^\[([ xX])\](?:[ \t]+(.*))?$/.exec(content);
  if (match === null) return null;
  return { checked: match[1]!.toLowerCase() === 'x', text: match[2] ?? '' };
}

function isTableSeparator(text: string): boolean {
  if (!text.includes('-')) return false;
  const cells = splitTableRow(text);
  if (cells.length === 0) return false;
  return cells.every((cell) => /^:?-{1,}:?$/.test(cell.trim()));
}

function splitTableRow(text: string): string[] {
  let trimmed = text.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) trimmed = trimmed.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]!;
    if (char === '\\' && trimmed[index + 1] === '|') {
      current += '|';
      index += 1;
      continue;
    }
    if (char === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function isTableStart(lines: readonly SourceLine[], index: number): boolean {
  const header = lines[index];
  if (header === undefined || !header.text.includes('|')) return false;
  const separator = lines[index + 1];
  if (separator === undefined) return false;
  return isTableSeparator(separator.text);
}

function looksLikeImageLine(trimmed: string): boolean {
  return trimmed.startsWith('![');
}

function looksLikeUnknownHtmlBlock(trimmed: string): boolean {
  const match = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[\s>/]|$)/.exec(trimmed);
  if (match === null) return false;
  const tag = match[1]!.toLowerCase();
  return tag !== 'u' && tag !== 'br';
}

interface DirectiveHead {
  name: string;
  attrsRaw: string | undefined;
}

/** Parse a `:::name{...}` line; `null` means "not a directive line". */
function tryParseDirectiveHead(trimmed: string, line: number): DirectiveHead | null {
  if (!trimmed.startsWith(':::')) return null;
  const rest = trimmed.slice(3);
  if (rest === '') return null;
  const nameMatch = /^([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
  if (nameMatch === null) fail('parse/unsupported', line, `无法识别的指令：${trimmed}`);
  const name = nameMatch[1]!;
  const after = rest.slice(name.length).trimEnd();
  if (after === '') return { name, attrsRaw: undefined };
  if (!after.startsWith('{')) {
    fail('parse/unsupported', line, `指令 :::${name} 的头部格式不正确`);
  }
  let index = 1;
  let raw = '';
  let quoted = false;
  while (index < after.length) {
    const char = after[index]!;
    if (quoted) {
      raw += char;
      if (char === '\\') {
        const next = after[index + 1];
        if (next !== undefined) {
          raw += next;
          index += 2;
          continue;
        }
      } else if (char === '"') {
        quoted = false;
      }
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = true;
      raw += char;
      index += 1;
      continue;
    }
    if (char === '}') break;
    raw += char;
    index += 1;
  }
  if (after[index] !== '}') {
    fail('parse/unsupported', line, `指令 :::${name} 缺少关闭的 }`);
  }
  if (after.slice(index + 1).trim() !== '') {
    fail('parse/unsupported', line, `指令 :::${name} 的头部有多余内容`);
  }
  return { name, attrsRaw: raw };
}

/** Tokenize directive attributes; `#blk_…` id hints are ignored. */
function tokenizeDirectiveAttrs(
  raw: string,
  name: string,
  line: number,
): Array<[string, string]> {
  const tokens: Array<[string, string]> = [];
  let index = 0;
  const isSpace = (char: string): boolean => /\s/.test(char);
  while (index < raw.length) {
    while (index < raw.length && isSpace(raw[index]!)) index += 1;
    if (index >= raw.length) break;
    if (raw[index] === '#') {
      while (index < raw.length && !isSpace(raw[index]!)) index += 1;
      continue;
    }
    const keyMatch = /^[A-Za-z][A-Za-z0-9_-]*/.exec(raw.slice(index));
    if (keyMatch === null) {
      fail('parse/unsupported', line, `指令 :::${name} 的属性格式不正确`);
    }
    const key = keyMatch[0];
    index += key.length;
    while (index < raw.length && isSpace(raw[index]!)) index += 1;
    if (raw[index] !== '=') {
      fail('parse/unsupported', line, `指令 :::${name} 的属性 ${key} 缺少 =`);
    }
    index += 1;
    while (index < raw.length && isSpace(raw[index]!)) index += 1;
    if (index >= raw.length) {
      fail('parse/unsupported', line, `指令 :::${name} 的属性 ${key} 缺少值`);
    }
    let value = '';
    if (raw[index] === '"') {
      index += 1;
      let closed = false;
      while (index < raw.length) {
        const char = raw[index]!;
        if (char === '\\') {
          const next = raw[index + 1];
          if (next === undefined) {
            value += '\\';
            index += 1;
            continue;
          }
          value += unescapeDirectiveChar(next);
          index += 2;
          continue;
        }
        if (char === '"') {
          closed = true;
          index += 1;
          break;
        }
        value += char;
        index += 1;
      }
      if (!closed) {
        fail('parse/unsupported', line, `指令 :::${name} 的属性 ${key} 字符串未闭合`);
      }
    } else {
      const begin = index;
      while (index < raw.length && !isSpace(raw[index]!)) index += 1;
      value = raw.slice(begin, index);
    }
    tokens.push([key, value]);
  }
  return tokens;
}

/** Coerce and validate directive attributes against the node registry. */
function parseDirectiveAttrs(
  name: string,
  raw: string | undefined,
  line: number,
): Record<string, JsonValue> {
  const definition = NODE_TYPES[name];
  if (definition === undefined) fail('parse/unsupported', line, `不支持的指令：:::${name}`);
  const attrs: Record<string, JsonValue> = {};
  if (raw !== undefined) {
    for (const [key, value] of tokenizeDirectiveAttrs(raw, name, line)) {
      const spec = definition.attrs[key];
      if (spec === undefined) {
        fail('parse/unsupported', line, `指令 :::${name} 不支持属性 ${key}`);
      }
      if (spec.type === 'boolean') {
        if (value !== 'true' && value !== 'false') {
          fail('node/schema-invalid', line, `指令 :::${name} 的属性 ${key} 必须是 true/false`);
        }
        attrs[key] = value === 'true';
      } else if (spec.type === 'number') {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
          fail('node/schema-invalid', line, `指令 :::${name} 的属性 ${key} 必须是数字`);
        }
        attrs[key] = parsed;
      } else {
        attrs[key] = value;
      }
      if (spec.enum !== undefined && !spec.enum.includes(attrs[key]!)) {
        fail(
          'node/schema-invalid',
          line,
          `指令 :::${name} 的属性 ${key} 必须是 ${spec.enum.map(String).join('/')}`,
        );
      }
      const text = typeof attrs[key] === 'string' ? (attrs[key] as string) : undefined;
      if (spec.type === 'assetRef' && text !== undefined && !text.startsWith('asset_')) {
        fail('node/schema-invalid', line, `指令 :::${name} 的属性 ${key} 不是有效资产 id`);
      }
      if (spec.type === 'objectRef' && text !== undefined && !text.startsWith('obj_')) {
        fail('node/schema-invalid', line, `指令 :::${name} 的属性 ${key} 不是有效对象 id`);
      }
    }
  }
  for (const [key, spec] of Object.entries(definition.attrs)) {
    if (spec.required === true && attrs[key] === undefined) {
      fail('node/schema-invalid', line, `指令 :::${name} 缺少属性 ${key}`);
    }
  }
  return attrs;
}

interface ParsedBlock {
  block: BlockNode;
  next: number;
}

function parseFence(lines: readonly SourceLine[], start: number, ctx: MarkdownParseOptions): ParsedBlock {
  const line = lines[start]!;
  const match = /^(\s{0,3})(`{3,}|~{3,})(.*)$/.exec(line.text)!;
  const indent = match[1]!.length;
  const fenceToken = match[2]!;
  const fenceChar = fenceToken[0]!;
  const info = match[3]!.trim();
  if (fenceChar === '`' && info.includes('`')) {
    fail('parse/unsupported', line.no, '围栏代码块的 info 不能包含反引号');
  }
  const lang = info === '' ? '' : info.split(/\s+/)[0]!;
  if (lang.length > 32) {
    fail('node/schema-invalid', line.no, `代码块语言标记过长：${lang}`);
  }
  const closing = new RegExp(`^\\s{0,3}\\${fenceChar}{${fenceToken.length},}\\s*$`);
  const body: string[] = [];
  let index = start + 1;
  let closed = false;
  while (index < lines.length) {
    const current = lines[index]!;
    if (closing.test(current.text)) {
      closed = true;
      break;
    }
    const text = current.text;
    let removed = 0;
    while (removed < indent && text[removed] === ' ') removed += 1;
    body.push(text.slice(removed));
    index += 1;
  }
  if (!closed) fail('parse/unsupported', line.no, '围栏代码块未闭合');
  const code = body.join('\n');
  const attrs: Record<string, JsonValue> = {};
  if (lang !== '') attrs.lang = lang;
  const content: InlineNode[] = code === '' ? [] : [{ type: 'text', text: code }];
  return {
    block: makeBlock(ctx, 'codeBlock', attrs, { content }),
    next: index + 1,
  };
}

function parseHeading(line: SourceLine, ctx: MarkdownParseOptions): BlockNode {
  const match = /^(#{1,6})(?:[ \t]+(.*))?$/.exec(line.text.trim())!;
  const level = match[1]!.length;
  let text = match[2] ?? '';
  text = text.replace(/[ \t]+#+[ \t]*$/, '');
  const content = text.trim() === '' ? [] : parseInline(text, line.no);
  return makeBlock(ctx, 'heading', { level }, { content });
}

function parseBlockquote(lines: readonly SourceLine[], start: number, ctx: MarkdownParseOptions): ParsedBlock {
  const collected: SourceLine[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!/^\s{0,3}>/.test(line.text)) break;
    collected.push({ text: line.text.replace(/^\s{0,3}>\s?/, ''), no: line.no });
    index += 1;
  }
  const children = parseBlocks(collected, ctx);
  return {
    block: makeBlock(ctx, 'blockquote', {}, { children }),
    next: index,
  };
}

function parseList(
  lines: readonly SourceLine[],
  start: number,
  first: ListMarker,
  ctx: MarkdownParseOptions,
): ParsedBlock {
  const listIndent = first.indent;
  const kind: 'bullet' | 'ordered' | 'task' = first.ordered
    ? 'ordered'
    : checkboxOf(first.content) !== null
      ? 'task'
      : 'bullet';
  const startNumber = kind === 'ordered' ? first.number : 1;
  const items: BlockNode[] = [];
  let index = start;

  while (index < lines.length) {
    const line = lines[index]!;
    const marker = matchListMarker(line.text);
    if (marker === null || marker.indent !== listIndent) break;
    const itemKind: 'bullet' | 'ordered' | 'task' = marker.ordered
      ? 'ordered'
      : checkboxOf(marker.content) !== null
        ? 'task'
        : 'bullet';
    if (itemKind !== kind) break;
    index += 1;

    // Gather indented continuation lines (nested lists, extra paragraphs).
    const continuation: SourceLine[] = [];
    while (index < lines.length) {
      const current = lines[index]!;
      if (isBlank(current.text)) {
        let lookahead = index + 1;
        while (lookahead < lines.length && isBlank(lines[lookahead]!.text)) lookahead += 1;
        if (lookahead >= lines.length) {
          index = lookahead;
          break;
        }
        if (leadingIndent(lines[lookahead]!.text) <= listIndent) {
          index = lookahead;
          break;
        }
        continuation.push({ text: '', no: current.no });
        index += 1;
        continue;
      }
      if (leadingIndent(current.text) <= listIndent) break;
      continuation.push(current);
      index += 1;
    }

    let text = marker.content;
    let checked: boolean | undefined;
    const checkbox = checkboxOf(text);
    if (kind === 'task' && checkbox !== null) {
      checked = checkbox.checked;
      text = checkbox.text;
    }
    const children: BlockNode[] = [];
    if (text.trim() !== '') {
      children.push(
        makeBlock(ctx, 'paragraph', {}, { content: parseInline(text, line.no) }),
      );
    }
    if (continuation.length > 0) {
      children.push(...parseBlocks(dedentLines(continuation), ctx));
    }
    const attrs: Record<string, JsonValue> = {};
    if (kind === 'task') attrs.checked = checked === true;
    items.push(makeBlock(ctx, 'listItem', attrs, { children }));
  }

  const attrs: Record<string, JsonValue> = {};
  if (kind === 'ordered' && startNumber !== 1) attrs.start = startNumber;
  const type = kind === 'ordered' ? 'orderedList' : kind === 'task' ? 'taskList' : 'bulletList';
  return { block: makeBlock(ctx, type, attrs, { children: items }), next: index };
}

function parseTable(lines: readonly SourceLine[], start: number, ctx: MarkdownParseOptions): ParsedBlock {
  const headerLine = lines[start]!;
  const rowLines: SourceLine[] = [headerLine];
  let index = start + 2; // skip header + separator
  while (index < lines.length) {
    const line = lines[index]!;
    if (isBlank(line.text) || !line.text.includes('|')) break;
    if (startsNewBlock(lines, index)) break;
    rowLines.push(line);
    index += 1;
  }
  const rows = rowLines.map((line) => {
    const cells = splitTableRow(line.text).map((cellText) =>
      makeBlock(ctx, 'tableCell', {}, { content: parseInline(cellText, line.no) }),
    );
    return makeBlock(ctx, 'tableRow', {}, { children: cells });
  });
  return {
    block: makeBlock(ctx, 'table', { headerRows: 1 }, { children: rows }),
    next: index,
  };
}

function parseImageLine(line: SourceLine, ctx: MarkdownParseOptions): BlockNode {
  const trimmed = line.text.trim();
  const match = IMAGE_LINE.exec(trimmed);
  if (match === null) {
    fail('parse/unsupported', line.no, `不支持的图片语法：${trimmed}`);
  }
  const alt = unescapePunctuation(match[1]!);
  const url = match[2]!;
  const caption = match[3] === undefined ? undefined : unescapePunctuation(match[3]);
  const asset = ASSET_REF.exec(url);
  if (asset === null) {
    fail(
      'parse/unsupported',
      line.no,
      `不支持的图片地址（只接受 space-asset://asset_…）：${url}`,
    );
  }
  const assetId = asset[1]!;
  if (ctx.hasAsset !== undefined && !ctx.hasAsset(assetId)) {
    fail('parse/unsupported', line.no, `图片引用的资产不存在：${assetId}`);
  }
  const attrs: Record<string, JsonValue> = { assetId };
  if (alt !== '') attrs.alt = alt;
  if (caption !== undefined && caption !== '') attrs.caption = caption;
  return makeBlock(ctx, 'image', attrs);
}

function parseDirective(
  lines: readonly SourceLine[],
  start: number,
  head: DirectiveHead,
  ctx: MarkdownParseOptions,
): ParsedBlock {
  const line = lines[start]!;
  if (head.name === 'callout') {
    let depth = 1;
    let index = start + 1;
    let closeIndex = -1;
    while (index < lines.length) {
      const trimmed = lines[index]!.text.trim();
      if (trimmed === ':::') {
        depth -= 1;
        if (depth === 0) {
          closeIndex = index;
          break;
        }
      } else if (trimmed.startsWith(':::')) {
        depth += 1;
      }
      index += 1;
    }
    if (closeIndex < 0) fail('parse/unsupported', line.no, ':::callout 指令未闭合');
    const children = parseBlocks(lines.slice(start + 1, closeIndex), ctx);
    const attrs = parseDirectiveAttrs('callout', head.attrsRaw, line.no);
    return { block: makeBlock(ctx, 'callout', attrs, { children }), next: closeIndex + 1 };
  }
  if (head.name === 'mindmap' || head.name === 'component') {
    let index = start + 1;
    while (index < lines.length && isBlank(lines[index]!.text)) index += 1;
    if (index >= lines.length || lines[index]!.text.trim() !== ':::') {
      fail('parse/unsupported', line.no, `:::${head.name} 必须为空体并以 ::: 结束`);
    }
    const attrs = parseDirectiveAttrs(head.name, head.attrsRaw, line.no);
    return { block: makeBlock(ctx, head.name, attrs), next: index + 1 };
  }
  fail('parse/unsupported', line.no, `不支持的指令：:::${head.name}`);
}

/** Whether `index` starts a new block (used to end paragraphs/tables). */
function startsNewBlock(lines: readonly SourceLine[], index: number): boolean {
  const line = lines[index]!;
  const trimmed = line.text.trim();
  if (trimmed === '') return true;
  if (ANCHOR_COMMENT.test(trimmed)) return true;
  if (trimmed.startsWith(':::')) return true;
  if (/^\s{0,3}(`{3,}|~{3,})/.test(line.text)) return true;
  if (/^#{1,6}(?:[ \t]|$)/.test(trimmed)) return true;
  if (/^-{3,}$/.test(trimmed)) return true;
  if (/^\s{0,3}>/.test(line.text)) return true;
  if (matchListMarker(line.text) !== null) return true;
  if (isTableStart(lines, index)) return true;
  if (looksLikeImageLine(trimmed)) return true;
  if (looksLikeUnknownHtmlBlock(trimmed)) return true;
  return false;
}

function parseParagraph(
  lines: readonly SourceLine[],
  start: number,
  ctx: MarkdownParseOptions,
): ParsedBlock {
  const collected: SourceLine[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index]!;
    if (isBlank(line.text)) break;
    if (collected.length > 0 && startsNewBlock(lines, index)) break;
    collected.push(line);
    index += 1;
  }
  const content: InlineNode[] = [];
  for (const [position, line] of collected.entries()) {
    if (position > 0) content.push({ type: 'hardBreak' });
    content.push(...parseInline(line.text, line.no));
  }
  return {
    block: makeBlock(ctx, 'paragraph', {}, { content: normalizeInline(content) }),
    next: index,
  };
}

function parseBlocks(lines: readonly SourceLine[], ctx: MarkdownParseOptions): BlockNode[] {
  const blocks: BlockNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const trimmed = line.text.trim();
    if (trimmed === '') {
      index += 1;
      continue;
    }
    if (ANCHOR_COMMENT.test(trimmed)) {
      index += 1;
      continue;
    }
    if (trimmed === ':::') fail('parse/unsupported', line.no, '多余的 ::: 关闭行');
    const directive = tryParseDirectiveHead(trimmed, line.no);
    if (directive !== null) {
      const parsed = parseDirective(lines, index, directive, ctx);
      blocks.push(parsed.block);
      index = parsed.next;
      continue;
    }
    if (/^\s{0,3}(`{3,}|~{3,})/.test(line.text)) {
      const parsed = parseFence(lines, index, ctx);
      blocks.push(parsed.block);
      index = parsed.next;
      continue;
    }
    if (/^#{1,6}(?:[ \t]|$)/.test(trimmed)) {
      blocks.push(parseHeading(line, ctx));
      index += 1;
      continue;
    }
    if (/^-{3,}$/.test(trimmed)) {
      blocks.push(makeBlock(ctx, 'divider'));
      index += 1;
      continue;
    }
    if (/^\s{0,3}>/.test(line.text)) {
      const parsed = parseBlockquote(lines, index, ctx);
      blocks.push(parsed.block);
      index = parsed.next;
      continue;
    }
    if (matchListMarker(line.text) !== null) {
      const parsed = parseList(lines, index, matchListMarker(line.text)!, ctx);
      blocks.push(parsed.block);
      index = parsed.next;
      continue;
    }
    if (isTableStart(lines, index)) {
      const parsed = parseTable(lines, index, ctx);
      blocks.push(parsed.block);
      index = parsed.next;
      continue;
    }
    if (looksLikeImageLine(trimmed)) {
      blocks.push(parseImageLine(line, ctx));
      index += 1;
      continue;
    }
    if (looksLikeUnknownHtmlBlock(trimmed)) {
      const tag = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(trimmed)!;
      fail('parse/unsupported', line.no, `不支持的 HTML 标签 <${tag[1]}>`);
    }
    const parsed = parseParagraph(lines, index, ctx);
    blocks.push(parsed.block);
    index = parsed.next;
  }
  return blocks;
}

/**
 * Parse Markdown into block nodes.
 *
 * Only the supported subset is accepted (spec "解析方向（仅新内容）");
 * failures raise `DocumentError` with `parse/unsupported` or
 * `node/schema-invalid` and the source line number. The result is validated
 * against the registry before being returned.
 */
export function parseMarkdownBlocks(
  source: string,
  options: MarkdownParseOptions,
): BlockNode[] {
  const normalized = source.replace(/\r\n?/g, '\n');
  const lines: SourceLine[] = normalized
    .split('\n')
    .map((text, index) => ({ text, no: index + 1 }));
  const blocks = parseBlocks(lines, options);
  validateAlterDoc({
    format: ALTER_DOC_FORMAT,
    schemaVersion: ALTER_DOC_SCHEMA_VERSION,
    revision: 0,
    blocks,
  });
  return blocks;
}
