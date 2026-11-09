import { describe, expect, it, vi } from 'vitest';
import {
  registerDocumentTools,
  type DocumentToolDeps,
  type ToolDefinitionLike,
  type ToolsLike,
} from '../host/document/tools.js';
import type { DocumentService } from '../host/document/service.js';
import { DocumentError } from '../host/document/types.js';

function fakeTools(): {
  tools: ToolsLike;
  definitions: Map<string, ToolDefinitionLike>;
} {
  const definitions = new Map<string, ToolDefinitionLike>();
  return {
    definitions,
    tools: {
      register(definition) {
        definitions.set(definition.name, definition);
        return () => definitions.delete(definition.name);
      },
    },
  };
}

function fakeService(overrides: Partial<DocumentService> = {}): DocumentService {
  const service = {
    async outline(docId: string) {
      return {
        docId,
        revision: 3,
        title: '鉴权方案',
        totalBlocks: 2,
        outline: [
          { id: 'blk_1', type: 'heading', preview: '鉴权方案', childCount: 0 },
          { id: 'blk_2', type: 'paragraph', preview: '正文', childCount: 0 },
        ],
      };
    },
    async read(docId: string) {
      return {
        docId,
        revision: 3,
        title: '鉴权方案',
        markdown: '<!-- blk:blk_1 -->\n# 鉴权方案\n',
        blocks: [{ id: 'blk_1', type: 'heading' }],
        truncated: false,
      };
    },
    async search(input: { query: string }) {
      return {
        query: input.query,
        truncated: false,
        hits: [
          {
            docId: 'doc-1',
            spaceId: 'sp-1',
            title: '鉴权方案',
            blockId: 'blk_2',
            type: 'paragraph',
            preview: 'token 刷新',
          },
        ],
      };
    },
    async applyOperations(input: { docId: string; baseRevision: number }) {
      return {
        docId: input.docId,
        revision: input.baseRevision + 1,
        changedBlockIds: ['blk_2'],
        diff: { applied: [], changedBlockIds: ['blk_2'] },
        undoToken: 'op_1',
        warnings: [],
      };
    },
    async generate(input: { markdown: string }) {
      return {
        docId: 'doc-new',
        revision: 1,
        changedBlockIds: ['blk_1'],
        title: input.markdown.slice(0, 4),
      };
    },
    async undo(input: { docId: string; baseRevision: number }) {
      return {
        docId: input.docId,
        revision: input.baseRevision + 1,
        changedBlockIds: ['blk_2'],
        diff: { applied: [], changedBlockIds: ['blk_2'] },
        undoToken: 'op_undo',
        warnings: [],
      };
    },
    async getObject(objectId: string) {
      return {
        id: objectId,
        docId: 'doc-1',
        type: 'mindmap' as const,
        schemaVersion: 1,
        payload: { root: { id: 'n1', text: 'root' } },
        createdAt: '2026-01-01T00:00:00.000Z',
      };
    },
    async updateObject(input: {
      docId: string;
      baseRevision: number;
      blockId: string;
    }) {
      return {
        docId: input.docId,
        revision: input.baseRevision + 1,
        changedBlockIds: [input.blockId],
        diff: { applied: [], changedBlockIds: [input.blockId] },
        undoToken: 'op_2',
        warnings: [],
        objectId: 'obj_new',
      };
    },
    ...overrides,
  } as unknown as DocumentService;
  return service;
}

const exec = (name: string) => ({
  callId: name,
  name,
  arguments: {},
  signal: new AbortController().signal,
});

function setup(service = fakeService()): {
  definitions: Map<string, ToolDefinitionLike>;
  deps: DocumentToolDeps;
  dispose: () => void;
} {
  const { tools, definitions } = fakeTools();
  const assets = {
    async import(input: { data: Uint8Array; mime: string; name?: string }) {
      return {
        id: 'asset_imported',
        sha256: '0'.repeat(64),
        mime: input.mime,
        bytes: input.data.byteLength,
        ...(input.name === undefined ? {} : { name: input.name }),
        createdAt: '2026-01-01T00:00:00.000Z',
      };
    },
    async get() {
      return undefined;
    },
    async read() {
      return undefined;
    },
  };
  const deps = { service, assets } as DocumentToolDeps;
  const dispose = registerDocumentTools(tools, deps);
  return { definitions, deps, dispose };
}

describe('document Agent tools', () => {
  it('registers the v0 tools with read/write concurrency hints', () => {
    const { definitions, dispose } = setup();
    expect([...definitions.keys()].sort()).toEqual([
      'space_asset_import',
      'space_doc_generate',
      'space_doc_ops',
      'space_doc_outline',
      'space_doc_read',
      'space_doc_search',
      'space_doc_undo',
      'space_object_get',
      'space_object_update',
    ]);
    expect(definitions.get('space_doc_outline')?.isConcurrencySafe?.({})).toBe(true);
    expect(definitions.get('space_doc_read')?.isConcurrencySafe?.({})).toBe(true);
    expect(definitions.get('space_doc_ops')?.isConcurrencySafe?.({})).toBe(false);
    expect(definitions.get('space_doc_generate')?.isConcurrencySafe?.({})).toBe(false);
    dispose();
    expect(definitions.size).toBe(0);
  });

  it('maps outline to the snake_case tool contract', async () => {
    const { definitions } = setup();
    const definition = definitions.get('space_doc_outline')!;
    const value = await definition.execute(
      { doc_id: 'doc-1' },
      exec('space_doc_outline'),
    );
    expect(value).toEqual({
      revision: 3,
      title: '鉴权方案',
      total_blocks: 2,
      outline: [
        { id: 'blk_1', type: 'heading', preview: '鉴权方案', child_count: 0 },
        { id: 'blk_2', type: 'paragraph', preview: '正文', child_count: 0 },
      ],
    });
    const content = definition.output.render({}, value);
    expect(content[0]?.text).toContain('共 2 个块');
    expect(content[0]?.text).toContain('blk_2');
  });

  it('maps read options and output without leaking doc metadata', async () => {
    const read = vi.fn(fakeService().read);
    const { definitions } = setup(fakeService({ read }));
    const definition = definitions.get('space_doc_read')!;
    const value = await definition.execute(
      {
        doc_id: 'doc-1',
        blocks: ['blk_1'],
        after: 'blk_0',
        limit: 5,
        max_chars: 2000,
      },
      exec('space_doc_read'),
    );
    expect(read).toHaveBeenCalledWith('doc-1', {
      blocks: ['blk_1'],
      after: 'blk_0',
      limit: 5,
      maxChars: 2000,
    });
    expect(value).toMatchObject({
      revision: 3,
      truncated: false,
      blocks: [{ id: 'blk_1', type: 'heading' }],
    });
    expect(value).not.toHaveProperty('docId');
  });

  it('maps search hits to doc_id/block_id', async () => {
    const { definitions } = setup();
    const value = await definitions.get('space_doc_search')!.execute(
      { query: 'token', doc_id: 'doc-1', limit: 5 },
      exec('space_doc_search'),
    );
    expect(value).toEqual({
      query: 'token',
      truncated: false,
      hits: [
        {
          doc_id: 'doc-1',
          block_id: 'blk_2',
          type: 'paragraph',
          preview: 'token 刷新',
        },
      ],
    });
  });

  it('maps applyOperations results and error codes', async () => {
    const { definitions } = setup();
    const definition = definitions.get('space_doc_ops')!;
    const value = await definition.execute(
      {
        doc_id: 'doc-1',
        base_revision: 3,
        ops: [{ op: 'delete_block', target: 'blk_2' }],
        idempotency_key: 'turn-1',
      },
      exec('space_doc_ops'),
    );
    expect(value).toMatchObject({
      revision: 4,
      changed_block_ids: ['blk_2'],
      undo_token: 'op_1',
    });

    const failing = setup(
      fakeService({
        async applyOperations() {
          throw new DocumentError('doc/conflict', 'revision 不匹配');
        },
      }),
    );
    await expect(
      failing.definitions.get('space_doc_ops')!.execute(
        { doc_id: 'doc-1', base_revision: 1, ops: [] },
        exec('space_doc_ops'),
      ),
    ).rejects.toThrow('doc/conflict: revision 不匹配');
  });

  it('maps object reads and updates', async () => {
    const { definitions } = setup();
    const object = await definitions.get('space_object_get')!.execute(
      { object_id: 'obj_1' },
      exec('space_object_get'),
    );
    expect(object).toEqual({
      type: 'mindmap',
      schema_version: 1,
      payload: { root: { id: 'n1', text: 'root' } },
    });

    const updated = await definitions.get('space_object_update')!.execute(
      {
        doc_id: 'doc-1',
        block_id: 'blk_9',
        base_revision: 3,
        payload: { root: { id: 'n1', text: 'root' } },
      },
      exec('space_object_update'),
    );
    expect(updated).toEqual({
      revision: 4,
      object_id: 'obj_new',
      changed_block_ids: ['blk_9'],
    });
  });

  it('maps undo results', async () => {
    const { definitions } = setup();
    const value = await definitions.get('space_doc_undo')!.execute(
      { doc_id: 'doc-1', base_revision: 3, undo_token: 'op_1' },
      exec('space_doc_undo'),
    );
    expect(value).toMatchObject({
      revision: 4,
      changed_block_ids: ['blk_2'],
      undo_token: 'op_undo',
    });
  });

  it('imports assets through the asset store', async () => {
    const { definitions } = setup();
    const value = await definitions.get('space_asset_import')!.execute(
      {
        mime: 'image/png',
        data_base64: Buffer.from([1, 2, 3]).toString('base64'),
        name: 'a.png',
      },
      exec('space_asset_import'),
    );
    expect(value).toEqual({
      asset_id: 'asset_imported',
      mime: 'image/png',
      bytes: 3,
      name: 'a.png',
    });
  });

  it('rejects malformed arguments with a stable prefix', async () => {
    const { definitions } = setup();
    await expect(
      definitions.get('space_doc_outline')!.execute({}, exec('space_doc_outline')),
    ).rejects.toThrow('space/invalid-args');
    await expect(
      definitions.get('space_doc_read')!.execute(
        { doc_id: 'doc-1', max_chars: 10 },
        exec('space_doc_read'),
      ),
    ).rejects.toThrow('space/invalid-args');
  });
});
