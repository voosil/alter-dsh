#!/usr/bin/env node
/**
 * Lifecycle executor for the Alter-dsh knowledge base.
 *
 * The rules live in docs/README.md ("生命周期与自动归档"). This script retires
 * documents that are done with the active tree:
 *
 * - **archive** (`research`, or any document explicitly marked
 *   `status: archived`): move it to docs/archive/, flip `status`, insert an
 *   `Archived:` date under it, and seal its sha256 in
 *   `docs/archive/manifest.json`. Archived documents are frozen; this script
 *   only ever adds seals and fails if an existing seal no longer matches.
 * - **delete** (`acceptance` that settled on schedule): a one-time verification
 *   record has no ongoing authority, so it leaves the tree rather than becoming
 *   archive clutter. Git keeps the history.
 *
 * The archive deliberately has NO index file: the directory listing is the
 * inventory. Nothing here runs automatically except as part of `pnpm check`.
 *
 * specs and designs are never retired by age: a spec is authority until it is
 * superseded, and a design records a decision that is still being lived with.
 *
 * A document still referenced by an active document (outside its own category
 * index, which this script maintains) is skipped until the reference is fixed.
 *
 * Usage: node scripts/docs/archive.mjs [--dry-run]
 */
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
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
const ARCHIVE_DIR = 'docs/archive';
const ARCHIVE_MANIFEST = 'docs/archive/manifest.json';
const RESEARCH_AGE_DAYS = 90;
const ACCEPTANCE_AGE_DAYS = 60;
const DAY_MS = 86_400_000;
const DRY_RUN = process.argv.includes('--dry-run');

const relative = (absolute) => path.relative(root, absolute).split(path.sep).join('/');
const read = (relativePath) => readFile(path.join(root, relativePath), 'utf8');
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Today as a UTC calendar date, so day math matches frontmatter dates. */
const todayUtc = Date.parse(new Date().toISOString().slice(0, 10));
const daysSince = (updated) => Math.floor((todayUtc - Date.parse(updated)) / DAY_MS);

function parseFrontmatter(text) {
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

/** Remove fenced blocks so sample code never counts as content. */
function withoutFences(text) {
  const lines = text.split('\n');
  const body = [];
  let open = null;
  for (const line of lines) {
    if (open === null) {
      const start = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (start) {
        open = { marker: start[1][0], length: start[1].length };
        continue;
      }
      body.push(line);
    } else {
      const end = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (end && end[1][0] === open.marker && end[1].length >= open.length) open = null;
    }
  }
  return body.join('\n');
}

/** An acceptance checklist is settled when no item is open or half-done. */
function isSettled(body) {
  const text = withoutFences(body).replace(/`[^`\n]*`/g, '');
  return !/^ *- \[( |~)\]/m.test(text);
}

/** Relative link targets of one markdown document (fences/inline code ignored). */
function linkTargets(relativePath, body) {
  const text = withoutFences(body).replace(/`[^`\n]*`/g, '');
  const targets = [];
  for (const match of text.matchAll(/\[[^\]]*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+["'(][^)]*)?\)/g)) {
    targets.push(match[1].replace(/^<|>$/g, ''));
  }
  const resolved = [];
  for (const raw of targets) {
    if (/^(https?:|mailto:|tel:|#|space-asset:)/i.test(raw)) continue;
    const [target] = raw.split('#');
    if (!target) continue;
    const absolute = target.startsWith('/')
      ? path.resolve(root, `.${target}`)
      : path.resolve(path.dirname(path.join(root, relativePath)), target);
    resolved.push(relative(absolute));
  }
  return resolved;
}

async function markdownFiles(dir) {
  try {
    const entries = await readdir(path.join(root, dir), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
      .map((entry) => `${dir}/${entry.name}`)
      .sort();
  } catch {
    return [];
  }
}

async function loadDoc(relativePath) {
  const text = await read(relativePath);
  const parsed = parseFrontmatter(text);
  return { path: relativePath, text, meta: parsed?.meta ?? new Map(), body: parsed?.body ?? text };
}

/**
 * What retirement this document is due now, if any.
 * `archive` freezes it under docs/archive/; `delete` drops it from the tree.
 */
function trigger(doc) {
  const status = doc.meta.get('status');
  const type = doc.meta.get('type');
  const updated = doc.meta.get('updated');
  if (status === 'archived') return { action: 'archive', reason: 'explicit status: archived' };
  const age = daysSince(updated);
  if (!Number.isFinite(age)) return null;
  if (type === 'research' && age >= RESEARCH_AGE_DAYS) {
    return {
      action: 'archive',
      reason: `research, ${age} days without update (>= ${RESEARCH_AGE_DAYS})`,
    };
  }
  if (type === 'acceptance' && age >= ACCEPTANCE_AGE_DAYS && isSettled(doc.body)) {
    return {
      action: 'delete',
      reason: `acceptance settled, ${age} days without update (>= ${ACCEPTANCE_AGE_DAYS})`,
    };
  }
  return null;
}

/**
 * Rewrite a document for the archive: flip `status` and insert `Archived:` under
 * it. Every other byte stays as it was, so the frozen copy is verifiably the
 * document that retired.
 */
function sealText(text, today) {
  const end = text.indexOf('\n---\n', 3);
  if (!text.startsWith('---\n') || end < 0) throw new Error('missing frontmatter');
  const head = text
    .slice(4, end)
    .split('\n')
    .map((line) => (/^status:\s*/.test(line) ? 'status: archived' : line))
    .join('\n');
  return `---\n${head}\narchived: ${today}\n---\n${text.slice(end + 5)}`;
}

/** Load the seal manifest, or start an empty one. */
async function loadManifest() {
  try {
    const parsed = JSON.parse(await read(ARCHIVE_MANIFEST));
    return { version: 1, archived: parsed.archived ?? {} };
  } catch {
    return { version: 1, archived: {} };
  }
}

function renderManifest(manifest) {
  const names = Object.keys(manifest.archived).sort();
  const archived = Object.fromEntries(names.map((name) => [name, manifest.archived[name]]));
  return `${JSON.stringify({ version: 1, archived }, null, 2)}\n`;
}

async function main() {
  const active = [];
  for (const category of CATEGORY_TYPES.keys()) {
    for (const file of await markdownFiles(`docs/${category}`)) {
      if (file.endsWith('/README.md')) continue;
      active.push(await loadDoc(file));
    }
  }
  const archived = [];
  for (const file of await markdownFiles(ARCHIVE_DIR)) {
    archived.push(await loadDoc(file));
  }

  const eligible = active
    .map((doc) => ({ doc, trigger: trigger(doc) }))
    .filter((item) => item.trigger !== null);
  if (eligible.length === 0) {
    console.log('NOTHING TO RETIRE');
    console.log('- specs/designs 只按显式决策归档；research/acceptance 未到期或清单未落定。');
    return;
  }

  // Referrers that stay active: key docs, other category indexes, and every
  // active doc that is not itself being retired in this run.
  const eligiblePaths = new Set(eligible.map(({ doc }) => doc.path));
  const referrerFiles = [
    'AGENTS.md',
    'README.md',
    'docs/README.md',
    'vendor/README.md',
    ...[...CATEGORY_TYPES.keys()].map((category) => `docs/${category}/README.md`),
    ...active.filter((doc) => !eligiblePaths.has(doc.path)).map((doc) => doc.path),
  ];
  const referrers = [];
  for (const file of referrerFiles) {
    const doc = await loadDoc(file);
    referrers.push({ path: file, targets: new Set(linkTargets(file, doc.body)) });
  }

  const manifest = await loadManifest();
  // A frozen seal that no longer matches means someone edited the archive.
  // Refuse to proceed rather than silently re-sealing over the change.
  const rehash = [];
  for (const doc of archived) {
    const name = path.posix.basename(doc.path);
    const seal = manifest.archived[name];
    const actual = sha256(doc.text);
    if (seal === undefined) {
      rehash.push(`${doc.path}: unsealed; run pnpm docs:archive again to seal it`);
    } else if (seal.sha256 !== actual) {
      rehash.push(
        `${doc.path}: archived content changed since it was sealed (${seal.sha256.slice(0, 12)} != ${actual.slice(0, 12)}); archived documents are frozen — restore it from git or move it back to the active tree`,
      );
    }
  }
  if (rehash.length > 0) {
    console.error('ARCHIVE IS FROZEN');
    for (const line of rehash) console.error(`- ${line}`);
    process.exit(1);
  }

  const today = new Date().toISOString().slice(0, 10);
  const retired = [];
  const skipped = [];
  for (const { doc, trigger: due } of eligible) {
    const name = path.posix.basename(doc.path);
    const category = doc.path.split('/')[1];
    const ownIndex = `docs/${category}/README.md`;
    const inbound = referrers.filter(
      (referrer) => referrer.path !== ownIndex && referrer.targets.has(doc.path),
    );
    if (inbound.length > 0) {
      skipped.push(`${doc.path}: still referenced by ${inbound.map((r) => r.path).join(', ')}`);
      continue;
    }
    const target = `${ARCHIVE_DIR}/${name}`;
    if (due.action === 'archive' && archived.some((item) => item.path === target)) {
      skipped.push(`${doc.path}: archive already contains ${target}`);
      continue;
    }
    const archivedText = due.action === 'archive' ? sealText(doc.text, today) : null;
    if (!DRY_RUN) {
      if (archivedText !== null) {
        await mkdir(path.join(root, ARCHIVE_DIR), { recursive: true });
        await writeFile(path.join(root, target), archivedText, 'utf8');
        manifest.archived[name] = { sha256: sha256(archivedText), archivedAt: today };
      }
      await unlink(path.join(root, doc.path));
      const indexText = await read(ownIndex);
      const cleaned = indexText
        .split('\n')
        .filter((line) => !line.includes(`](${name})`) && !line.includes(`](./${name})`))
        .join('\n');
      await writeFile(path.join(root, ownIndex), cleaned, 'utf8');
    }
    retired.push({ doc, action: due.action, target, reason: due.reason });
    if (archivedText !== null) archived.push({ ...doc, path: target, text: archivedText });
  }

  if (!DRY_RUN && retired.some((item) => item.action === 'archive')) {
    await mkdir(path.join(root, ARCHIVE_DIR), { recursive: true });
    await writeFile(path.join(root, ARCHIVE_MANIFEST), renderManifest(manifest), 'utf8');
  }

  console.log(DRY_RUN ? 'DRY RUN' : 'RETIRED');
  for (const { doc, action, target, reason } of retired) {
    console.log(
      action === 'archive'
        ? `- archived ${doc.path} -> ${target} (${reason})`
        : `- deleted ${doc.path} (${reason}; a one-time record, git keeps the history)`,
    );
  }
  for (const line of skipped) console.log(`- skipped ${line}`);
  if (retired.length > 0) {
    console.log(
      DRY_RUN
        ? '- 预览不改动文件；去掉 --dry-run 执行。'
        : '- 已从分类索引移除并更新封印清单。运行 pnpm docs:check 验证。',
    );
  }
}

await main();
