#!/usr/bin/env node
/**
 * Legacy document editor performance baseline (F1–F4) for the running DSH GUI.
 *
 * Development-time performance baseline, NOT part of CI: it needs a running DSH
 * GUI (default http://127.0.0.1:51041), the `agent-browser` CLI (headless
 * Chrome) and read access to the Space SQLite database. It drives the real
 * restored legacy editor through the authenticated Space RPC channel:
 *
 *   F1  click document -> editor DOM ready (3 runs, median)
 *   F2  synthetic typing -> p50/p95 key-to-next-frame latency (120 chars)
 *   F3  last input -> document revision visible in SQLite (3 runs)
 *   F4  open -> close 20 times -> forced-GC heap and DOM counters
 *
 * Input is synthesised through CDP key events (trusted browser events, but not
 * a real desktop keyboard/IME); F1 excludes cold app/panel boot because the
 * legacy UI preloads document content via `space.listNodes`. The Host limits
 * "5000 blocks" and "512KiB per document" are independent caps: with real
 * 36-character block ids, 4990 non-empty paragraphs exceed 512KiB, so the
 * temporary document uses 3100 text paragraphs plus 1890 empty paragraphs.
 *
 * The script creates one temporary document through Space RPC unless
 * `--doc-id` is given, and moves it to the trash afterwards (best effort).
 * It never modifies pre-existing documents (a `--doc-id` document IS edited by
 * the F2/F3 typing and is not deleted).
 *
 * Exit codes: 0 measurement completed (budget verdicts are in the JSON),
 * 1 unexpected, 2 usage, 3 GUI/auth, 4 browser/CDP, 5 Space RPC/business failure,
 * 6 Space database, 7 measurement timeout/failure.
 *
 * Usage: node scripts/perf/editor-perf.mjs [options]
 *   --help                print usage
 *   --url <url>           DSH GUI URL (default http://127.0.0.1:51041)
 *   --doc-id <id>         measure an existing document instead of creating one
 *   --cookie <NAME=VALUE> auth cookie; defaults to the Electron cookies DB
 *   --cookies-db <path>   Electron Cookies SQLite path (macOS default below)
 *   --db <path>           Space SQLite path (default <DSH_HOME>/data/space/space.db)
 *   --space-id <id>       Space that owns a temporary document (default: default space)
 *   --out <path>          also write the JSON result to this file
 *   --keep-docs           keep a temporary document (prints its id)
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCRIPT_NAME = 'editor-perf.mjs';
const RESULT_VERSION = 1;
const DEFAULT_URL = 'http://127.0.0.1:51041';

const EXIT = Object.freeze({
  OK: 0,
  UNEXPECTED: 1,
  USAGE: 2,
  CONNECT: 3,
  BROWSER: 4,
  RPC: 5,
  DB: 6,
  MEASURE: 7,
});

/** Document shape: 4990 top-level paragraphs, close to the 512KiB cap. */
const DOC_BLOCKS = 4990;
const DOC_TEXT_BLOCKS = 3100;
const DOC_TEXT_LENGTH = 8;
const MAX_DOCUMENT_BYTES = 512 * 1024;

const F1_RUNS = 3;
const F2_CHARS = 120;
const F2_KEY_INTERVAL_MS = 40;
const F3_RUNS = 3;
const F3_CHARS = 10;
const F3_KEY_INTERVAL_MS = 30;
const F3_DB_POLL_MS = 20;
const F3_SAVE_TIMEOUT_MS = 15000;
const F4_CYCLES = 20;
const F4_GC_SETTLE_MS = 120;

const BUDGETS = Object.freeze({
  f1MedianReadyMs: 3000,
  f2P95Ms: 50,
  f3MedianLatencyMs: 1000,
  f3LongTaskMs: 100,
  f4HeapDeltaPct: 5,
});

const LIMITATIONS = [
  'Development-time baseline only; not part of CI (needs a running GUI, agent-browser and local SQLite).',
  'Synthetic CDP key events at ~25 cps; real desktop input and IME composition are not covered.',
  'F1 measures click -> editor DOM ready with content preloaded by space.listNodes; cold app/panel boot and the Host fetch are excluded.',
  'F3 latency includes the legacy 700ms save debounce and the 20ms SQLite poll granularity.',
  'F4 forces GC in headless Chrome; raw heap peaks are noisy and 20 cycles cannot rule out a very slow leak.',
  '5000 blocks and 512KiB are independent caps; 4990 non-empty paragraphs exceed 512KiB with real block ids, so the temp document mixes text and empty paragraphs.',
];

class MeasureError extends Error {
  constructor(message, exitCode = EXIT.MEASURE, details) {
    super(message);
    this.name = 'MeasureError';
    this.exitCode = exitCode;
    this.details = details;
  }
}

class UsageError extends MeasureError {
  constructor(message) {
    super(message, EXIT.USAGE);
    this.name = 'UsageError';
  }
}

class ConnectError extends MeasureError {
  constructor(message, details) {
    super(message, EXIT.CONNECT, details);
    this.name = 'ConnectError';
  }
}

class BrowserError extends MeasureError {
  constructor(message, details) {
    super(message, EXIT.BROWSER, details);
    this.name = 'BrowserError';
  }
}

class RpcError extends MeasureError {
  constructor(message, code, details) {
    super(message, EXIT.RPC, details);
    this.name = 'RpcError';
    this.rpcCode = code;
  }
}

class DbError extends MeasureError {
  constructor(message, details) {
    super(message, EXIT.DB, details);
    this.name = 'DbError';
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const log = (message) => process.stderr.write(`[${SCRIPT_NAME}] ${message}\n`);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.floor((sorted.length - 1) / 2)];
}

function quantile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))];
}

function round(value, digits = 1) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? null
    : Number(value.toFixed(digits));
}

function failUsage(message) {
  process.stderr.write(`[${SCRIPT_NAME}] ${message}\n`);
  process.stderr.write(`[${SCRIPT_NAME}] run with --help for usage\n`);
  process.exit(EXIT.USAGE);
}

function usage() {
  return `Legacy document editor performance baseline (F1-F4) for the running DSH GUI.

Development-time measurement only (not CI). Creates one temporary near-limit
document through Space RPC unless --doc-id is given, measures F1-F4 through the
real restored editor with headless Chrome via agent-browser, prints JSON to
stdout and moves the temporary document to the trash afterwards.

Usage:
  node scripts/perf/${SCRIPT_NAME} [options]

Options:
  --help                 Show this help.
  --url <url>            DSH GUI URL (default: ${DEFAULT_URL}).
  --doc-id <id>          Measure an existing document instead of creating one.
                         The document is edited by the F2/F3 typing and is not
                         deleted afterwards.
  --cookie <NAME=VALUE>  Auth cookie. Defaults to reading the Electron cookies
                         SQLite database for the matching GUI authority.
  --cookies-db <path>    Electron Cookies SQLite path
                         (default: ~/Library/Application Support/@deepseek-ai/dsh-desktop/Cookies).
  --db <path>            Space SQLite path (default: <DSH_HOME>/data/space/space.db,
                         with DSH_HOME defaulting to ~/.dsh).
  --space-id <id>        Space that owns a temporary document (default: the
                         default Space reported by space.listSpaces).
  --out <path>           Also write the JSON result to this file.
  --keep-docs            Keep the temporary document and print its id.

Environment:
  DSH_HOME               Base data directory used for the default Space DB path.

Requirements:
  - Node.js >= 24 (node:sqlite and global WebSocket).
  - A running DSH GUI with the Space plugin (default ${DEFAULT_URL}).
  - agent-browser CLI with its Chrome installed (used to launch the headless
    measurement browser; a fresh isolated session is created and closed).
  - Read access to the Space SQLite database for the F3 revision polling.

Exit codes:
  0 measurement completed (inspect the "verdicts" field for budget pass/fail),
  1 unexpected, 2 usage, 3 GUI/auth, 4 browser/CDP, 5 Space RPC/business failure,
  6 Space database, 7 measurement timeout/failure.

Measurement contract (see output JSON for the measured values):
  F1 click document -> editor DOM ready, 3 runs, median budget <= 3000ms.
  F2 120 synthetic characters, beforeinput -> next animation frame,
     p95 budget <= 50ms.
  F3 last input -> revision visible in SQLite, 3 runs, median budget <= 1000ms
     with no long task above 100ms in the save window.
  F4 20 open/close cycles, forced GC heap growth budget <= 5% with stable
     DOM counters.

The Host limits "5000 blocks" and "512KiB per document" are independent caps;
the temporary document has ${DOC_BLOCKS} paragraphs (${DOC_TEXT_BLOCKS} with
${DOC_TEXT_LENGTH}-char text, the rest empty) and is verified to be < 512KiB.
`;
}

function parseArgs(argv) {
  const options = {
    url: DEFAULT_URL,
    docId: undefined,
    cookie: undefined,
    cookiesDb: undefined,
    db: undefined,
    spaceId: undefined,
    out: undefined,
    keepDocs: false,
    help: false,
  };
  const takeValue = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`${flag} requires a value`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--url':
        options.url = takeValue(index, arg);
        index += 1;
        break;
      case '--doc-id':
        options.docId = takeValue(index, arg);
        index += 1;
        break;
      case '--cookie':
        options.cookie = takeValue(index, arg);
        index += 1;
        break;
      case '--cookies-db':
        options.cookiesDb = takeValue(index, arg);
        index += 1;
        break;
      case '--db':
        options.db = takeValue(index, arg);
        index += 1;
        break;
      case '--space-id':
        options.spaceId = takeValue(index, arg);
        index += 1;
        break;
      case '--out':
        options.out = takeValue(index, arg);
        index += 1;
        break;
      case '--keep-docs':
        options.keepDocs = true;
        break;
      default:
        throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  if (options.help) return options;
  let parsed;
  try {
    parsed = new URL(options.url);
  } catch {
    throw new UsageError(`invalid --url: ${options.url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UsageError(`--url must be http(s): ${options.url}`);
  }
  options.urlObject = parsed;
  if (options.cookie !== undefined && !options.cookie.includes('=')) {
    throw new UsageError('--cookie must be NAME=VALUE');
  }
  return options;
}

// ---------------------------------------------------------------------------
// Auth cookie resolution (explicit argument or the Electron cookies DB)
// ---------------------------------------------------------------------------

function decodeCookiePayload(value) {
  if (typeof value !== 'string' || !value.startsWith('v1.')) return undefined;
  const parts = value.split('.');
  if (parts.length < 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (typeof payload !== 'object' || payload === null) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

function authorityOf(url) {
  const port = url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80';
  return `${url.hostname}:${port}`;
}

function resolveCookie(options) {
  if (options.cookie !== undefined) {
    const separator = options.cookie.indexOf('=');
    return {
      name: options.cookie.slice(0, separator),
      value: options.cookie.slice(separator + 1),
      source: 'argument',
    };
  }
  const cookiesDb =
    options.cookiesDb ??
    join(
      homedir(),
      'Library',
      'Application Support',
      '@deepseek-ai',
      'dsh-desktop',
      'Cookies',
    );
  if (!existsSync(cookiesDb)) {
    throw new ConnectError(
      `auth cookie not provided and the Electron cookies DB was not found at ${cookiesDb}; pass --cookie NAME=VALUE`,
    );
  }
  let db;
  try {
    db = new DatabaseSync(cookiesDb, { readOnly: true });
  } catch (error) {
    throw new ConnectError(
      `cannot open the Electron cookies DB read-only (${cookiesDb}): ${error.message}; pass --cookie NAME=VALUE`,
    );
  }
  try {
    const authority = authorityOf(options.urlObject);
    // creation_utc can exceed Number.MAX_SAFE_INTEGER, so sort in SQLite and
    // read only the cookie payload columns.
    const rows = db
      .prepare('SELECT name, value FROM cookies ORDER BY creation_utc DESC')
      .all();
    const authorities = new Set();
    for (const row of rows) {
      const payload = decodeCookiePayload(row.value);
      if (payload === undefined) continue;
      if (typeof payload.authority !== 'string') continue;
      authorities.add(payload.authority);
      if (payload.authority === authority) {
        return { name: row.name, value: row.value, source: 'electron-cookies' };
      }
    }
    const known = [...authorities].sort().join(', ') || 'none';
    throw new ConnectError(
      `no Electron cookie for GUI authority ${authority} (known authorities: ${known}); open the DSH GUI or pass --cookie NAME=VALUE`,
    );
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Space RPC client (same envelope as host/rpc.ts createSpaceFetchRoute)
// ---------------------------------------------------------------------------

function createRpcClient(options, cookie) {
  const origin = options.urlObject.origin;
  const endpoint = `${origin}/api/alter-space`;
  const cookieHeader = `${cookie.name}=${cookie.value}`;

  async function rpc(op, args = []) {
    const rpcId = `perf-${randomUUID()}`;
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin,
          cookie: cookieHeader,
        },
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          payload: { op, args },
        }),
        signal: AbortSignal.timeout(60000),
      });
    } catch (error) {
      throw new ConnectError(`cannot reach ${endpoint}: ${error.message}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ConnectError(
        `Space RPC rejected the auth cookie (HTTP ${response.status}); refresh the DSH GUI session or pass --cookie NAME=VALUE`,
      );
    }
    if (!response.ok) {
      throw new RpcError(`Space RPC HTTP ${response.status} for ${op}`);
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new RpcError(`Space RPC returned invalid JSON for ${op}`);
    }
    const result = body?.result;
    if (result === undefined || result === null || result.ok !== true) {
      throw new RpcError(`Space RPC envelope failure for ${op}`);
    }
    const value = result.value;
    if (value !== null && typeof value === 'object' && value.error !== undefined) {
      const error = value.error;
      throw new RpcError(
        `${op} failed: ${error.code}: ${error.message}`,
        typeof error.code === 'string' ? error.code : undefined,
      );
    }
    return value?.value;
  }

  return rpc;
}

// ---------------------------------------------------------------------------
// Space SQLite helpers (F3 revision polling; read-only, live WAL database)
// ---------------------------------------------------------------------------

function defaultSpaceDbPath() {
  const dshHome = process.env.DSH_HOME?.trim();
  const base = dshHome !== undefined && dshHome !== '' ? resolve(dshHome) : join(homedir(), '.dsh');
  return join(base, 'data', 'space', 'space.db');
}

function openSpaceDb(path) {
  if (!existsSync(path)) {
    throw new DbError(
      `Space database not found at ${path}; pass --db <path> or set DSH_HOME`,
    );
  }
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    throw new DbError(`cannot open the Space database read-only (${path}): ${error.message}`);
  }
  const statement = db.prepare('SELECT data FROM nodes WHERE id = ?');
  return {
    readDocument(docId) {
      const row = statement.get(docId);
      if (row === undefined || row === null) return null;
      let node;
      let document;
      try {
        node = JSON.parse(row.data);
        document = JSON.parse(node.content);
      } catch {
        return null;
      }
      return {
        revision: document.revision,
        blocks: Array.isArray(document.blocks) ? document.blocks.length : 0,
        bytes: Buffer.byteLength(node.content, 'utf8'),
      };
    },
    close() {
      db.close();
    },
  };
}

async function waitForRevision(spaceDb, docId, baselineRevision, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = spaceDb.readDocument(docId);
    if (state !== null && state.revision > baselineRevision) {
      return { detectedAt: Date.now(), ...state };
    }
    await sleep(F3_DB_POLL_MS);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Document setup: create the near-limit temporary document, or reuse --doc-id
// ---------------------------------------------------------------------------

function buildDocumentBlocks() {
  const blocks = [];
  for (let index = 0; index < DOC_BLOCKS; index += 1) {
    if (index < DOC_TEXT_BLOCKS) {
      const text = `t${String(index).padStart(DOC_TEXT_LENGTH - 1, '0')}`;
      blocks.push({
        type: 'paragraph',
        attrs: {},
        content: [{ type: 'text', text }],
      });
    } else {
      blocks.push({ type: 'paragraph', attrs: {} });
    }
  }
  return blocks;
}

function pickSpace(spaces, spaceId) {
  if (!Array.isArray(spaces) || spaces.length === 0) {
    throw new RpcError('space.listSpaces returned no Space; create a Space in the GUI first');
  }
  if (spaceId !== undefined) {
    const match = spaces.find((space) => space.id === spaceId);
    if (match === undefined) {
      throw new RpcError(`--space-id ${spaceId} does not exist (known: ${spaces.map((space) => space.id).join(', ')})`);
    }
    return match;
  }
  return spaces.find((space) => space.isDefault === true) ?? spaces[0];
}

async function createTemporaryDocument(rpc, options, trackCreatedDoc) {
  const spaces = await rpc('space.listSpaces');
  const space = pickSpace(spaces, options.spaceId);
  const title = `PERF baseline ${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const node = await rpc('space.createNode', [
    { spaceId: space.id, kind: 'note', title },
  ]);
  if (node === null || typeof node !== 'object' || typeof node.id !== 'string') {
    throw new RpcError('space.createNode returned no document id');
  }
  const docId = node.id;
  trackCreatedDoc(docId);
  const applied = await rpc('doc.applyOps', [
    {
      docId,
      baseRevision: 1,
      ops: [{ op: 'insert_blocks', blocks: buildDocumentBlocks() }],
    },
  ]);
  const snapshot = await rpc('doc.get', [docId]);
  const document = snapshot?.doc;
  if (document === undefined || !Array.isArray(document.blocks)) {
    throw new RpcError('doc.get returned no alter-doc/1 document after creation');
  }
  const bytes = Buffer.byteLength(JSON.stringify(document), 'utf8');
  if (document.blocks.length !== DOC_BLOCKS) {
    throw new RpcError(
      `temporary document has ${document.blocks.length} blocks, expected ${DOC_BLOCKS}`,
    );
  }
  if (bytes >= MAX_DOCUMENT_BYTES) {
    throw new RpcError(
      `temporary document is ${bytes} bytes, which is not below the ${MAX_DOCUMENT_BYTES}-byte limit; adjust DOC_* constants`,
    );
  }
  return {
    docId,
    title,
    titleValue: title,
    spaceId: space.id,
    spaceName: typeof space.name === 'string' ? space.name : '',
    blocks: document.blocks.length,
    bytes,
    revision: typeof applied?.revision === 'number' ? applied.revision : snapshot?.revision,
    created: true,
  };
}

async function resolveExistingDocument(rpc, options) {
  const node = await rpc('space.getNode', [options.docId]);
  if (node === null || typeof node !== 'object') {
    throw new RpcError(`--doc-id ${options.docId} was not found`);
  }
  if (node.deletedAt !== null && node.deletedAt !== undefined) {
    throw new RpcError(`--doc-id ${options.docId} is deleted; restore it first`);
  }
  const spaces = await rpc('space.listSpaces');
  const space = spaces.find((item) => item.id === node.spaceId);
  const snapshot = await rpc('doc.get', [options.docId]);
  const document = snapshot?.doc;
  if (document === undefined || !Array.isArray(document.blocks)) {
    throw new RpcError(`--doc-id ${options.docId} is not an alter-doc/1 document`);
  }
  const bytes = Buffer.byteLength(JSON.stringify(document), 'utf8');
  if (node.archived === true) {
    throw new RpcError(`--doc-id ${options.docId} is archived; unarchive it in the GUI first`);
  }
  const titleValue = typeof node.title === 'string' ? node.title.trim() : '';
  const title = titleValue === '' ? '无标题' : titleValue;
  log(
    `reusing existing document ${options.docId} ("${title}"); F2/F3 typing will edit it and it will not be deleted`,
  );
  return {
    docId: options.docId,
    title,
    titleValue,
    spaceId: node.spaceId,
    spaceName: typeof space?.name === 'string' ? space.name : '',
    blocks: document.blocks.length,
    bytes,
    revision: snapshot?.revision,
    created: false,
  };
}

// ---------------------------------------------------------------------------
// agent-browser wrapper (launches an isolated headless Chrome session)
// ---------------------------------------------------------------------------

function runAgentBrowser(session, args, { allowFailure = false, timeoutMs = 120000 } = {}) {
  const result = spawnSync('agent-browser', ['--session', session, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  if (result.error !== undefined && result.error !== null) {
    if (result.error.code === 'ENOENT') {
      throw new BrowserError(
        'agent-browser CLI is not installed; install it with `npm i -g agent-browser && agent-browser install`',
      );
    }
    throw new BrowserError(`cannot run agent-browser: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) {
    const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
    throw new BrowserError(
      `agent-browser ${args[0] ?? ''} failed with exit code ${result.status}: ${detail}`,
    );
  }
  return result;
}

function detectAgentBrowser() {
  const result = spawnSync('agent-browser', ['--version'], { encoding: 'utf8', timeout: 30000 });
  if (result.error !== undefined && result.error !== null) {
    if (result.error.code === 'ENOENT') {
      throw new BrowserError(
        'agent-browser CLI is not installed; install it with `npm i -g agent-browser && agent-browser install`',
      );
    }
    throw new BrowserError(`cannot run agent-browser: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new BrowserError(`agent-browser --version failed: ${(result.stderr ?? '').trim()}`);
  }
  return (result.stdout ?? '').trim().split('\n')[0] ?? 'unknown';
}

function startBrowser(session, options, cookie) {
  runAgentBrowser(session, ['open']);
  runAgentBrowser(session, ['set', 'viewport', '1280', '577']);
  runAgentBrowser(session, [
    'cookies',
    'set',
    cookie.name,
    cookie.value,
    '--url',
    options.urlObject.href,
    '--path',
    '/',
    '--http-only',
  ]);
  runAgentBrowser(session, ['navigate', options.urlObject.href]);
  const result = runAgentBrowser(session, ['get', 'cdp-url', '--json']);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  try {
    const parsed = JSON.parse((result.stdout ?? '').trim());
    const cdpUrl = parsed?.data?.cdpUrl;
    if (typeof cdpUrl === 'string' && cdpUrl.startsWith('ws://')) return cdpUrl;
  } catch {
    // Fall through to the regex extraction below.
  }
  const match = output.match(/ws:\/\/[^\s"]+/);
  if (match === null) {
    throw new BrowserError('agent-browser did not report a CDP URL');
  }
  return match[0];
}

function closeBrowser(session) {
  runAgentBrowser(session, ['close'], { allowFailure: true, timeoutMs: 30000 });
}

// ---------------------------------------------------------------------------
// Minimal CDP client (Node global WebSocket; no dependencies)
// ---------------------------------------------------------------------------

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.sessionId = null;
    this.ws = new WebSocket(wsUrl);
    this.opened = new Promise((resolveOpen, rejectOpen) => {
      this.ws.addEventListener('open', () => resolveOpen());
      this.ws.addEventListener('error', () => rejectOpen(new BrowserError(`cannot connect to CDP at ${wsUrl}`)));
    });
    this.ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) {
        pending.reject(new BrowserError(`CDP ${pending.method} failed: ${message.error.message}`));
      } else {
        pending.resolve(message.result);
      }
    });
    this.ws.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new BrowserError('CDP connection closed'));
      }
      this.pending.clear();
    });
  }

  async send(method, params = {}, sessionId = this.sessionId) {
    await this.opened;
    const id = this.nextId;
    this.nextId += 1;
    const payload = { id, method, params };
    if (sessionId !== null && sessionId !== undefined) payload.sessionId = sessionId;
    return new Promise((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectSend(new BrowserError(`CDP ${method} timed out`));
      }, 60000);
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend, method, timer });
      this.ws.send(JSON.stringify(payload));
    });
  }

  async attachPage(urlObject) {
    const { targetInfos } = await this.send('Target.getTargets', {}, null);
    const pages = targetInfos.filter((target) => target.type === 'page');
    const page =
      pages.find((target) => typeof target.url === 'string' && target.url.startsWith(urlObject.origin)) ??
      pages.find((target) => typeof target.url === 'string' && !target.url.startsWith('devtools://')) ??
      pages[0];
    if (page === undefined) {
      throw new BrowserError('no browser page target found after navigation');
    }
    const { sessionId } = await this.send(
      'Target.attachToTarget',
      { targetId: page.targetId, flatten: true },
      null,
    );
    this.sessionId = sessionId;
    return page;
  }

  async evaluate(expression, { awaitPromise = false } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails !== undefined && result.exceptionDetails !== null) {
      const detail =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        'unknown evaluation error';
      throw new MeasureError(`page evaluation failed: ${String(detail).slice(0, 500)}`);
    }
    return result.result?.value;
  }

  async browserVersion() {
    return this.send('Browser.getVersion', {}, null);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // Already closed.
    }
  }
}

async function connectCdp(wsUrl, urlObject) {
  const cdp = new CdpClient(wsUrl);
  try {
    await cdp.attachPage(urlObject);
    return cdp;
  } catch (error) {
    cdp.close();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Page-side helpers (run inside the legacy UI)
// ---------------------------------------------------------------------------

async function waitForPage(cdp, expression, { timeoutMs = 30000, intervalMs = 50, label = 'page condition' } = {}) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await cdp.evaluate(expression);
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  const suffix = lastError === undefined ? '' : `; last error: ${lastError.message}`;
  throw new MeasureError(`timed out after ${timeoutMs}ms waiting for ${label}${suffix}`);
}

const titleButtonExpression = (title) => `(() => {
  const wanted = ${JSON.stringify(title)};
  return [...document.querySelectorAll('button')].some(
    (button) => (button.textContent || '').trim() === wanted,
  );
})()`;

async function waitForAppBoot(cdp) {
  await waitForPage(
    cdp,
    `(() => {
      if (document.readyState !== 'complete' && document.readyState !== 'interactive') return false;
      const hasSpacePanelButton = [...document.querySelectorAll('button')].some(
        (button) => (button.textContent || '').trim() === '空间',
      );
      return hasSpacePanelButton && document.body !== null && document.body.innerText.length > 100;
    })()`,
    { timeoutMs: 60000, label: 'DSH GUI to boot' },
  );
}

async function installPageInstrumentation(cdp) {
  await cdp.evaluate(`(() => {
    if (window.__perfInstalled === true) return true;
    window.__perfInstalled = true;
    window.__perf = {
      rpcLog: [],
      applyOpsResponses: [],
      longtasks: [],
      f2: null,
      f3: null,
      lastBeforeInput: null,
      lastKeyDown: null,
    };
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__perf.longtasks.push({
            startTime: entry.startTime,
            duration: entry.duration,
            wall: performance.timeOrigin + entry.startTime,
          });
        }
      }).observe({ entryTypes: ['longtask'] });
    } catch {
      // Long tasks are best effort.
    }
    const originalFetch = window.fetch;
    window.fetch = async function patchedFetch(input, init) {
      let op = null;
      try {
        const body = init !== undefined && init !== null && typeof init.body === 'string'
          ? JSON.parse(init.body)
          : null;
        op = body !== null && typeof body === 'object' ? body.payload?.op : null;
      } catch {
        // Non-JSON fetches are not Space RPC calls.
      }
      const record = {
        op,
        start: performance.now(),
        startWall: Date.now(),
        end: null,
        endWall: null,
        ok: null,
      };
      window.__perf.rpcLog.push(record);
      try {
        const response = await originalFetch.apply(this, arguments);
        record.end = performance.now();
        record.endWall = Date.now();
        record.ok = response.ok;
        if (op === 'doc.applyOps') {
          try {
            window.__perf.applyOpsResponses.push({
              wall: Date.now(),
              text: (await response.clone().text()).slice(0, 2000),
            });
          } catch {
            // Response cloning is best effort.
          }
        }
        return response;
      } catch (error) {
        record.end = performance.now();
        record.endWall = Date.now();
        record.ok = false;
        throw error;
      }
    };
    document.addEventListener('keydown', () => {
      window.__perf.lastKeyDown = performance.now();
    }, true);
    document.addEventListener('beforeinput', () => {
      window.__perf.lastBeforeInput = performance.now();
    }, true);
    document.addEventListener('input', () => {
      const f2 = window.__perf.f2;
      if (f2 !== null) {
        f2.inputs += 1;
        if (f2.firstInputPerf === null) f2.firstInputPerf = performance.now();
        const before = window.__perf.lastBeforeInput;
        const keyDown = window.__perf.lastKeyDown;
        requestAnimationFrame(() => {
          const now = performance.now();
          f2.samples.push({
            d: before === null ? null : now - before,
            dk: keyDown === null ? null : now - keyDown,
          });
        });
      }
      const f3 = window.__perf.f3;
      if (f3 !== null) {
        f3.inputs += 1;
        f3.lastInputWall = Date.now();
        if (f3.firstInputWall === null) f3.firstInputWall = Date.now();
      }
    }, true);
    return true;
  })()`);
}

async function ensureOverview(cdp) {
  const hasEditor = await cdp.evaluate(`document.querySelector('[contenteditable="true"]') !== null`);
  if (!hasEditor) return;
  const clicked = await cdp.evaluate(`(() => {
    const nav = document.querySelector('nav[aria-label="目录层级"]');
    const button = nav === null ? null : nav.querySelector('button');
    if (button === null) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) {
    throw new MeasureError('document is open but the breadcrumb back button was not found');
  }
  await waitForPage(cdp, `document.querySelector('[contenteditable="true"]') === null`, {
    timeoutMs: 15000,
    label: 'editor to close',
  });
  await sleep(150);
}

async function findDocButton(cdp, title) {
  return cdp.evaluate(titleButtonExpression(title));
}

async function ensureSpacePanelVisible(cdp, spaceName, title) {
  let panelClicks = 0;
  let spaceSwitches = 0;
  let closeAttempts = 0;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 45000) {
    if (await findDocButton(cdp, title)) return;
    const hasEditor = await cdp.evaluate(`document.querySelector('[contenteditable="true"]') !== null`);
    if (hasEditor && closeAttempts < 3) {
      closeAttempts += 1;
      await ensureOverview(cdp);
      continue;
    }
    const panelOpen = await cdp.evaluate(
      `document.querySelector('nav[aria-label="空间导航"]') !== null || document.querySelector('[aria-label="空间导航"]') !== null`,
    );
    if (!panelOpen && panelClicks < 3) {
      panelClicks += 1;
      const clicked = await cdp.evaluate(`(() => {
        const button = [...document.querySelectorAll('button')].find(
          (item) => (item.textContent || '').trim() === '空间',
        );
        if (button === undefined) return false;
        button.click();
        return true;
      })()`);
      if (clicked) {
        await sleep(900);
        continue;
      }
    }
    if (panelOpen && spaceName !== '' && spaceSwitches < 2) {
      spaceSwitches += 1;
      const switched = await cdp.evaluate(`(() => {
        const wanted = ${JSON.stringify(spaceName)};
        const buttons = [...document.querySelectorAll('button')];
        const switcher = buttons.find((button) => {
          if ((button.textContent || '').trim() !== wanted) return false;
          const className = typeof button.className === 'string' ? button.className : '';
          return /spaceSwitch|space-switch/i.test(className);
        }) ?? buttons.find((button) => {
          if ((button.textContent || '').trim() !== wanted) return false;
          return button.closest('[role="treeitem"]') === null;
        });
        if (switcher === undefined) return false;
        switcher.click();
        return true;
      })()`);
      if (switched) {
        await sleep(400);
        await cdp.evaluate(`(() => {
          const wanted = ${JSON.stringify(spaceName)};
          const items = [...document.querySelectorAll('[role="menuitem"], button, [role="option"]')];
          const item = items.find((element) => (element.textContent || '').trim() === wanted);
          if (item === undefined) return false;
          item.click();
          return true;
        })()`);
        await sleep(800);
        continue;
      }
    }
    await sleep(300);
  }
  throw new MeasureError(
    `document "${title}" was not found in the Space panel (space "${spaceName || 'unknown'}"); open the Space panel manually or pass --doc-id/--space-id`,
  );
}

async function waitForEditor(cdp, expectedBlocks) {
  const startedAt = Date.now();
  const timeoutMs = 25000;
  while (Date.now() - startedAt < timeoutMs) {
    const state = await cdp.evaluate(`(() => {
      const editor = document.querySelector('[contenteditable="true"]');
      if (editor === null) return null;
      return {
        children: editor.childElementCount,
        textLength: editor.textContent === null ? 0 : editor.textContent.length,
        title: (() => {
          const input = document.querySelector('textarea[aria-label="文档标题"], input[aria-label="文档标题"]');
          return input === null ? null : input.value;
        })(),
      };
    })()`);
    if (state !== null && state.children >= expectedBlocks) return { ...state, fallback: false };
    await sleep(20);
  }
  const fallback = await cdp.evaluate(`(() => {
    const editor = document.querySelector('[contenteditable="true"]');
    if (editor === null) return null;
    return {
      children: editor.childElementCount,
      textLength: editor.textContent === null ? 0 : editor.textContent.length,
      title: (() => {
        const input = document.querySelector('textarea[aria-label="文档标题"], input[aria-label="文档标题"]');
        return input === null ? null : input.value;
      })(),
    };
  })()`);
  if (fallback !== null && fallback.textLength > 0) {
    return { ...fallback, fallback: true };
  }
  throw new MeasureError(
    `editor did not become ready for ${expectedBlocks} blocks within ${timeoutMs}ms`,
  );
}

async function openDocument(cdp, documentInfo) {
  await ensureOverview(cdp);
  const clicked = await cdp.evaluate(`(() => {
    const wanted = ${JSON.stringify(documentInfo.title)};
    const button = [...document.querySelectorAll('button')].find(
      (item) => (item.textContent || '').trim() === wanted,
    );
    if (button === undefined) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) {
    throw new MeasureError(`document button "${documentInfo.title}" disappeared from the panel`);
  }
  const state = await waitForEditor(cdp, documentInfo.blocks);
  if (state.title !== null && state.title !== documentInfo.titleValue) {
    throw new MeasureError(
      `opened document title "${state.title}" does not match expected "${documentInfo.titleValue}"`,
    );
  }
  if (state.fallback) {
    log(
      `warning: editor rendered ${state.children} children for ${documentInfo.blocks} blocks (fallback readiness used)`,
    );
  }
  return state;
}

async function ensureDocumentOpen(cdp, documentInfo) {
  const hasEditor = await cdp.evaluate(`document.querySelector('[contenteditable="true"]') !== null`);
  if (hasEditor) {
    const title = await cdp.evaluate(`(() => {
      const input = document.querySelector('textarea[aria-label="文档标题"], input[aria-label="文档标题"]');
      return input === null ? null : input.value;
    })()`);
    if (title === documentInfo.title) return;
    await ensureOverview(cdp);
  }
  await ensureSpacePanelVisible(cdp, documentInfo.spaceName, documentInfo.title);
  await openDocument(cdp, documentInfo);
}

function placeCaretInFirstBlock() {
  return `(() => {
    const editor = document.querySelector('[contenteditable="true"]');
    if (editor === null) return false;
    const target = editor.querySelector('p') ?? editor.firstElementChild ?? editor;
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    const selection = getSelection();
    if (selection === null) return false;
    selection.removeAllRanges();
    selection.addRange(range);
    editor.focus();
    return document.activeElement === editor;
  })()`;
}

async function dispatchText(cdp, text, intervalMs) {
  for (const character of text) {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      text: character,
      unmodifiedText: character,
      key: character,
    });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: character });
    if (intervalMs > 0) await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// F1: click document -> editor DOM ready
// ---------------------------------------------------------------------------

async function measureLoad(cdp, documentInfo) {
  const runs = [];
  for (let run = 1; run <= F1_RUNS; run += 1) {
    await ensureOverview(cdp);
    const clicked = await cdp.evaluate(`(() => {
      window.__perfOpen = {
        t0: performance.now(),
        first: null,
        ready: null,
        paint: null,
      };
      const check = () => {
        const editor = document.querySelector('[contenteditable="true"]');
        const now = performance.now();
        const state = window.__perfOpen;
        if (editor !== null && state.first === null) state.first = now;
        if (editor !== null && editor.childElementCount >= ${documentInfo.blocks}) {
          if (state.ready === null) {
            state.ready = now;
            requestAnimationFrame(() => {
              state.paint = performance.now();
            });
            return true;
          }
        }
        requestAnimationFrame(check);
        return false;
      };
      requestAnimationFrame(check);
      const wanted = ${JSON.stringify(documentInfo.title)};
      const button = [...document.querySelectorAll('button')].find(
        (item) => (item.textContent || '').trim() === wanted,
      );
      if (button === undefined) return false;
      button.click();
      return true;
    })()`);
    if (!clicked) {
      throw new MeasureError(`document button "${documentInfo.title}" was not found for F1 run ${run}`);
    }
    try {
      await waitForPage(cdp, `window.__perfOpen !== undefined && window.__perfOpen.paint !== null`, {
        timeoutMs: 25000,
        intervalMs: 5,
        label: `F1 run ${run} editor ready`,
      });
    } catch (error) {
      const fallback = await cdp.evaluate(`(() => {
        const editor = document.querySelector('[contenteditable="true"]');
        const state = window.__perfOpen;
        return {
          editorPresent: editor !== null,
          textLength: editor === null ? 0 : (editor.textContent === null ? 0 : editor.textContent.length),
          first: state === undefined ? null : state.first,
          t0: state === undefined ? null : state.t0,
        };
      })()`);
      if (fallback.editorPresent && fallback.textLength > 0 && fallback.first !== null) {
        log(`warning: F1 run ${run} used fallback readiness (editor present with content)`);
        await sleep(100);
        runs.push({
          run,
          firstMs: round(fallback.first - fallback.t0),
          readyMs: round(fallback.first - fallback.t0),
          paintMs: null,
          fallback: true,
        });
        continue;
      }
      throw error;
    }
    await sleep(120);
    const metrics = await cdp.evaluate(`(() => {
      const state = window.__perfOpen;
      const editor = document.querySelector('[contenteditable="true"]');
      return {
        firstMs: state.first === null ? null : state.first - state.t0,
        readyMs: state.ready === null ? null : state.ready - state.t0,
        paintMs: state.paint === null ? null : state.paint - state.t0,
        children: editor === null ? null : editor.childElementCount,
      };
    })()`);
    runs.push({
      run,
      firstMs: round(metrics.firstMs),
      readyMs: round(metrics.readyMs),
      paintMs: round(metrics.paintMs),
      children: metrics.children,
      fallback: false,
    });
    log(`F1 run ${run}: ready ${round(metrics.readyMs)}ms, paint ${round(metrics.paintMs)}ms`);
  }
  const readyValues = runs.map((item) => item.readyMs).filter((value) => value !== null);
  const paintValues = runs.map((item) => item.paintMs).filter((value) => value !== null);
  const medianReadyMs = median(readyValues);
  const medianPaintMs = median(paintValues);
  return {
    runs,
    medianReadyMs,
    medianPaintMs,
    budgetMs: BUDGETS.f1MedianReadyMs,
    pass: medianReadyMs !== null && medianReadyMs <= BUDGETS.f1MedianReadyMs,
  };
}

// ---------------------------------------------------------------------------
// F2: synthetic typing latency
// ---------------------------------------------------------------------------

async function measureInputLatency(cdp, documentInfo) {
  await ensureDocumentOpen(cdp, documentInfo);
  const prepared = await cdp.evaluate(`(() => {
    window.__perf.f2 = {
      samples: [],
      inputs: 0,
      firstInputPerf: null,
      lastInputWall: 0,
    };
    window.__perf.lastBeforeInput = null;
    window.__perf.lastKeyDown = null;
    return ${placeCaretInFirstBlock()};
  })()`);
  if (!prepared) {
    throw new MeasureError('F2 could not place the caret in the editor');
  }
  const characters = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const typing = Array.from({ length: F2_CHARS }, (_, index) => characters[index % characters.length]);
  const startedAt = Date.now();
  await dispatchText(cdp, typing.join(''), F2_KEY_INTERVAL_MS);
  const typingDurationMs = Date.now() - startedAt;
  await sleep(600);
  const raw = await cdp.evaluate(`(() => {
    const f2 = window.__perf.f2;
    const longtasks = window.__perf.longtasks
      .filter((entry) => f2.firstInputPerf !== null && entry.startTime >= f2.firstInputPerf)
      .map((entry) => entry.duration);
    const editor = document.querySelector('[contenteditable="true"]');
    return {
      samples: f2.samples,
      inputs: f2.inputs,
      lastInputWall: f2.lastInputWall,
      firstInputPerf: f2.firstInputPerf,
      longtasks,
      editorChildren: editor === null ? null : editor.childElementCount,
    };
  })()`);
  const latencies = raw.samples.map((sample) => sample.d).filter((value) => Number.isFinite(value));
  const keydownLatencies = raw.samples.map((sample) => sample.dk).filter((value) => Number.isFinite(value));
  const p50Ms = round(quantile(latencies, 0.5));
  const p95Ms = round(quantile(latencies, 0.95));
  return {
    characters: F2_CHARS,
    typingDurationMs,
    events: { inputs: raw.inputs, samples: latencies.length },
    p50Ms,
    p95Ms,
    p99Ms: round(quantile(latencies, 0.99)),
    maxMs: round(latencies.length === 0 ? null : Math.max(...latencies)),
    minMs: round(latencies.length === 0 ? null : Math.min(...latencies)),
    keydownP50Ms: round(quantile(keydownLatencies, 0.5)),
    keydownP95Ms: round(quantile(keydownLatencies, 0.95)),
    longtaskCount: raw.longtasks.length,
    longtaskMaxMs: round(raw.longtasks.length === 0 ? 0 : Math.max(...raw.longtasks)),
    budgetP95Ms: BUDGETS.f2P95Ms,
    pass: p95Ms !== null && p95Ms <= BUDGETS.f2P95Ms,
  };
}

// ---------------------------------------------------------------------------
// F3: last input -> revision visible in SQLite
// ---------------------------------------------------------------------------

function parseApplyOpsError(responses) {
  for (let index = responses.length - 1; index >= 0; index -= 1) {
    const text = responses[index]?.text;
    if (typeof text !== 'string') continue;
    try {
      const body = JSON.parse(text);
      const error = body?.result?.value?.error;
      if (error !== undefined && error !== null) {
        return `${error.code}: ${error.message}`;
      }
    } catch {
      // Not the response we are looking for.
    }
  }
  return undefined;
}

async function waitForSave(cdp, spaceDb, documentInfo, baselineRevision, label) {
  const detected = await waitForRevision(
    spaceDb,
    documentInfo.docId,
    baselineRevision,
    F3_SAVE_TIMEOUT_MS,
  );
  if (detected !== null) return detected;
  const responses = await cdp.evaluate('window.__perf.applyOpsResponses.slice(-3)');
  const error = parseApplyOpsError(responses ?? []);
  throw new MeasureError(
    `${label}: revision did not change within ${F3_SAVE_TIMEOUT_MS}ms${error === undefined ? '' : `; last save error: ${error}`}`,
  );
}

async function measureSaveLatency(cdp, spaceDb, documentInfo) {
  const runs = [];
  for (let run = 1; run <= F3_RUNS; run += 1) {
    await ensureDocumentOpen(cdp, documentInfo);
    const before = spaceDb.readDocument(documentInfo.docId);
    if (before === null) {
      throw new DbError(`document ${documentInfo.docId} is missing from the Space database`);
    }
    const prepared = await cdp.evaluate(`(() => {
      window.__perf.rpcLog = [];
      window.__perf.applyOpsResponses = [];
      window.__perf.f3 = {
        inputs: 0,
        lastInputWall: 0,
        firstInputWall: null,
      };
      window.__perf.longtasks = [];
      return ${placeCaretInFirstBlock()};
    })()`);
    if (!prepared) {
      throw new MeasureError('F3 could not place the caret in the editor');
    }
    const characters = 'abcdefghij';
    await dispatchText(cdp, characters.slice(0, F3_CHARS), F3_KEY_INTERVAL_MS);
    const lastInputWall = await cdp.evaluate('window.__perf.f3.lastInputWall');
    if (typeof lastInputWall !== 'number' || lastInputWall === 0) {
      throw new MeasureError(`F3 run ${run}: no input event reached the editor`);
    }
    const detected = await waitForSave(cdp, spaceDb, documentInfo, before.revision, `F3 run ${run}`);
    await sleep(900);
    const page = await cdp.evaluate(`(() => {
      const applyOps = window.__perf.rpcLog
        .filter((entry) => entry.op === 'doc.applyOps')
        .map((entry) => ({
          startWall: entry.startWall,
          endWall: entry.endWall,
          duration: entry.end === null ? null : entry.end - entry.start,
          ok: entry.ok,
        }));
      const longtasks = window.__perf.longtasks
        .filter((entry) => entry.wall >= window.__perf.f3.lastInputWall - 500)
        .map((entry) => ({
          duration: entry.duration,
          relativeToLastInputMs: Math.round(entry.wall - window.__perf.f3.lastInputWall),
        }));
      return { applyOps, longtasks };
    })()`);
    const applyOps = page.applyOps[0] ?? null;
    const longtasks = page.longtasks;
    runs.push({
      run,
      revisionBefore: before.revision,
      revisionAfter: detected.revision,
      blocksAfter: detected.blocks,
      bytesBefore: before.bytes,
      bytesAfter: detected.bytes,
      latencyMs: detected.detectedAt - lastInputWall,
      breakdown: applyOps === null
        ? null
        : {
            lastInputToApplyOpsRequestMs: applyOps.startWall - lastInputWall,
            applyOpsRpcMs: round(applyOps.duration),
            applyOpsRequestToDetectMs: detected.detectedAt - applyOps.startWall,
          },
      applyOpsOk: applyOps === null ? null : applyOps.ok,
      longtasks,
      longtaskMaxMs: round(longtasks.length === 0 ? 0 : Math.max(...longtasks.map((item) => item.duration))),
      longtasksOver100: longtasks.filter((item) => item.duration > BUDGETS.f3LongTaskMs).length,
    });
    log(`F3 run ${run}: ${runs.at(-1).latencyMs}ms (revision ${before.revision} -> ${detected.revision})`);
  }
  const latencies = runs.map((item) => item.latencyMs);
  const medianLatencyMs = median(latencies);
  const maxLongTaskMs = runs.length === 0 ? 0 : Math.max(...runs.map((item) => item.longtaskMaxMs));
  const longTasksOverBudget = runs.reduce((total, item) => total + item.longtasksOver100, 0);
  return {
    runs,
    medianLatencyMs,
    maxLongTaskMs,
    longTasksOverBudget,
    pollIntervalMs: F3_DB_POLL_MS,
    budgetLatencyMs: BUDGETS.f3MedianLatencyMs,
    budgetLongTaskMs: BUDGETS.f3LongTaskMs,
    pass:
      medianLatencyMs !== null &&
      medianLatencyMs <= BUDGETS.f3MedianLatencyMs &&
      longTasksOverBudget === 0,
  };
}

// ---------------------------------------------------------------------------
// F4: open/close cycles with forced GC
// ---------------------------------------------------------------------------

async function collectMemorySnapshot(cdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  await sleep(F4_GC_SETTLE_MS);
  const heap = await cdp.send('Runtime.getHeapUsage');
  const dom = await cdp.send('Memory.getDOMCounters');
  const performanceMemory = await cdp.evaluate(
    `performance.memory === undefined ? null : { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize }`,
  );
  return {
    heapUsed: typeof heap?.usedSize === 'number' ? heap.usedSize : null,
    heapTotal: typeof heap?.totalSize === 'number' ? heap.totalSize : null,
    dom: {
      documents: typeof dom?.documents === 'number' ? dom.documents : null,
      nodes: typeof dom?.nodes === 'number' ? dom.nodes : null,
      jsEventListeners: typeof dom?.jsEventListeners === 'number' ? dom.jsEventListeners : null,
    },
    performanceMemory,
  };
}

function linearSlope(values) {
  if (values.length < 2) return null;
  const count = values.length;
  const meanX = (count - 1) / 2;
  const meanY = values.reduce((total, value) => total + value, 0) / count;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < count; index += 1) {
    numerator += (index - meanX) * (values[index] - meanY);
    denominator += (index - meanX) ** 2;
  }
  return denominator === 0 ? null : numerator / denominator;
}

async function measureMemory(cdp, documentInfo) {
  await cdp.send('HeapProfiler.enable');
  await cdp.send('Runtime.enable');
  await ensureOverview(cdp);
  const baseline = await collectMemorySnapshot(cdp);
  const cycles = [];
  for (let cycle = 1; cycle <= F4_CYCLES; cycle += 1) {
    await ensureOverview(cdp);
    const openedAt = Date.now();
    await openDocument(cdp, documentInfo);
    const openMs = Date.now() - openedAt;
    const rawHeapAfterOpen = await cdp.evaluate(
      `performance.memory === undefined ? null : performance.memory.usedJSHeapSize`,
    );
    await ensureOverview(cdp);
    const closeMs = Date.now() - openedAt - openMs;
    const snapshot = await collectMemorySnapshot(cdp);
    cycles.push({
      cycle,
      openMs,
      closeMs,
      rawHeapAfterOpen,
      heapUsed: snapshot.heapUsed,
      heapTotal: snapshot.heapTotal,
      dom: snapshot.dom,
      performanceMemory: snapshot.performanceMemory,
    });
    if (cycle % 5 === 0) {
      log(`F4 cycle ${cycle}: heapUsed ${snapshot.heapUsed} bytes, nodes ${snapshot.dom.nodes}`);
    }
  }
  const heapValues = cycles.map((item) => item.heapUsed).filter((value) => value !== null);
  const firstHeapUsed = heapValues.length === 0 ? null : heapValues[0];
  const lastHeapUsed = heapValues.length === 0 ? null : heapValues.at(-1);
  const peakHeapUsed = heapValues.length === 0 ? null : Math.max(...heapValues);
  const deltaBytes = firstHeapUsed === null || lastHeapUsed === null ? null : lastHeapUsed - firstHeapUsed;
  const deltaPct = firstHeapUsed === null || deltaBytes === null || firstHeapUsed === 0
    ? null
    : (deltaBytes / firstHeapUsed) * 100;
  const domCountersStable = cycles.every(
    (item) =>
      item.dom.documents === cycles[0].dom.documents &&
      item.dom.nodes === cycles[0].dom.nodes &&
      item.dom.jsEventListeners === cycles[0].dom.jsEventListeners,
  );
  const rawHeapValues = cycles
    .map((item) => item.rawHeapAfterOpen)
    .filter((value) => typeof value === 'number');
  return {
    cycles,
    baseline,
    firstHeapUsed,
    lastHeapUsed,
    peakHeapUsed,
    deltaBytes,
    deltaPct: round(deltaPct, 2),
    slopeBytesPerCycle: round(linearSlope(heapValues), 0),
    domCountersStable,
    domCounters: cycles[0]?.dom ?? null,
    rawHeapAfterOpen: {
      first: rawHeapValues[0] ?? null,
      last: rawHeapValues.at(-1) ?? null,
      min: rawHeapValues.length === 0 ? null : Math.min(...rawHeapValues),
      max: rawHeapValues.length === 0 ? null : Math.max(...rawHeapValues),
    },
    budgetDeltaPct: BUDGETS.f4HeapDeltaPct,
    pass:
      deltaPct !== null &&
      Math.abs(deltaPct) <= BUDGETS.f4HeapDeltaPct &&
      domCountersStable,
  };
}

// ---------------------------------------------------------------------------
// Measurement orchestration
// ---------------------------------------------------------------------------

async function collectEnvironment(cdp, options, agentBrowserVersion) {
  const version = await cdp.browserVersion();
  const page = await cdp.evaluate(`({
    userAgent: navigator.userAgent,
    width: innerWidth,
    height: innerHeight,
    devicePixelRatio: devicePixelRatio,
    visibility: document.visibilityState,
    timeOrigin: performance.timeOrigin,
  })`);
  return {
    url: options.urlObject.href,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    agentBrowser: agentBrowserVersion,
    browser: version?.product ?? 'unknown',
    protocolVersion: version?.protocolVersion ?? null,
    headless: /HeadlessChrome/i.test(page.userAgent),
    viewport: {
      width: page.width,
      height: page.height,
      devicePixelRatio: page.devicePixelRatio,
    },
    visibility: page.visibility,
    timeOrigin: page.timeOrigin,
  };
}

async function run(options) {
  const result = {
    script: SCRIPT_NAME,
    version: RESULT_VERSION,
    startedAt: new Date().toISOString(),
    options: {
      url: options.urlObject.href,
      docId: options.docId ?? null,
      keepDocs: options.keepDocs,
    },
    environment: null,
    document: null,
    budgets: { ...BUDGETS },
    f1: null,
    f2: null,
    f3: null,
    f4: null,
    verdicts: null,
    limitations: [...LIMITATIONS],
    cleanup: null,
  };
  const session = `measure-perf-${process.pid}-${randomUUID().slice(0, 8)}`;
  let rpc;
  let spaceDb;
  let cdp;
  let browserStarted = false;
  let createdDocId = null;
  const cleanup = {
    createdDocIds: [],
    deletedTempDocs: [],
    leftoverDocIds: [],
    existingDocEdited: options.docId !== undefined,
  };
  try {
    const agentBrowserVersion = detectAgentBrowser();
    log(`agent-browser: ${agentBrowserVersion}`);
    const cookie = resolveCookie(options);
    log(`auth cookie: ${cookie.name} (${cookie.source})`);
    rpc = createRpcClient(options, cookie);
    spaceDb = openSpaceDb(options.db ?? defaultSpaceDbPath());
    const spaces = await rpc('space.listSpaces');
    log(`connected to ${options.urlObject.origin} (${spaces.length} Space)`);
    const trackCreatedDoc = (docId) => {
      createdDocId = docId;
      cleanup.createdDocIds.push(docId);
    };
    const documentInfo =
      options.docId === undefined
        ? await createTemporaryDocument(rpc, options, trackCreatedDoc)
        : await resolveExistingDocument(rpc, options);
    result.document = {
      ...documentInfo,
      spec: `${DOC_BLOCKS} top-level paragraphs (${DOC_TEXT_BLOCKS} text, ${DOC_BLOCKS - DOC_TEXT_BLOCKS} empty), verified < 512KiB`,
    };
    log(
      `document ${documentInfo.docId}: ${documentInfo.blocks} blocks, ${documentInfo.bytes} bytes (${round(documentInfo.bytes / 1024)} KiB)`,
    );

    // Mark the session as started before launching: a partial failure inside
    // startBrowser must still close whatever agent-browser may have spawned.
    browserStarted = true;
    const cdpUrl = startBrowser(session, options, cookie);
    cdp = await connectCdp(cdpUrl, options.urlObject);
    result.environment = await collectEnvironment(cdp, options, agentBrowserVersion);
    log(
      `browser: ${result.environment.browser} (headless: ${result.environment.headless}, viewport ${result.environment.viewport.width}x${result.environment.viewport.height})`,
    );
    await waitForAppBoot(cdp);
    await installPageInstrumentation(cdp);
    await ensureSpacePanelVisible(cdp, documentInfo.spaceName, documentInfo.title);

    log('F1: measuring document load (3 runs)');
    result.f1 = await measureLoad(cdp, documentInfo);
    log('F2: measuring input latency (120 chars)');
    result.f2 = await measureInputLatency(cdp, documentInfo);
    const f2Baseline = spaceDb.readDocument(documentInfo.docId);
    if (f2Baseline !== null) {
      log(`F2 save: waiting for the debounced save after the typing burst (base revision ${f2Baseline.revision})`);
      await waitForSave(cdp, spaceDb, documentInfo, f2Baseline.revision, 'F2');
    }
    log('F3: measuring save latency (3 runs)');
    result.f3 = await measureSaveLatency(cdp, spaceDb, documentInfo);
    log('F4: measuring memory across 20 open/close cycles');
    result.f4 = await measureMemory(cdp, documentInfo);
    result.verdicts = {
      f1: result.f1.pass,
      f2: result.f2.pass,
      f3: result.f3.pass,
      f4: result.f4.pass,
      all: result.f1.pass && result.f2.pass && result.f3.pass && result.f4.pass,
    };
    await ensureOverview(cdp);
  } finally {
    if (createdDocId !== null && !options.keepDocs) {
      try {
        await rpc('space.deleteNode', [createdDocId]);
        cleanup.deletedTempDocs.push(createdDocId);
        log(`cleanup: moved temporary document ${createdDocId} to the trash`);
      } catch (error) {
        cleanup.leftoverDocIds.push(createdDocId);
        log(
          `cleanup: could not delete temporary document ${createdDocId} (${error.message}); delete it manually`,
        );
      }
    } else if (createdDocId !== null) {
      cleanup.leftoverDocIds.push(createdDocId);
      log(`cleanup: kept temporary document ${createdDocId} (--keep-docs)`);
    }
    if (cdp !== undefined) cdp.close();
    if (browserStarted) closeBrowser(session);
    if (spaceDb !== undefined) spaceDb.close();
    result.cleanup = cleanup;
    result.finishedAt = new Date().toISOString();
    result.durationMs = Date.parse(result.finishedAt) - Date.parse(result.startedAt);
  }
  return result;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) failUsage(error.message);
    throw error;
  }
  if (options.help) {
    process.stdout.write(usage());
    return EXIT.OK;
  }
  try {
    const result = await run(options);
    const json = `${JSON.stringify(result, null, 2)}\n`;
    process.stdout.write(json);
    if (options.out !== undefined) {
      writeFileSync(options.out, json);
      log(`result written to ${options.out}`);
    }
    if (result.cleanup.leftoverDocIds.length > 0) {
      log(
        `leftover test documents: ${result.cleanup.leftoverDocIds.join(', ')}; delete them manually`,
      );
    }
    return EXIT.OK;
  } catch (error) {
    if (error instanceof MeasureError) {
      log(`error: ${error.message}`);
      if (error.details !== undefined) {
        log(`details: ${JSON.stringify(error.details)}`);
      }
      return error.exitCode;
    }
    log(`unexpected error: ${error?.stack ?? String(error)}`);
    return EXIT.UNEXPECTED;
  }
}

process.exitCode = await main();
