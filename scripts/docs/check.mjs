#!/usr/bin/env node
/**
 * Documentation governance check for the Alter-dsh knowledge base.
 *
 * The rules live in docs/README.md and are enforced here: document classes,
 * per-document size budgets, folder/total count budgets, frontmatter metadata,
 * index completeness, resolvable relative links (including anchors), repo-wide
 * markdown scope, naming, and the ban on changelog sections / source-code fences
 * inside the key documents that every agent reads first.
 *
 * Mechanical rules are enforced here; semantic rules (single source of truth,
 * no implementation walkthroughs, current-only content) remain review duties.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

const CATEGORY_TYPES = new Map([
  ['specs', 'spec'],
  ['designs', 'design'],
  ['research', 'research'],
  ['acceptance', 'acceptance'],
]);
const ROOT_DOCS = ['AGENTS.md', 'README.md'];
const DOCS_INDEX = 'docs/README.md';
const VENDOR_DOC = 'vendor/README.md';
const ARCHIVE_DIR = 'docs/archive';
const ARCHIVE_MANIFEST = 'docs/archive/manifest.json';

/**
 * Every ceiling lives in `doc-budgets.json` so raising one is an explicit,
 * reviewable diff rather than an edit buried in this script. The values are
 * loaded before any check runs.
 */
async function loadBudgets() {
  const file = path.join(here, 'doc-budgets.json');
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`scripts/docs/doc-budgets.json: cannot load the budget manifest (${error.message})`);
  }
}

let ROOT_DOC_LIMITS = new Map();
let CATEGORY_README_LIMIT = { lines: 0, bytes: 0 };
let CONTENT_DOC_LIMIT = { lines: 0, bytes: 0 };
let MAX_DOCS_PER_FOLDER = 0;
let MAX_TOTAL_DOCS = 0;
let TOTAL_DOCS_WARN = 0;
let MAX_ARCHIVE_DOCS = 0;
let MAX_CATEGORIES = 0;
/** Lifecycle thresholds (docs/README.md "生命周期与自动归档"). */
let RESEARCH_AGE_DAYS = 0;
let ACCEPTANCE_AGE_DAYS = 0;
let DESIGN_REVIEW_AGE_DAYS = 0;
let DRAFT_SPEC_REVIEW_AGE_DAYS = 0;

/** Copy the manifest ceilings into the module-level limits the checks read. */
function applyBudgets(manifest) {
  ROOT_DOC_LIMITS = new Map(Object.entries(manifest.documents ?? {}));
  CATEGORY_README_LIMIT = manifest.byRole?.categoryIndex ?? CATEGORY_README_LIMIT;
  CONTENT_DOC_LIMIT = manifest.byRole?.contentDoc ?? CONTENT_DOC_LIMIT;
  const counts = manifest.counts ?? {};
  MAX_DOCS_PER_FOLDER = counts.maxDocsPerFolder;
  MAX_TOTAL_DOCS = counts.maxActiveDocs;
  TOTAL_DOCS_WARN = counts.warnActiveDocs;
  MAX_ARCHIVE_DOCS = counts.maxArchiveDocs;
  MAX_CATEGORIES = counts.maxCategories;
  const days = manifest.lifecycleDays ?? {};
  RESEARCH_AGE_DAYS = days.research;
  ACCEPTANCE_AGE_DAYS = days.acceptance;
  DESIGN_REVIEW_AGE_DAYS = days.designReview;
  DRAFT_SPEC_REVIEW_AGE_DAYS = days.draftSpecReview;
}
/** Directories that never carry knowledge documents. */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.dsh-build',
  // Project-level agent tooling (skills, instructions) is not knowledge documentation.
  '.agents',
  'lib',
  'dist',
  'coverage',
  '.vitest',
  'playwright-report',
  'test-results',
]);
/** Key documents are read before anything else; they never carry source code. */
const KEY_DOCS = new Set([
  ...ROOT_DOCS,
  DOCS_INDEX,
  VENDOR_DOC,
  ...[...CATEGORY_TYPES.keys()].map((category) => `docs/${category}/README.md`),
]);
const ALLOWED_KEY_DOC_FENCES = new Set(['', 'sh', 'bash', 'json', 'yaml']);
const FORBIDDEN_HEADING =
  /(变更记录|变更历史|更新记录|更新历史|更新日志|修订历史|修订记录|版本历史|版本记录|改动记录|changelog)/i;
const FRONTMATTER_KEYS = ['type', 'status', 'updated'];
const CONTENT_FILE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const failures = [];
const notes = [];
const docs = [];

const fail = (message) => failures.push(message);
const relative = (absolute) => path.relative(root, absolute).split(path.sep).join('/');
const read = (relativePath) => readFile(path.join(root, relativePath), 'utf8');
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const countLines = (text) =>
  text.length === 0 ? 0 : text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
const KiB = 1024;
const formatKiB = (bytes) => `${(bytes / KiB).toFixed(1)} KiB`;
/** Seal hash of one archived document, used to detect post-archival edits. */
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const isMarkdown = (name) => /\.md$/i.test(name);

const DAY_MS = 86_400_000;
const todayUtc = Date.parse(new Date().toISOString().slice(0, 10));
const daysSince = (updated) => Math.floor((todayUtc - Date.parse(updated)) / DAY_MS);

/** An acceptance checklist is settled when no item is open or half-done. */
const isSettledChecklist = (body) => !/^ *- \[( |~)\]/m.test(stripInlineCode(body));

/** Silent frontmatter parse for lifecycle notes (never reports failures). */
function metaOf(text) {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---\n', 3);
  if (end < 0) return null;
  const meta = new Map();
  for (const line of text.slice(4, end).split('\n')) {
    const match = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (match) meta.set(match[1], match[2].trim());
  }
  return { meta, body: text.slice(end + 5) };
}

async function exists(relativePath) {
  try {
    await stat(path.join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function walk(dir, found = []) {
  let entries;
  try {
    entries = await readdir(path.join(root, dir), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;
    const child = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      await walk(child, found);
    } else if (entry.isFile()) {
      found.push(child);
    }
  }
  return found;
}

/**
 * Split markdown into fenced-code segments and the remaining body so links,
 * headings and key-document content checks do not look inside code fences.
 * A fence opens with up to three spaces and at least three backticks/tildes and
 * closes with a matching fence of the same character and at least the same length.
 */
function splitFences(text) {
  const lines = text.split('\n');
  const body = [];
  const fences = [];
  let open = null;
  for (const line of lines) {
    if (open === null) {
      const start = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (start) {
        open = { marker: start[1][0], length: start[1].length, info: start[2] };
        fences.push({ info: open.info, lines: [] });
        continue;
      }
      body.push(line);
    } else {
      const end = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (end && end[1][0] === open.marker && end[1].length >= open.length) {
        open = null;
        continue;
      }
      fences[fences.length - 1].lines.push(line);
    }
  }
  return { body: body.join('\n'), fences, unclosedFence: open !== null };
}

function stripInlineCode(text) {
  return text.replace(/`[^`\n]*`/g, '');
}

function checkBudget(relativePath, text, limit) {
  const lines = countLines(text);
  const bytes = Buffer.byteLength(text);
  if (lines > limit.lines) {
    fail(`${relativePath}: ${lines} lines exceeds the ${limit.lines}-line budget`);
  }
  if (bytes > limit.bytes) {
    fail(`${relativePath}: ${formatKiB(bytes)} exceeds the ${formatKiB(limit.bytes)} budget`);
  }
  docs.push({ path: relativePath, lines, bytes, limit });
}

function parseFrontmatter(relativePath, text) {
  if (!text.startsWith('---\n')) {
    fail(`${relativePath}: docs under docs/ must start with a frontmatter block`);
    return { body: text, meta: null };
  }
  const end = text.indexOf('\n---\n', 3);
  if (end < 0) {
    fail(`${relativePath}: frontmatter block is not closed`);
    return { body: text, meta: null };
  }
  const head = text.slice(4, end);
  const body = text.slice(end + 5);
  const meta = new Map();
  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    const match = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (!match) {
      fail(`${relativePath}: malformed frontmatter line "${line}"`);
      continue;
    }
    if (meta.has(match[1])) {
      fail(`${relativePath}: duplicate frontmatter key "${match[1]}"`);
    }
    meta.set(match[1], match[2].trim());
  }
  for (const key of FRONTMATTER_KEYS) {
    if (!meta.has(key)) fail(`${relativePath}: frontmatter is missing "${key}"`);
  }
  // `archived` records the retirement date and is only legal in the archive.
  const isArchivedDoc = relativePath.startsWith(`${ARCHIVE_DIR}/`);
  for (const key of meta.keys()) {
    if (FRONTMATTER_KEYS.includes(key)) continue;
    if (key === 'archived' && isArchivedDoc) {
      if (!validIsoDate(meta.get(key))) {
        fail(`${relativePath}: archived "${meta.get(key)}" must be a real YYYY-MM-DD date`);
      }
      continue;
    }
    fail(`${relativePath}: unexpected frontmatter key "${key}"`);
  }
  if (isArchivedDoc && !meta.has('archived')) {
    fail(`${relativePath}: archived documents need an "archived: YYYY-MM-DD" frontmatter line`);
  }
  return { body, meta };
}

function validIsoDate(value) {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function checkHeadings(relativePath, body) {
  const headings = body.split('\n').filter((line) => /^#{1,6}\s/.test(line));
  const h1 = headings.filter((line) => /^#\s/.test(line));
  if (h1.length !== 1) {
    fail(`${relativePath}: expected exactly one H1 heading, found ${h1.length}`);
  }
  for (const heading of headings) {
    if (FORBIDDEN_HEADING.test(heading)) {
      fail(`${relativePath}: changelog-style heading is not allowed (${heading.trim()})`);
    }
  }
}

function checkKeyDocumentContent(relativePath, split) {
  if (split.unclosedFence) fail(`${relativePath}: unbalanced code fence`);
  for (const fence of split.fences) {
    const language = fence.info.trim().split(/\s+/)[0].toLowerCase();
    if (!ALLOWED_KEY_DOC_FENCES.has(language)) {
      fail(
        `${relativePath}: key documents must not embed ${language || 'unlabeled'} source code ` +
          '(use a link to the code instead)',
      );
    }
  }
  const bodyLines = split.body.split('\n');
  // Indented code can hide inside list continuation paragraphs, so decide by
  // content: prose continuations are allowed, code-shaped indented lines are not.
  // The heuristic intentionally misses non-code-shaped indented lines to avoid
  // false positives on Chinese prose continuations.
  const indentedCodeLike =
    /[;{}=<>]|=>|\b(?:const|let|var|function|return|import|export|class|def|async|await)\b/;
  for (const line of bodyLines) {
    if (!/^(?: {4,}|\t)\S/.test(line)) continue;
    if (!indentedCodeLike.test(line)) continue;
    fail(`${relativePath}: indented code is not allowed in key documents (use a command fence)`);
    break;
  }
}

function githubSlug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-');
}

function collectHeadings(body) {
  return body
    .split('\n')
    .filter((line) => /^#{1,6}\s/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, ''));
}

function collectLinkTargets(relativePath, body, collected) {
  const text = stripInlineCode(body);
  const targets = [];
  for (const match of text.matchAll(/\[[^\]]*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+["'(][^)]*)?\)/g)) {
    targets.push(match[1].replace(/^<|>$/g, ''));
  }
  for (const match of text.matchAll(/^ {0,3}\[[^\]]+\]:\s*(\S+)/gm)) {
    targets.push(match[1].replace(/^<|>$/g, ''));
  }
  for (const raw of targets) {
    if (/^(https?:|mailto:|tel:|#|space-asset:)/i.test(raw)) continue;
    const [target, fragment] = raw.split('#');
    if (!target) continue;
    const resolved = target.startsWith('/')
      ? path.resolve(root, `.${target}`)
      : path.resolve(path.dirname(path.join(root, relativePath)), target);
    collected.push({ source: relativePath, target: resolved, fragment });
  }
}

function isInsideRoot(absolute) {
  const normalized = path.resolve(absolute);
  return normalized === root || normalized.startsWith(`${root}${path.sep}`);
}

async function main() {
  // --- Budget manifest ------------------------------------------------------
  try {
    applyBudgets(await loadBudgets());
  } catch (error) {
    console.error('FAIL');
    console.error(`- ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  // --- Repository-wide markdown scope -------------------------------------
  const allMarkdown = (await walk('')).filter(isMarkdown);
  for (const file of allMarkdown) {
    const allowed =
      ROOT_DOCS.includes(file) || file === VENDOR_DOC || file.startsWith('docs/');
    if (!allowed) {
      fail(
        `${file}: markdown outside the knowledge base is not allowed ` +
          '(only AGENTS.md, README.md, docs/**, vendor/README.md)',
      );
    }
  }
  for (const name of ROOT_DOCS) {
    if (!allMarkdown.includes(name)) fail(`repository root: missing ${name}`);
  }

  // --- docs/ layout ---------------------------------------------------------
  let docsEntries = [];
  try {
    docsEntries = await readdir(path.join(root, 'docs'), { withFileTypes: true });
  } catch {
    fail('docs/: directory is missing');
  }
  const categoryDirs = docsEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== 'archive')
    .sort();
  if (categoryDirs.length > MAX_CATEGORIES) {
    fail(`docs/: ${categoryDirs.length} category directories exceed the ${MAX_CATEGORIES}-category budget`);
  }
  for (const name of categoryDirs) {
    if (!CATEGORY_TYPES.has(name)) {
      fail(`docs/${name}/: unknown category directory (allowed: ${[...CATEGORY_TYPES.keys()].join(', ')})`);
    }
  }
  for (const expected of CATEGORY_TYPES.keys()) {
    if (!categoryDirs.includes(expected)) fail(`docs/${expected}/: category directory is missing`);
  }
  for (const entry of docsEntries) {
    if (entry.isFile() && isMarkdown(entry.name) && entry.name !== 'README.md') {
      fail(`docs/${entry.name}: loose documents are not allowed; put it in a category directory`);
    }
  }
  if (!(await exists(DOCS_INDEX))) fail(`${DOCS_INDEX}: documentation index is missing`);

  const inScope = [...ROOT_DOCS];
  const categoryFiles = new Map();
  for (const category of CATEGORY_TYPES.keys()) {
    let names = [];
    try {
      const entries = await readdir(path.join(root, 'docs', category), { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          fail(`docs/${category}/${entry.name}/: nested directories are not allowed (flat category folders only)`);
        }
      }
      names = entries
        .filter((entry) => entry.isFile() && isMarkdown(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch {
      continue;
    }
    if (!names.includes('README.md')) {
      fail(`docs/${category}/README.md: category index is missing`);
    }
    if (names.length > MAX_DOCS_PER_FOLDER) {
      fail(
        `docs/${category}/: ${names.length} markdown files exceed the ${MAX_DOCS_PER_FOLDER}-file folder budget`,
      );
    }
    for (const name of names) {
      if (name !== 'README.md' && !CONTENT_FILE_NAME.test(name)) {
        fail(`docs/${category}/${name}: file name must be kebab-case (lowercase words separated by "-")`);
      }
      const file = `docs/${category}/${name}`;
      if (allMarkdown.includes(file)) inScope.push(file);
    }
    categoryFiles.set(category, names);
  }
  inScope.push(DOCS_INDEX, VENDOR_DOC);
  if (inScope.length > MAX_TOTAL_DOCS) {
    fail(`knowledge base: ${inScope.length} active documents exceed the ${MAX_TOTAL_DOCS}-document budget (archive completed features with pnpm docs:archive)`);
  }

  // --- docs/archive/ layout ---------------------------------------------------
  // The archive has no index file by design: the directory listing is the
  // inventory. It may be absent entirely until the first document retires.
  let archiveNames = [];
  try {
    const entries = await readdir(path.join(root, ARCHIVE_DIR), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        fail(`${ARCHIVE_DIR}/${entry.name}/: nested directories are not allowed in the archive`);
      }
    }
    archiveNames = entries
      .filter((entry) => entry.isFile() && isMarkdown(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    // No archive yet: nothing to check.
  }
  const archiveDocs = archiveNames;
  if (archiveDocs.length > MAX_ARCHIVE_DOCS) {
    fail(`docs/archive/: ${archiveDocs.length} archived documents exceed the ${MAX_ARCHIVE_DOCS}-document budget (prune oldest by updated first; git keeps history)`);
  }
  for (const name of archiveDocs) {
    if (!CONTENT_FILE_NAME.test(name)) {
      fail(`docs/archive/${name}: file name must be kebab-case (lowercase words separated by "-"); the archive keeps no index files`);
    }
  }
  const archiveInScope = archiveDocs.map((name) => `${ARCHIVE_DIR}/${name}`);

  // --- Per-document checks ---------------------------------------------------
  const contents = new Map();
  for (const relativePath of [...inScope, ...archiveInScope]) {
    let text;
    try {
      text = await read(relativePath);
    } catch {
      fail(`${relativePath}: file is missing`);
      continue;
    }
    contents.set(relativePath, text);

    let limit = ROOT_DOC_LIMITS.get(relativePath);
    if (!limit && /^docs\/[^/]+\/README\.md$/.test(relativePath)) limit = CATEGORY_README_LIMIT;
    if (!limit && /^docs\/[^/]+\/[^/]+\.md$/.test(relativePath)) limit = CONTENT_DOC_LIMIT;
    if (!limit) {
      fail(`${relativePath}: no documentation budget is defined for this path`);
      continue;
    }
    checkBudget(relativePath, text, limit);

    const isCategoryDoc =
      /^docs\/[^/]+\/[^/]+\.md$/.test(relativePath) && relativePath !== DOCS_INDEX;
    let body = text;
    if (isCategoryDoc) {
      const parsed = parseFrontmatter(relativePath, text);
      body = parsed.body;
      if (parsed.meta) {
        const category = relativePath.split('/')[1];
        const type = parsed.meta.get('type');
        const status = parsed.meta.get('status');
        const updated = parsed.meta.get('updated');
        const isArchivedDoc = relativePath.startsWith(`${ARCHIVE_DIR}/`);
        if (isArchivedDoc) {
          if (![...CATEGORY_TYPES.values()].includes(type)) {
            fail(`${relativePath}: type "${type}" must be one of ${[...CATEGORY_TYPES.values()].join(', ')} (the origin category)`);
          }
          if (status !== 'archived') {
            fail(`${relativePath}: documents in docs/archive/ must carry status: archived`);
          }
        } else {
          const expectedType = CATEGORY_TYPES.get(category);
          if (type !== expectedType) {
            fail(`${relativePath}: type "${type}" must be "${expectedType}" for docs/${category}/`);
          }
          if (!['active', 'draft'].includes(status)) {
            fail(`${relativePath}: status "${status}" must be active or draft (archived documents live in docs/archive/)`);
          }
        }
        if (!validIsoDate(updated)) {
          fail(`${relativePath}: updated "${updated}" must be a real YYYY-MM-DD date`);
        }
      }
    }
    const split = splitFences(body);
    if (split.unclosedFence) fail(`${relativePath}: unclosed code fence`);
    checkHeadings(relativePath, split.body);
    if (KEY_DOCS.has(relativePath)) checkKeyDocumentContent(relativePath, split);
  }

  // --- Frozen archive seals ---------------------------------------------------
  // An archived document is frozen: its sha256 must still match the seal written
  // when it retired. Editing an archived doc (or hand-copying one in) fails here;
  // `pnpm docs:archive` only ever adds seals, never rewrites existing ones.
  if (archiveDocs.length > 0 || (await exists(ARCHIVE_MANIFEST))) {
    let seals = {};
    try {
      seals = JSON.parse(await read(ARCHIVE_MANIFEST)).archived ?? {};
    } catch (error) {
      fail(`${ARCHIVE_MANIFEST}: unreadable seal manifest (${error.message})`);
    }
    const sealed = new Set(Object.keys(seals));
    for (const name of archiveDocs) {
      const file = `${ARCHIVE_DIR}/${name}`;
      if (!sealed.has(name)) {
        fail(`${file}: not sealed in ${ARCHIVE_MANIFEST}; re-run pnpm docs:archive to seal it`);
        continue;
      }
      const text = contents.get(file);
      if (text === undefined) continue;
      if (seals[name].sha256 !== sha256(text)) {
        fail(`${file}: archived content changed since it was sealed (freeze violation); archived documents are immutable — move it back to the active tree if it must change`);
      }
    }
    for (const name of sealed) {
      if (!archiveDocs.includes(name)) {
        fail(`${ARCHIVE_MANIFEST}: seals ${name} but no such archived document exists; drop the stale seal`);
      }
    }
  }

  // --- Index completeness ----------------------------------------------------
  const index = contents.get(DOCS_INDEX) ?? '';
  for (const category of CATEGORY_TYPES.keys()) {
    if (!(await exists(`docs/${category}/README.md`))) continue;
    const categoryIndexPath = `docs/${category}/README.md`;
    if (
      !new RegExp(
        `\\]\\(\\s*(?:\\./)?${escapeRegExp(categoryIndexPath)}(?:\\.md)?(#[^)]*)?\\s*\\)`,
      ).test(index) &&
      !new RegExp(
        `\\]\\(\\s*(?:\\./)?${escapeRegExp(category)}/README\\.md(#[^)]*)?\\s*\\)`,
      ).test(index) &&
      !new RegExp(
        `\\]\\(\\s*(?:\\./)?${escapeRegExp(category)}/README\\.md(#[^)]*)?\\s*\\)`,
      ).test(index)
    ) {
      fail(`${DOCS_INDEX}: index does not link docs/${category}/README.md`);
    }
    const categoryIndex = contents.get(categoryIndexPath) ?? '';
    for (const name of categoryFiles.get(category) ?? []) {
      if (name === 'README.md') continue;
      if (!new RegExp(`\\]\\(\\s*(?:\\./)?${escapeRegExp(name)}(#[^)]*)?\\s*\\)`).test(categoryIndex)) {
        fail(`${categoryIndexPath}: index does not link ${name}`);
      }
    }
  }
  const agents = contents.get('AGENTS.md') ?? '';
  if (!agents.includes('docs/README.md')) {
    fail('AGENTS.md: must point at docs/README.md for the documentation rules');
  }
  if (!agents.includes('pnpm docs:check')) {
    fail('AGENTS.md: must document the "pnpm docs:check" command');
  }
  const readme = contents.get('README.md') ?? '';
  if (!readme.includes('docs/README.md')) {
    fail('README.md: must link docs/README.md');
  }

  // --- Relative link + anchor resolution -------------------------------------
  const targets = [];
  for (const [relativePath, text] of contents) {
    const { body } = splitFences(text.startsWith('---\n') ? text.slice(text.indexOf('\n---\n') + 5) : text);
    collectLinkTargets(relativePath, body, targets);
  }
  const headingCache = new Map();
  const missing = new Set();
  for (const { source, target, fragment } of targets) {
    if (!isInsideRoot(target)) {
      fail(`${source}: link escapes the repository -> ${target}`);
      continue;
    }
    try {
      await stat(target);
    } catch {
      if (!missing.has(target)) {
        missing.add(target);
        fail(`${source}: broken link -> ${relative(target)}`);
      }
      continue;
    }
    const targetRelative = relative(target);
    if (
      targetRelative.startsWith(`${ARCHIVE_DIR}/`) &&
      !source.startsWith(`${ARCHIVE_DIR}/`)
    ) {
      fail(`${source}: active documents must not link archived content -> ${targetRelative}`);
      continue;
    }
    if (!fragment) continue;
    if (!isMarkdown(targetRelative)) continue;
    if (!headingCache.has(targetRelative)) {
      const targetText = contents.get(targetRelative) ?? (await read(targetRelative));
      const targetBody = targetText.startsWith('---\n')
        ? targetText.slice(targetText.indexOf('\n---\n') + 5)
        : targetText;
      const headings = collectHeadings(splitFences(targetBody).body);
      headingCache.set(
        targetRelative,
        new Set(headings.flatMap((heading) => [githubSlug(heading), heading.trim()])),
      );
    }
    let decoded = fragment;
    try {
      decoded = decodeURIComponent(fragment);
    } catch {
      fail(`${source}: malformed link fragment "#${fragment}"`);
      continue;
    }
    const slugs = headingCache.get(targetRelative);
    if (!slugs.has(decoded) && !slugs.has(githubSlug(decoded))) {
      fail(`${source}: link fragment "#${fragment}" not found in ${targetRelative}`);
    }
  }

  // --- Budget pressure report ------------------------------------------------
  const pressured = docs
    .filter(({ lines, bytes, limit }) => lines / limit.lines >= 0.75 || bytes / limit.bytes >= 0.75)
    .sort((a, b) => b.bytes / b.limit.bytes - a.bytes / a.limit.bytes);
  for (const doc of pressured) {
    notes.push(
      `near budget: ${doc.path} (${doc.lines}/${doc.limit.lines} lines, ` +
        `${formatKiB(doc.bytes)}/${formatKiB(doc.limit.bytes)})`,
    );
  }
  // --- Lifecycle notes (eligibility mirrors scripts/docs/archive.mjs) --------
  const toArchive = [];
  const toDelete = [];
  const review = [];
  for (const relativePath of inScope) {
    if (!/^docs\/(specs|designs|research|acceptance)\/[^/]+\.md$/.test(relativePath)) continue;
    if (relativePath.endsWith('/README.md')) continue;
    const parsed = metaOf(contents.get(relativePath) ?? '');
    if (!parsed) continue;
    const type = parsed.meta.get('type');
    const status = parsed.meta.get('status');
    const age = daysSince(parsed.meta.get('updated'));
    if (!Number.isFinite(age)) continue;
    const body = splitFences(parsed.body).body;
    if (status === 'archived') {
      toArchive.push(`${relativePath} (explicit status: archived)`);
    } else if (type === 'research' && age >= RESEARCH_AGE_DAYS) {
      toArchive.push(`${relativePath} (research, ${age} days)`);
    } else if (type === 'acceptance' && age >= ACCEPTANCE_AGE_DAYS && isSettledChecklist(body)) {
      toDelete.push(`${relativePath} (acceptance settled, ${age} days)`);
    }
    if (type === 'design' && age >= DESIGN_REVIEW_AGE_DAYS) {
      review.push(`${relativePath} (design, ${age} days without update)`);
    }
    if (type === 'spec' && status === 'draft' && age >= DRAFT_SPEC_REVIEW_AGE_DAYS) {
      review.push(`${relativePath} (draft spec, ${age} days: reject or promote, never archive)`);
    }
  }
  if (toArchive.length > 0 || toDelete.length > 0) {
    notes.push('retirement due (run pnpm docs:archive):');
    for (const item of toArchive) notes.push(`  archive ${item}`);
    for (const item of toDelete) notes.push(`  delete ${item}`);
  }
  for (const item of review) notes.push(`review for staleness: ${item}`);

  const keyDocs = docs.filter((doc) => KEY_DOCS.has(doc.path));
  for (const doc of keyDocs.sort((a, b) => a.path.localeCompare(b.path))) {
    notes.push(
      `key doc: ${doc.path} (${doc.lines}/${doc.limit.lines} lines, ` +
        `${formatKiB(doc.bytes)}/${formatKiB(doc.limit.bytes)})`,
    );
  }
  notes.push(
    `active knowledge documents: ${inScope.length}/${MAX_TOTAL_DOCS}` +
      ` | folders: ${[...categoryFiles.keys()].length}`,
  );
  if (inScope.length >= TOTAL_DOCS_WARN) {
    notes.push(
      `active total near budget: ${inScope.length}/${MAX_TOTAL_DOCS} (warn at ${TOTAL_DOCS_WARN}); ` +
        'consider pnpm docs:archive',
    );
  }
  notes.push(`archived documents: ${archiveDocs.length}/${MAX_ARCHIVE_DOCS}`);
  for (const [category, names] of categoryFiles) {
    notes.push(`docs/${category}/: ${names.length}/${MAX_DOCS_PER_FOLDER} files`);
  }

  if (failures.length > 0) {
    console.error('FAIL');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log('PASS');
  for (const note of notes) console.log(`- ${note}`);
}

await main();
