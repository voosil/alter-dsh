/**
 * G2 — seeded random Document-Operation sequences against the real Host service.
 *
 * The editor turns arbitrary user edits into Operation batches; this suite
 * fuzzes that contract end to end: a seeded PRNG generates batches of every v0
 * operation, the real `DocumentService` (SQLite-backed, temporary store) applies
 * them, and every accepted batch must leave a schema-valid document with unique
 * block ids and a monotonic revision. `undo` must reproduce the previous tree.
 *
 * Failures are reported with the deterministic seed, sequence and batch number,
 * so any counterexample is reproducible by rerunning the same seed.
 *
 * @vitest-environment node
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyOperations } from '../../../host/document/ast/operations.js';
import { parseMarkdownBlocks } from '../../../host/document/editors/legacy/markdown.js';
import {
  NODE_TYPES,
  createBlockNode,
  operationAllowedOn,
  plainTextOfBlock,
  type NodeTypeDefinition,
} from '../../../host/document/ast/schema.js';
import {
  createDocumentService,
  type DocumentService,
} from '../../../host/document/editors/legacy/service.js';
import {
  DocumentError,
  MAX_OPERATION_BATCH,
  type AlterDoc,
  type BlockNode,
  type InlineNode,
  type JsonValue,
  type Mark,
  type MarkType,
  type Operation,
  type OperationContext,
} from '../../../host/document/editors/legacy/types.js';
import {
  DEFAULT_SPACE_ID,
  openSpaceStore,
  type SpaceStoreHandle,
} from '../../../host/persistence/store.js';
import { assertValidDocument } from '../../support/ast-checks.js';
import { runFuzz } from '../../support/fuzz-runner.js';

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32)
// ---------------------------------------------------------------------------

interface Rng {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
}

function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    int(min, max) {
      if (max < min) return min;
      return min + Math.floor(next() * (max - min + 1));
    },
    pick(items) {
      return items[Math.floor(next() * items.length)]!;
    },
    chance(probability) {
      return next() < probability;
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures and block generation
// ---------------------------------------------------------------------------

const WORDS = [
  'token',
  '刷新',
  '策略',
  '鉴权',
  '段落',
  '标题',
  '协作',
  '计划',
  'alpha',
  'beta',
] as const;
const TONES = ['info', 'warn', 'success', 'danger'] as const;
const LANGS = ['ts', 'js', 'md'] as const;
const ASSET_IDS = ['asset_fuzz_1', 'asset_fuzz_2'] as const;
const SEED_OBJECT_IDS = ['obj_fuzz_seed_1', 'obj_fuzz_seed_2'] as const;
const MARK_POOL: readonly MarkType[] = [
  'bold',
  'italic',
  'underline',
  'strike',
  'code',
  'highlight',
];
const ROOT_BLOCK_TYPES = [
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'taskList',
  'blockquote',
  'codeBlock',
  'divider',
  'table',
  'image',
  'file',
  'bookmark',
  'docLink',
  'callout',
  'mindmap',
  'component',
] as const;

const MARKDOWN_SAMPLES = [
  '新增段落内容\n',
  '# 随机标题\n',
  '- 列表项一\n- 列表项二\n',
  '> 引用内容\n',
  '```ts\nconst value = 1;\n```\n',
  '---\n',
  ':::callout{tone="info" title="随机"}\n内容\n:::\n',
  '| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n',
] as const;

/** Allocate unique candidate ids for one sequence/batch/operation. */
class IdAlloc {
  private blockSeq = 0;
  private objectSeq = 0;

  constructor(private readonly tag: string) {}

  blockId(): string {
    this.blockSeq += 1;
    return `blk_${this.tag}_${this.blockSeq}`;
  }

  objectId(): string {
    this.objectSeq += 1;
    return `obj_${this.tag}_${this.objectSeq}`;
  }
}

function makeInline(rng: Rng, withMarks = true): InlineNode[] {
  const runs: InlineNode[] = [];
  const count = rng.int(1, 2);
  for (let index = 0; index < count; index += 1) {
    const text = `${rng.pick(WORDS)}${rng.int(0, 999)}`;
    const marks: Mark[] = [];
    if (withMarks && rng.chance(0.5)) {
      const markCount = rng.int(1, 2);
      const chosen = new Set<MarkType>();
      for (let markIndex = 0; markIndex < markCount; markIndex += 1) {
        const type = rng.pick(MARK_POOL);
        if (chosen.has(type)) continue;
        chosen.add(type);
        marks.push({ type });
      }
    }
    if (withMarks && rng.chance(0.1)) marks.push({ type: 'link', attrs: { href: 'https://example.com/x' } });
    runs.push(
      marks.length === 0
        ? { type: 'text', text }
        : { type: 'text', text, marks },
    );
  }
  return runs;
}

function randomBlock(
  rng: Rng,
  type: string,
  id: string,
  alloc: IdAlloc,
): BlockNode {
  switch (type) {
    case 'paragraph':
      return createBlockNode(id, type, { content: makeInline(rng) });
    case 'heading':
      return createBlockNode(id, type, {
        attrs: { level: rng.int(1, 6) },
        content: makeInline(rng),
      });
    case 'bulletList':
    case 'orderedList':
    case 'taskList': {
      const items = Array.from({ length: rng.int(1, 2) }, () =>
        randomBlock(rng, 'listItem', alloc.blockId(), alloc),
      );
      return createBlockNode(id, type, {
        ...(type === 'orderedList' ? { attrs: { start: rng.int(1, 9) } } : {}),
        children: items,
      });
    }
    case 'listItem':
      return createBlockNode(id, type, {
        ...(rng.chance(0.3) ? { attrs: { checked: rng.chance(0.5) } } : {}),
        children: [
          randomBlock(rng, 'paragraph', alloc.blockId(), alloc),
        ],
      });
    case 'blockquote':
      return createBlockNode(id, type, {
        children: [randomBlock(rng, 'paragraph', alloc.blockId(), alloc)],
      });
    case 'codeBlock':
      return createBlockNode(id, type, {
        attrs: { lang: rng.pick(LANGS) },
        content: [{ type: 'text', text: `${rng.pick(WORDS)} = ${rng.int(0, 99)}` }],
      });
    case 'divider':
      return createBlockNode(id, type);
    case 'table': {
      const rows = Array.from({ length: rng.int(1, 2) }, () =>
        createBlockNode(alloc.blockId(), 'tableRow', {
          children: Array.from({ length: rng.int(1, 2) }, () =>
            createBlockNode(alloc.blockId(), 'tableCell', {
              content: makeInline(rng),
            }),
          ),
        }),
      );
      return createBlockNode(id, type, {
        attrs: { headerRows: rng.int(0, rows.length) },
        children: rows,
      });
    }
    case 'tableRow':
      return createBlockNode(id, type, {
        children: Array.from({ length: rng.int(1, 2) }, () =>
          createBlockNode(alloc.blockId(), 'tableCell', {
            content: makeInline(rng),
          }),
        ),
      });
    case 'tableCell':
      return createBlockNode(id, type, { content: makeInline(rng) });
    case 'callout':
      return createBlockNode(id, type, {
        attrs: { tone: rng.pick(TONES), title: `${rng.pick(WORDS)}提示` },
        children: [randomBlock(rng, 'paragraph', alloc.blockId(), alloc)],
      });
    case 'image':
      return createBlockNode(id, type, {
        attrs: { assetId: rng.pick(ASSET_IDS), alt: `${rng.pick(WORDS)}图` },
      });
    case 'file':
      return createBlockNode(id, type, {
        attrs: {
          assetId: rng.pick(ASSET_IDS),
          name: `fuzz-${rng.int(0, 99)}.txt`,
          mime: 'text/plain',
          bytes: rng.int(1, 4096),
        },
      });
    case 'bookmark':
      return createBlockNode(id, type, {
        attrs: {
          url: `https://example.com/${rng.pick(WORDS)}`,
          title: `${rng.pick(WORDS)}链接`,
        },
      });
    case 'docLink':
      return createBlockNode(id, type, {
        attrs: {
          docId: `doc-fuzz-${rng.int(0, 9)}`,
          title: `${rng.pick(WORDS)}文档`,
        },
      });
    case 'mindmap':
      return createBlockNode(id, type, {
        attrs: { objectId: rng.pick(SEED_OBJECT_IDS) },
      });
    case 'component':
      return createBlockNode(id, type, {
        attrs: {
          objectId: rng.pick(SEED_OBJECT_IDS),
          title: `${rng.pick(WORDS)}组件`,
        },
      });
    default:
      throw new Error(`fuzz: no block generator for ${type}`);
  }
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

interface BlockInfo {
  block: BlockNode;
  parentId: string | null;
  parentType: string | null;
  depth: number;
  ancestors: readonly string[];
}

function collectBlocks(doc: AlterDoc): BlockInfo[] {
  const result: BlockInfo[] = [];
  const walk = (
    blocks: readonly BlockNode[],
    parentId: string | null,
    parentType: string | null,
    depth: number,
    ancestors: readonly string[],
  ): void => {
    for (const block of blocks) {
      result.push({ block, parentId, parentType, depth, ancestors });
      if (block.children !== undefined)
        walk(block.children, block.id, block.type, depth + 1, [...ancestors, block.id]);
    }
  };
  walk(doc.blocks, null, null, 1, []);
  return result;
}

function subtreeIds(block: BlockNode): Set<string> {
  const ids = new Set<string>();
  const stack = [block];
  while (stack.length > 0) {
    const current = stack.pop()!;
    ids.add(current.id);
    if (current.children !== undefined) stack.push(...current.children);
  }
  return ids;
}

function subtreeDepth(block: BlockNode): number {
  if (block.children === undefined || block.children.length === 0) return 1;
  let deepest = 0;
  for (const child of block.children)
    deepest = Math.max(deepest, subtreeDepth(child));
  return 1 + deepest;
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const index = text.indexOf(needle, from);
    if (index < 0) return count;
    count += 1;
    from = index + needle.length;
  }
}

/** A unique plain-text slice of one block, or the whole text as fallback. */
function uniqueSlice(rng: Rng, text: string): string | undefined {
  if (text === '') return undefined;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const start = rng.int(0, text.length - 1);
    const length = rng.int(1, Math.min(4, text.length - start));
    const slice = text.slice(start, start + length);
    if (slice.trim() !== '' && countOccurrences(text, slice) === 1) return slice;
  }
  return countOccurrences(text, text) === 1 ? text : undefined;
}

// ---------------------------------------------------------------------------
// Operation generation (generated against a local simulation of the engine)
// ---------------------------------------------------------------------------

function makeSimContext(alloc: IdAlloc): OperationContext {
  return {
    docId: 'doc-fuzz-sim',
    nowIso: () => '2026-11-10T00:00:00.000Z',
    createBlockId: () => alloc.blockId(),
    parseMarkdown: (source, options) =>
      parseMarkdownBlocks(source, {
        createBlockId: options.createBlockId,
        hasAsset: () => true,
      }),
    createObject: () => alloc.objectId(),
  };
}

function insertBlocksOp(rng: Rng, doc: AlterDoc, alloc: IdAlloc): Operation {
  const count = rng.int(1, 2);
  const blocks = Array.from({ length: count }, () =>
    randomBlock(rng, rng.pick(ROOT_BLOCK_TYPES), alloc.blockId(), alloc),
  );
  return {
    op: 'insert_blocks',
    parent: null,
    index: rng.int(0, doc.blocks.length),
    blocks,
  };
}

/**
 * Build one random operation that should be legal on `doc`.
 *
 * `unsafeTargets` holds blocks inserted earlier in the *same* batch. The Host
 * validates `update_object` against the document at batch start (the object
 * factory closure), so a single batch cannot update an object on a block it
 * just inserted — the documented two-batch placeholder pattern instead.
 */
function makeOperation(
  rng: Rng,
  doc: AlterDoc,
  alloc: IdAlloc,
  unsafeTargets: ReadonlySet<string> = new Set(),
): Operation {
  const infos = collectBlocks(doc);
  if (infos.length === 0) return insertBlocksOp(rng, doc, alloc);
  const roll = rng.next();

  if (roll < 0.3) return insertBlocksOp(rng, doc, alloc);
  if (roll < 0.38) {
    return {
      op: 'insert_markdown',
      parent: null,
      index: rng.int(0, doc.blocks.length),
      markdown: rng.pick(MARKDOWN_SAMPLES),
    };
  }
  if (roll < 0.5) {
    const candidates = infos.filter((info) =>
      operationAllowedOn(info.block.type, 'replace_block'),
    );
    if (candidates.length === 0) return insertBlocksOp(rng, doc, alloc);
    const target = rng.pick(candidates).block;
    return {
      op: 'replace_block',
      target: target.id,
      blocks: [randomBlock(rng, target.type, target.id, alloc)],
    };
  }
  if (roll < 0.62) {
    const candidates = infos.filter(
      (info) =>
        operationAllowedOn(info.block.type, 'update_text') &&
        plainTextOfBlock(info.block) !== '',
    );
    if (candidates.length === 0) return insertBlocksOp(rng, doc, alloc);
    const target = rng.pick(candidates).block;
    const oldText = uniqueSlice(rng, plainTextOfBlock(target));
    if (oldText === undefined) return insertBlocksOp(rng, doc, alloc);
    return {
      op: 'update_text',
      target: target.id,
      edits: [
        {
          oldText,
          newText: `${rng.pick(WORDS)}${rng.int(0, 999)}`,
        },
      ],
    };
  }
  if (roll < 0.72) {
    const candidates = infos.filter(
      (info) =>
        operationAllowedOn(info.block.type, 'update_attrs') &&
        Object.keys(NODE_TYPES[info.block.type]?.attrs ?? {}).length > 0,
    );
    if (candidates.length === 0) return insertBlocksOp(rng, doc, alloc);
    const target = rng.pick(candidates).block;
    return {
      op: 'update_attrs',
      target: target.id,
      attrs: randomAttrPatch(rng, target.type),
    };
  }
  if (roll < 0.82) {
    const candidates = infos.filter((info) =>
      operationAllowedOn(info.block.type, 'move_block'),
    );
    if (candidates.length === 0) return insertBlocksOp(rng, doc, alloc);
    const targetInfo = rng.pick(candidates);
    const blockedIds = subtreeIds(targetInfo.block);
    const containers = infos.filter(
      (info) =>
        info.block.children !== undefined &&
        !blockedIds.has(info.block.id) &&
        (info.block.type === 'callout' ||
          info.block.type === 'blockquote' ||
          info.block.type === 'listItem') &&
        info.depth + subtreeDepth(targetInfo.block) <= 50,
    );
    const toRoot = containers.length === 0 || rng.chance(0.5);
    if (toRoot) {
      return {
        op: 'move_block',
        target: targetInfo.block.id,
        parent: null,
        index: rng.int(0, doc.blocks.length),
      };
    }
    const destination = rng.pick(containers);
    return {
      op: 'move_block',
      target: targetInfo.block.id,
      parent: destination.block.id,
      index: rng.int(0, destination.block.children!.length),
    };
  }
  if (roll < 0.89) {
    if (infos.length <= 2) return insertBlocksOp(rng, doc, alloc);
    const candidates = infos.filter((info) =>
      operationAllowedOn(info.block.type, 'delete_block'),
    );
    if (candidates.length === 0) return insertBlocksOp(rng, doc, alloc);
    return { op: 'delete_block', target: rng.pick(candidates).block.id };
  }
  if (roll < 0.95) {
    const candidates = infos.filter((info) => {
      const definition: NodeTypeDefinition | undefined =
        NODE_TYPES[info.block.type];
      return (
        operationAllowedOn(info.block.type, 'transform_block') &&
        (definition?.transforms?.length ?? 0) > 0
      );
    });
    if (candidates.length === 0) return insertBlocksOp(rng, doc, alloc);
    const target = rng.pick(candidates).block;
    const definition = NODE_TYPES[target.type]!;
    const to = rng.pick(definition.transforms!);
    return {
      op: 'transform_block',
      target: target.id,
      to,
      ...(to === 'heading' ? { attrs: { level: rng.int(1, 6) } } : {}),
    };
  }
  const objects = infos.filter(
    (info) =>
      operationAllowedOn(info.block.type, 'update_object') &&
      (info.block.type === 'mindmap' || info.block.type === 'component') &&
      !unsafeTargets.has(info.block.id),
  );
  if (objects.length === 0) return insertBlocksOp(rng, doc, alloc);
  const target = rng.pick(objects).block;
  const payload: JsonValue =
    target.type === 'mindmap'
      ? {
          root: {
            id: 'n1',
            text: `${rng.pick(WORDS)}根`,
            children: [{ id: 'n2', text: `${rng.pick(WORDS)}子` }],
          },
        }
      : {
          format: 'alter-component/1',
          componentId: 'builtin/progress',
          componentVersion: 1,
          props: { label: `${rng.pick(WORDS)}进度`, value: rng.int(0, 100) },
        };
  return { op: 'update_object', target: target.id, payload };
}

function randomAttrPatch(rng: Rng, type: string): Record<string, JsonValue> {
  switch (type) {
    case 'heading':
      return { level: rng.int(1, 6) };
    case 'orderedList':
      return { start: rng.int(1, 9) };
    case 'codeBlock':
      return { lang: rng.pick(LANGS) };
    case 'callout':
      return { tone: rng.pick(TONES), title: `${rng.pick(WORDS)}块` };
    case 'image':
      return { alt: `${rng.pick(WORDS)}图`, width: '120px' };
    case 'file':
      return { name: `renamed-${rng.int(0, 99)}.txt` };
    case 'bookmark':
      return { title: `${rng.pick(WORDS)}卡` };
    case 'docLink':
      return { title: `${rng.pick(WORDS)}文档` };
    case 'mindmap':
      return { caption: `${rng.pick(WORDS)}导图` };
    case 'component':
      return { title: `${rng.pick(WORDS)}组件` };
    case 'table':
      return { headerRows: rng.int(0, 1) };
    case 'listItem':
      return { checked: rng.chance(0.5) };
    default:
      return {};
  }
}

/**
 * Build one batch by simulating each candidate operation on a local copy of
 * the engine. Operations that the simulation rejects are dropped; a markdown
 * insertion is always emitted alone because the Host assigns those ids.
 */
function buildBatch(
  rng: Rng,
  doc: AlterDoc,
  alloc: IdAlloc,
): Operation[] {
  const ctx = makeSimContext(alloc);
  const ops: Operation[] = [];
  const unsafeTargets = new Set<string>();
  let simulated = doc;
  const targetCount = rng.int(1, 4);
  for (let index = 0; index < targetCount; index += 1) {
    const op = makeOperation(rng, simulated, alloc, unsafeTargets);
    if (op.op === 'insert_markdown') {
      if (ops.length === 0) return [op];
      break;
    }
    try {
      simulated = applyOperations(simulated, [op], ctx).doc;
      ops.push(op);
      if (op.op === 'insert_blocks')
        for (const block of op.blocks ?? [])
          for (const id of subtreeIds(block)) unsafeTargets.add(id);
    } catch {
      break;
    }
  }
  return ops.length > 0 ? ops : [insertBlocksOp(rng, doc, alloc)];
}

// ---------------------------------------------------------------------------
// Host harness
// ---------------------------------------------------------------------------

const dirs: string[] = [];
const stores: SpaceStoreHandle[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempStore(): Promise<SpaceStoreHandle> {
  const dir = await mkdtemp(join(tmpdir(), 'alter-space-fuzz-'));
  dirs.push(dir);
  const store = await openSpaceStore({ directory: dir, now: () => new Date('2026-11-10T00:00:00.000Z') });
  stores.push(store);
  return store;
}

const RICH_MARKDOWN = [
  '# 标题',
  '正文段落',
  '- 列表一',
  '- 列表二',
  '> 引用',
  '```ts',
  'const value = 1;',
  '```',
  '---',
  ':::callout{tone="warn" title="注意"}',
  '提示内容',
  ':::',
  ':::mindmap{objectId="obj_seed"}',
  ':::',
  ':::component{objectId="obj_seed"}',
  ':::',
  '| 甲 | 乙 |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
].join('\n');

const SEED_BLOCKS: BlockNode[] = [
  createBlockNode('blk_seed_image', 'image', {
    attrs: { assetId: 'asset_seed', alt: '种子图' },
  }),
  createBlockNode('blk_seed_file', 'file', {
    attrs: {
      assetId: 'asset_seed',
      name: 'seed.txt',
      mime: 'text/plain',
      bytes: 12,
    },
  }),
  createBlockNode('blk_seed_bookmark', 'bookmark', {
    attrs: { url: 'https://example.com/seed', title: '种子链接' },
  }),
  createBlockNode('blk_seed_doclink', 'docLink', {
    attrs: { docId: 'doc-seed', title: '种子文档' },
  }),
];

/** Create the initial document for one sequence and return its id. */
async function createSequenceDocument(
  service: DocumentService,
  sequence: number,
): Promise<string> {
  const variant = sequence % 3;
  if (variant === 0) {
    const node = await service.createNote({
      spaceId: DEFAULT_SPACE_ID,
      title: `fuzz-${sequence}`,
    });
    return node.id;
  }
  const generated = await service.generate({
    spaceId: DEFAULT_SPACE_ID,
    title: `fuzz-${sequence}`,
    markdown: RICH_MARKDOWN,
  });
  if (variant === 2) {
    await service.applyOperations({
      docId: generated.docId,
      baseRevision: generated.revision,
      ops: [{ op: 'insert_blocks', parent: null, index: 0, blocks: SEED_BLOCKS }],
    });
  }
  return generated.docId;
}

function describeBatch(seed: number, sequence: number, batch: number): string {
  return `seed=${seed} sequence=${sequence} batch=${batch}`;
}

/**
 * Seeded random walk. The gate runs a small slice; the nightly project runs the
 * full 100 × 30 pass. Both use one runner (`tests/support/fuzz-runner.ts`), so a
 * failing seed reproduces identically in either suite.
 */
const FUZZ_SEED = 0x5eed_2026;
/** Per-test timeout, kept above the platform budget so the assertion fires first. */
const FUZZ_TIMEOUT_MS = process.platform === 'win32' ? 120_000 : 60_000;
/**
 * Wall-clock ceiling for one full nightly pass (100 sequences). Windows writes
 * the temporary SQLite store noticeably slower, so it gets its own ceiling.
 */
const FUZZ_FULL_BUDGET_MS = process.platform === 'win32' ? 45_000 : 20_000;
const V0_OPERATIONS = [
  'delete_block',
  'insert_blocks',
  'insert_markdown',
  'move_block',
  'replace_block',
  'transform_block',
  'update_attrs',
  'update_object',
  'update_text',
];

async function fuzzPass(sequences: number) {
  const rng = makeRng(FUZZ_SEED);
  const store = await tempStore();
  const service = createDocumentService({
    store,
    now: () => new Date('2026-11-10T00:00:00.000Z'),
  });
  const report = await runFuzz(service, {
    seed: FUZZ_SEED,
    sequences,
    batchesPerSequence: 30,
    createDocument: (sequence) => createSequenceDocument(service, sequence),
    buildBatch: (doc, tag) => {
      const alloc = new IdAlloc(tag);
      const ops = buildBatch(rng, doc, alloc);
      if (ops.length > MAX_OPERATION_BATCH)
        throw new Error(`${tag}: batch exceeds host cap`);
      return ops;
    },
    releaseDocument: async (docId) => {
      // Keep the shared store small so the transaction clone stays cheap.
      await store.update((data) => {
        data.nodes = data.nodes.filter((node) => node.id !== docId);
        data.versions = data.versions.filter((version) => version.docId !== docId);
      });
    },
    context: (sequence, batch) => describeBatch(FUZZ_SEED, sequence, batch),
  });
  return report;
}

describe('G2 random operation sequences', () => {
  it(
    'keeps 100 random sequences (30 batches each) valid, monotonic and undoable',
    async () => {
      const started = Date.now();
      const report = await fuzzPass(100);
      expect(report.batches).toBe(100 * 30);
      expect(report.undos).toBeGreaterThan(0);
      expect([...report.operations].sort()).toEqual(V0_OPERATIONS.slice().sort());
      expect(Date.now() - started).toBeLessThan(FUZZ_FULL_BUDGET_MS);
    },
    FUZZ_TIMEOUT_MS,
  );

  it('keeps a seeded random walk valid, monotonic and undoable', async () => {
    const report = await fuzzPass(4);
    expect(report.batches).toBe(4 * 30);
    expect(report.undos).toBeGreaterThan(0);
  }, FUZZ_TIMEOUT_MS);

  it('applies every v0 operation type and undoes it exactly', async () => {
    const store = await tempStore();
    const service = createDocumentService({
      store,
      now: () => new Date('2026-11-10T00:00:00.000Z'),
    });
    const generated = await service.generate({
      spaceId: DEFAULT_SPACE_ID,
      title: 'op coverage',
      markdown: RICH_MARKDOWN,
    });
    const docId = generated.docId;
    const covered = new Set<string>();

    const cases: Array<{
      op: string;
      build: (doc: AlterDoc) => Operation;
    }> = [
      {
        op: 'insert_blocks',
        build: () => ({
          op: 'insert_blocks',
          parent: null,
          index: 0,
          blocks: [
            createBlockNode('blk_case_divider', 'divider'),
            createBlockNode('blk_case_para', 'paragraph', {
              content: [{ type: 'text', text: '插入段落' }],
            }),
          ],
        }),
      },
      {
        op: 'insert_markdown',
        build: () => ({
          op: 'insert_markdown',
          parent: null,
          markdown: 'markdown 插入\n',
        }),
      },
      {
        op: 'replace_block',
        build: (doc) => {
          const target = collectBlocks(doc).find(
            (info) => info.block.type === 'paragraph',
          )!.block;
          return {
            op: 'replace_block',
            target: target.id,
            blocks: [
              createBlockNode(target.id, 'paragraph', {
                content: [{ type: 'text', text: '替换后的段落' }],
              }),
            ],
          };
        },
      },
      {
        op: 'update_text',
        build: (doc) => {
          const target = collectBlocks(doc).find(
            (info) =>
              info.block.type === 'paragraph' &&
              plainTextOfBlock(info.block) !== '',
          )!.block;
          return {
            op: 'update_text',
            target: target.id,
            edits: [{ oldText: plainTextOfBlock(target), newText: '改写文本' }],
          };
        },
      },
      {
        op: 'update_attrs',
        build: (doc) => {
          const target = collectBlocks(doc).find(
            (info) => info.block.type === 'heading',
          )!.block;
          return { op: 'update_attrs', target: target.id, attrs: { level: 2 } };
        },
      },
      {
        op: 'move_block',
        build: (doc) => ({
          op: 'move_block',
          target: doc.blocks[doc.blocks.length - 1]!.id,
          parent: null,
          index: 0,
        }),
      },
      {
        op: 'delete_block',
        build: (doc) => ({
          op: 'delete_block',
          target: doc.blocks[doc.blocks.length - 1]!.id,
        }),
      },
      {
        op: 'transform_block',
        build: (doc) => {
          const target = collectBlocks(doc).find(
            (info) => info.block.type === 'paragraph',
          )!.block;
          return {
            op: 'transform_block',
            target: target.id,
            to: 'heading',
            attrs: { level: 3 },
          };
        },
      },
      {
        op: 'update_object',
        build: (doc) => {
          const target = collectBlocks(doc).find(
            (info) => info.block.type === 'mindmap',
          )!.block;
          return {
            op: 'update_object',
            target: target.id,
            payload: { root: { id: 'n1', text: '根节点' } },
          };
        },
      },
    ];

    for (const testCase of cases) {
      const before = await service.get(docId);
      assertValidDocument(before.doc, `case ${testCase.op} before`);
      const op = testCase.build(before.doc);
      const applied = await service.applyOperations({
        docId,
        baseRevision: before.revision,
        ops: [op],
      });
      expect(applied.revision).toBe(before.revision + 1);
      const after = await service.get(docId);
      assertValidDocument(after.doc, `case ${testCase.op}`);
      const undone = await service.undo({
        docId,
        baseRevision: after.revision,
      });
      expect(undone.revision).toBe(after.revision + 1);
      const restored = await service.get(docId);
      expect(restored.doc.blocks).toEqual(before.doc.blocks);
      assertValidDocument(restored.doc, `case ${testCase.op} undo`);
      covered.add(op.op);
    }

    expect([...covered].sort()).toEqual(
      [
        'delete_block',
        'insert_blocks',
        'insert_markdown',
        'move_block',
        'replace_block',
        'transform_block',
        'update_attrs',
        'update_object',
        'update_text',
      ].sort(),
    );
  });

  it('rejects illegal batches with stable DocumentError codes and no partial write', async () => {
    const store = await tempStore();
    const service = createDocumentService({
      store,
      now: () => new Date('2026-11-10T00:00:00.000Z'),
    });
    const generated = await service.generate({
      spaceId: DEFAULT_SPACE_ID,
      markdown: '原文\n',
    });
    const docId = generated.docId;
    const before = await service.get(docId);

    const illegal: Array<{ ops: Operation[]; code: string }> = [
      {
        ops: [{ op: 'delete_block', target: 'blk_missing' }],
        code: 'node/not-found',
      },
      {
        ops: [
          {
            op: 'update_attrs',
            target: before.doc.blocks[0]!.id,
            attrs: { color: 'red' },
          },
        ],
        code: 'node/schema-invalid',
      },
      {
        ops: [
          {
            op: 'transform_block',
            target: before.doc.blocks[0]!.id,
            to: 'table',
          },
        ],
        code: 'node/unsupported-transform',
      },
      {
        ops: [
          {
            op: 'insert_blocks',
            parent: null,
            index: 99,
            blocks: [createBlockNode('blk_illegal', 'divider')],
          },
        ],
        code: 'op/invalid',
      },
    ];

    for (const testCase of illegal) {
      let error: unknown;
      try {
        await service.applyOperations({
          docId,
          baseRevision: before.revision,
          ops: testCase.ops,
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(DocumentError);
      expect((error as DocumentError).code).toBe(testCase.code);
      const unchanged = await service.get(docId);
      expect(unchanged.revision).toBe(before.revision);
      expect(unchanged.doc.blocks).toEqual(before.doc.blocks);
      assertValidDocument(unchanged.doc, `illegal ${testCase.code}`);
    }
  });

  it('keeps the block count and depth budgets enforced under random insertion', async () => {
    // The fuzz generator stays well below the document limits; this case pins
    // the upper bound contract with one oversized insertion.
    const store = await tempStore();
    const service = createDocumentService({
      store,
      now: () => new Date('2026-11-10T00:00:00.000Z'),
    });
    const generated = await service.generate({
      spaceId: DEFAULT_SPACE_ID,
      markdown: '原文\n',
    });
    const before = await service.get(generated.docId);
    const blocks = Array.from({ length: 5_001 }, (_, index) =>
      createBlockNode(`blk_budget_${index}`, 'paragraph', {
        content: [{ type: 'text', text: 'x' }],
      }),
    );
    await expect(
      service.applyOperations({
        docId: generated.docId,
        baseRevision: before.revision,
        ops: [{ op: 'insert_blocks', parent: null, index: 0, blocks }],
      }),
    ).rejects.toMatchObject({ code: 'doc/schema-invalid' });
    const unchanged = await service.get(generated.docId);
    expect(unchanged.revision).toBe(before.revision);
    assertValidDocument(unchanged.doc, 'budget rejection');
  });
});

// ---------------------------------------------------------------------------
// Regressions for engine bugs found by the fuzz generator
// ---------------------------------------------------------------------------

/**
 * `tableRow` is a block container with `ai.writable: false`
 * (host/document/schema.ts). Forward `move_block`/`delete_block` of a
 * `tableCell` is accepted (the cell itself is writable); the inverse batch
 * writes back into the tableRow and used to be rejected by `resolveAnchor`
 * with `node/not-writable`. `DocumentService.undo` now replays the
 * engine-generated inverse as a trusted batch (schema/size/existence checks
 * still run), so the previous tree is restored exactly; normal caller batches
 * remain fail-closed. Reproduced by the seeded fuzz sequence above
 * (seed=0x5eed_2026); these tests pin the fix.
 */
describe('regression: undo restores structural children of tableRow', () => {
  async function tableDocument(service: DocumentService): Promise<string> {
    const generated = await service.generate({
      spaceId: DEFAULT_SPACE_ID,
      markdown: '原文\n',
    });
    const table = createBlockNode('blk_table_undo', 'table', {
      attrs: { headerRows: 1 },
      children: [
        createBlockNode('blk_row_undo', 'tableRow', {
          children: [
            createBlockNode('blk_cell_undo', 'tableCell', {
              content: [{ type: 'text', text: '格子' }],
            }),
          ],
        }),
      ],
    });
    await service.applyOperations({
      docId: generated.docId,
      baseRevision: generated.revision,
      ops: [{ op: 'insert_blocks', parent: null, index: 1, blocks: [table] }],
    });
    return generated.docId;
  }

  it('move_block out of a tableRow can be undone', async () => {
    const store = await tempStore();
    const service = createDocumentService({
      store,
      now: () => new Date('2026-11-10T00:00:00.000Z'),
    });
    const docId = await tableDocument(service);
    const before = await service.get(docId);
    const moved = await service.applyOperations({
      docId,
      baseRevision: before.revision,
      ops: [{ op: 'move_block', target: 'blk_cell_undo', parent: null, index: 0 }],
    });
    const undone = await service.undo({ docId, baseRevision: moved.revision });
    expect(undone.revision).toBe(moved.revision + 1);
    const restored = await service.get(docId);
    expect(restored.doc.blocks).toEqual(before.doc.blocks);
    assertValidDocument(restored.doc, 'tableRow move undo');
  });

  it('delete_block of a tableCell can be undone', async () => {
    const store = await tempStore();
    const service = createDocumentService({
      store,
      now: () => new Date('2026-11-10T00:00:00.000Z'),
    });
    const docId = await tableDocument(service);
    const before = await service.get(docId);
    const deleted = await service.applyOperations({
      docId,
      baseRevision: before.revision,
      ops: [{ op: 'delete_block', target: 'blk_cell_undo' }],
    });
    const undone = await service.undo({ docId, baseRevision: deleted.revision });
    expect(undone.revision).toBe(deleted.revision + 1);
    const restored = await service.get(docId);
    expect(restored.doc.blocks).toEqual(before.doc.blocks);
    assertValidDocument(restored.doc, 'tableRow delete undo');
  });

  it('version restore can rewrite non-writable top-level blocks', async () => {
    const store = await tempStore();
    const service = createDocumentService({
      store,
      now: () => new Date('2026-11-10T00:00:00.000Z'),
    });
    const generated = await service.generate({
      spaceId: DEFAULT_SPACE_ID,
      markdown: '原文\n',
    });
    const initial = await service.get(generated.docId);
    const version = store
      .read()
      .versions.find((item) => item.docId === generated.docId);
    expect(version).toBeDefined();
    // A top-level `tableRow` is schema-valid but not AI-writable; only the
    // trusted restore replay may delete it again.
    await service.applyOperations({
      docId: generated.docId,
      baseRevision: initial.revision,
      ops: [
        {
          op: 'insert_blocks',
          parent: null,
          index: 0,
          blocks: [
            createBlockNode('blk_root_row', 'tableRow', {
              children: [
                createBlockNode('blk_root_cell', 'tableCell', {
                  content: [{ type: 'text', text: '格' }],
                }),
              ],
            }),
          ],
        },
      ],
    });
    const beforeRestore = await service.get(generated.docId);
    const restored = await service.restoreVersion({
      docId: generated.docId,
      versionId: version!.id,
      baseRevision: beforeRestore.revision,
    });
    expect(restored.revision).toBe(beforeRestore.revision + 1);
    const afterRestore = await service.get(generated.docId);
    expect(afterRestore.doc.blocks).toEqual(initial.doc.blocks);
    assertValidDocument(afterRestore.doc, 'trusted restore');
  });

  it('normal batches still cannot write structural children into a tableRow', async () => {
    const store = await tempStore();
    const service = createDocumentService({
      store,
      now: () => new Date('2026-11-10T00:00:00.000Z'),
    });
    const docId = await tableDocument(service);
    const before = await service.get(docId);
    await expect(
      service.applyOperations({
        docId,
        baseRevision: before.revision,
        ops: [
          {
            op: 'insert_blocks',
            parent: 'blk_row_undo',
            index: 0,
            blocks: [
              createBlockNode('blk_cell_extra', 'tableCell', {
                content: [{ type: 'text', text: '额外' }],
              }),
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'node/not-writable' });
    const unchanged = await service.get(docId);
    expect(unchanged.revision).toBe(before.revision);
    expect(unchanged.doc.blocks).toEqual(before.doc.blocks);
  });
});

/**
 * `update_attrs` on a container block keeps its children in place, but the
 * inverse batch is `replace_block` with the original container snapshot.
 * `prepareReplacementBlock` keeps the target id; the engine now frees the
 * replaced subtree's ids before assigning replacement descendants, so the
 * original descendant ids are reused and anchors stay stable across undo.
 * Reproduced by the seeded fuzz sequence above (seed=0x5eed_2026).
 */
describe('regression: undo of a container update_attrs keeps child ids', () => {
  it('restores callout content with stable descendant block ids', async () => {
    const store = await tempStore();
    const service = createDocumentService({
      store,
      now: () => new Date('2026-11-10T00:00:00.000Z'),
    });
    const generated = await service.generate({
      spaceId: DEFAULT_SPACE_ID,
      markdown: ':::callout{tone="info" title="注意"}\n内容\n:::\n',
    });
    const docId = generated.docId;
    const before = await service.get(docId);
    const callout = before.doc.blocks[0]!;
    const childIdsBefore = collectBlocks(before.doc)
      .filter((info) => info.ancestors.includes(callout.id))
      .map((info) => info.block.id);
    expect(childIdsBefore.length).toBeGreaterThan(0);

    const applied = await service.applyOperations({
      docId,
      baseRevision: before.revision,
      ops: [{ op: 'update_attrs', target: callout.id, attrs: { tone: 'danger' } }],
    });
    const undone = await service.undo({ docId, baseRevision: applied.revision });
    expect(undone.revision).toBe(applied.revision + 1);

    const restored = await service.get(docId);
    assertValidDocument(restored.doc, 'container update_attrs undo');
    expect(restored.doc.blocks[0]!.attrs).toEqual(callout.attrs);
    expect(plainTextOfBlock(restored.doc.blocks[0]!)).toBe(
      plainTextOfBlock(callout),
    );
    const childIdsAfter = collectBlocks(restored.doc)
      .filter((info) => info.ancestors.includes(callout.id))
      .map((info) => info.block.id);
    expect(childIdsAfter).toEqual(childIdsBefore);
    expect(restored.doc.blocks).toEqual(before.doc.blocks);

    // A later operation still applies cleanly on the restored tree.
    const again = await service.applyOperations({
      docId,
      baseRevision: restored.revision,
      ops: [{ op: 'update_attrs', target: callout.id, attrs: { tone: 'success' } }],
    });
    expect(again.revision).toBe(restored.revision + 1);
    assertValidDocument((await service.get(docId)).doc, 'after re-apply');
  });
});