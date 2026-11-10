// @vitest-environment jsdom
/**
 * P3 rich blocks: generic file-asset upload helpers, image attribute-editing
 * helpers, mindmap payload utilities and the mindmap tree editor dialog.
 *
 * The file-card/image/mindmap wiring inside the editor surface is covered by
 * `document-editor-surface.test.ts`; this file tests the pure helpers and the
 * object editor component directly.
 */
import { createElement } from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_FILE_BYTES,
  SUPPORTED_FILE_EXTENSIONS,
  inferFileMime,
  uploadFileWithClient,
  validateFileCard,
} from '../src/document/editor/AlterTiptapEditor';
import {
  formatFileSize,
  normalizeImageWidth,
  validateImageWidth,
} from '../src/document/editor/node-views';
import { BLOCK_NODE_TYPES } from '../src/document/editor/schema';
import {
  MINDMAP_MAX_NODES,
  MINDMAP_MAX_TEXT_LENGTH,
  MindmapEditor,
  PENDING_OBJECT_ID,
  buildDeleteBlockOperation,
  buildPendingObjectInsertOperation,
  buildUpdateObjectOperation,
  addMindmapChild,
  cloneMindmapPayload,
  countMindmapNodes,
  createMindmapPayload,
  deleteMindmapNode,
  findMindmapNode,
  flattenMindmap,
  renameMindmapNode,
  validateMindmapPayload,
  type MindmapPayload,
} from '../src/document/objects';
import { applyOperations as applyHostOperations } from '../host/document/ops.js';
import {
  validateAlterDoc,
  validateObjectPayload,
} from '../host/document/schema.js';
import {
  DocumentError,
  type AlterDoc,
  type BlockNode,
  type JsonValue,
  type OperationContext,
} from '../host/document/types.js';
import type { SpaceDocumentClient } from '../src/space-client';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function file(name: string, type = '', bytes: number[] = [1, 2, 3]): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

// ---------------------------------------------------------------------------
// File-asset upload helpers
// ---------------------------------------------------------------------------

describe('file asset helpers', () => {
  it('registers the alterFile node for block ids', () => {
    expect(BLOCK_NODE_TYPES).toContain('alterFile');
  });

  it('offers the documented extensions in the picker', () => {
    expect(SUPPORTED_FILE_EXTENSIONS).toEqual([
      '.pdf',
      '.txt',
      '.md',
      '.markdown',
      '.csv',
      '.json',
      '.zip',
      '.docx',
      '.xlsx',
      '.pptx',
    ]);
    expect(MAX_FILE_BYTES).toBe(8 * 1024 * 1024);
  });

  it('infers the MIME from File.type or the extension', () => {
    expect(inferFileMime(file('a.pdf', 'application/pdf'))).toBe(
      'application/pdf',
    );
    expect(inferFileMime(file('说明.md'))).toBe('text/markdown');
    expect(inferFileMime(file('data.CSV'))).toBe('text/csv');
    expect(inferFileMime(file('表.xlsx'))).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(inferFileMime(file('unknown.bin'))).toBeUndefined();
    // Non-whitelisted types are rejected even when the browser reports them.
    expect(inferFileMime(file('page.html', 'text/html'))).toBeUndefined();
    expect(inferFileMime(file('no-extension'))).toBeUndefined();
  });

  it('validates the file type and the 8 MiB budget', () => {
    expect(validateFileCard(file('a.pdf', 'application/pdf'))).toBeUndefined();
    expect(validateFileCard(file('a.exe', 'application/octet-stream'))).toContain(
      '不支持的文件类型',
    );
    const oversized = file('big.pdf', 'application/pdf');
    Object.defineProperty(oversized, 'size', {
      value: MAX_FILE_BYTES + 1,
    });
    expect(validateFileCard(oversized)).toContain('8 MiB');
  });

  it('uploads base64 bytes through doc.importFile', async () => {
    const importFile = vi.fn(
      async (input: { mime: string; dataBase64: string; name?: string }) => ({
        assetId: 'asset_file1',
        mime: input.mime,
        bytes: 3,
        name: input.name,
      }),
    );
    const client = { importFile } as unknown as SpaceDocumentClient;
    const result = await uploadFileWithClient(client, file('说明.md'));
    expect(importFile).toHaveBeenCalledTimes(1);
    const input = importFile.mock.calls[0]![0];
    expect(input.mime).toBe('text/markdown');
    expect(input.name).toBe('说明.md');
    expect(input.dataBase64).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(result).toEqual({
      assetId: 'asset_file1',
      mime: 'text/markdown',
      bytes: 3,
      name: '说明.md',
    });
  });

  it('reports a missing file channel and rejects unknown types', async () => {
    const client = {} as SpaceDocumentClient;
    await expect(
      uploadFileWithClient(client, file('a.pdf', 'application/pdf')),
    ).rejects.toThrow('文件上传未启用');
    const importFile = vi.fn();
    const withChannel = { importFile } as unknown as SpaceDocumentClient;
    await expect(
      uploadFileWithClient(withChannel, file('a.bin')),
    ).rejects.toThrow('不支持的文件类型');
    expect(importFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Image attribute helpers
// ---------------------------------------------------------------------------

describe('image attribute helpers', () => {
  it('accepts legal CSS widths and rejects anything else', () => {
    for (const value of ['', '320px', '50%', '12rem', '2em', '80vw', 'auto']) {
      expect(validateImageWidth(value)).toBeUndefined();
    }
    for (const value of [
      '320',
      'calc(100% - 2px)',
      'expression(alert(1))',
      'url(x)',
      '1px; background:red',
      'a'.repeat(33),
    ]) {
      expect(validateImageWidth(value)).toBeTruthy();
    }
    expect(normalizeImageWidth(' 320px ')).toBe('320px');
    expect(normalizeImageWidth('   ')).toBeNull();
  });

  it('formats byte sizes for file cards', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(2048)).toBe('2.0 KB');
    expect(formatFileSize(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatFileSize(Number.NaN)).toBe('未知大小');
  });
});

// ---------------------------------------------------------------------------
// Mindmap payload utilities
// ---------------------------------------------------------------------------

function sampleMindmap(): MindmapPayload {
  return {
    root: {
      id: 'n1',
      text: '中心主题',
      children: [
        { id: 'n2', text: '分支一' },
        { id: 'n3', text: '分支二', children: [{ id: 'n4', text: '子分支' }] },
      ],
    },
  };
}

describe('mindmap payload utilities', () => {
  it('creates and validates payloads', () => {
    const created = createMindmapPayload();
    expect(created.root.text).toBe('中心主题');
    expect(countMindmapNodes(created.root)).toBe(1);
    const validated = validateMindmapPayload(created);
    expect(validated.ok).toBe(true);
    if (validated.ok) expect(validated.payload.root.text).toBe('中心主题');
  });

  it('rejects malformed payloads with readable errors', () => {
    for (const [value, message] of [
      [null, '必须是对象'],
      [{}, '缺少 root'],
      [{ root: { text: 'x' } }, '缺少节点 id'],
      [{ root: { id: 'n1' } }, '缺少节点文本'],
      [{ root: { id: 'n1', text: 'x', children: 'nope' } }, 'children'],
    ] as const) {
      const result = validateMindmapPayload(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(message);
    }
  });

  it('renames, adds and deletes nodes immutably', () => {
    const source = sampleMindmap();
    const renamed = renameMindmapNode(source, 'n2', '改名分支');
    expect(renamed).not.toBe(source);
    expect(findMindmapNode(renamed.root, 'n2')?.text).toBe('改名分支');
    expect(findMindmapNode(source.root, 'n2')?.text).toBe('分支一');

    const added = addMindmapChild(renamed, 'n3');
    expect(added).toBeDefined();
    expect(findMindmapNode(added!.root, 'n3')?.children).toHaveLength(2);
    expect(countMindmapNodes(added!.root)).toBe(5);

    const deleted = deleteMindmapNode(added!, 'n3');
    expect(deleted).toBeDefined();
    expect(findMindmapNode(deleted!.root, 'n3')).toBeUndefined();
    expect(countMindmapNodes(deleted!.root)).toBe(2);
    // Deleting the root is refused; deleting a missing id is a no-op.
    expect(deleteMindmapNode(source, 'n1')).toBeUndefined();
    expect(deleteMindmapNode(source, 'missing')).toBeUndefined();
  });

  it('flattens the tree in display order', () => {
    const rows = flattenMindmap(sampleMindmap().root);
    expect(rows.map((row) => row.node.id)).toEqual(['n1', 'n2', 'n3', 'n4']);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 1, 2]);
  });

  it('enforces the node and text limits', () => {
    let payload = createMindmapPayload('root');
    for (let index = 0; index < MINDMAP_MAX_NODES - 1; index += 1) {
      const next = addMindmapChild(payload, payload.root.id);
      expect(next).toBeDefined();
      payload = next!;
    }
    expect(countMindmapNodes(payload.root)).toBe(MINDMAP_MAX_NODES);
    expect(addMindmapChild(payload, payload.root.id)).toBeUndefined();
    expect(validateMindmapPayload(payload).ok).toBe(true);

    const longText = renameMindmapNode(
      payload,
      payload.root.id,
      'x'.repeat(MINDMAP_MAX_TEXT_LENGTH + 50),
    );
    expect(longText.root.text).toHaveLength(MINDMAP_MAX_TEXT_LENGTH);
    // The Host limit is enforced on load as well.
    const tooLong = validateMindmapPayload({
      root: { id: 'n1', text: 'x'.repeat(MINDMAP_MAX_TEXT_LENGTH + 1) },
    });
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.error).toContain('500');
  });

  it('clones payloads without sharing node objects', () => {
    const source = sampleMindmap();
    const clone = cloneMindmapPayload(source);
    expect(clone).toEqual(source);
    expect(clone.root).not.toBe(source.root);
    expect(clone.root.children?.[0]).not.toBe(source.root.children?.[0]);
  });
});

// ---------------------------------------------------------------------------
// Mindmap Document-Operations batch (real Host engine)
// ---------------------------------------------------------------------------

describe('mindmap Document-Operations batch', () => {
  /**
   * Mimic the real `DocumentService` object factory: it re-reads the *base*
   * document of the batch and fails when the target block does not exist yet.
   * This is what made the old single-batch insert fail in the real GUI.
   */
  function makeContext(baseDoc: AlterDoc): OperationContext {
    let blockSequence = 0;
    let objectSequence = 0;
    const findBlock = (id: string): BlockNode | undefined => {
      const stack: BlockNode[] = [...baseDoc.blocks];
      while (stack.length > 0) {
        const block = stack.pop()!;
        if (block.id === id) return block;
        if (block.children !== undefined) stack.push(...block.children);
      }
      return undefined;
    };
    return {
      docId: 'doc-rich',
      nowIso: () => '2026-11-10T00:00:00.000Z',
      createBlockId: () => `blk_gen_${(blockSequence += 1)}`,
      parseMarkdown: () => {
        throw new Error('unused');
      },
      createObject: ({ blockId, type, payload }) => {
        const block = findBlock(blockId);
        if (block === undefined) {
          throw new DocumentError('node/not-found', `节点不存在：${blockId}`);
        }
        if (block.type !== type) {
          throw new DocumentError('object/invalid', '对象类型与节点不一致');
        }
        validateObjectPayload(type, payload);
        return `obj_gen_${(objectSequence += 1)}`;
      },
    };
  }

  function emptyHostDoc(): AlterDoc {
    return {
      format: 'alter-doc/1',
      schemaVersion: 1,
      revision: 1,
      blocks: [],
    };
  }

  it('first batch inserts a placeholder mindmap block', () => {
    const base = emptyHostDoc();
    const ops = [
      buildPendingObjectInsertOperation({ blockId: 'blk_mm_new', kind: 'mindmap' }),
    ];
    const result = applyHostOperations(base, ops, makeContext(base));
    expect(result.doc.blocks).toHaveLength(1);
    const block = result.doc.blocks[0]!;
    expect(block.type).toBe('mindmap');
    expect(block.id).toBe('blk_mm_new');
    expect(block.attrs.objectId).toBe(PENDING_OBJECT_ID);
    expect(() => validateAlterDoc(result.doc)).not.toThrow();
    // The insert batch is one undo step back to the empty document.
    const undone = applyHostOperations(
      result.doc,
      result.inverseOps,
      makeContext(result.doc),
    );
    expect(undone.doc.blocks).toHaveLength(0);
  });

  it('second batch creates the object and replaces the placeholder ref', () => {
    const base = emptyHostDoc();
    const inserted = applyHostOperations(
      base,
      [buildPendingObjectInsertOperation({ blockId: 'blk_mm_new', kind: 'mindmap' })],
      makeContext(base),
    );
    const payload = createMindmapPayload('中心主题') as unknown as JsonValue;
    const updated = applyHostOperations(
      inserted.doc,
      [buildUpdateObjectOperation('blk_mm_new', payload)],
      makeContext(inserted.doc),
    );
    const block = updated.doc.blocks[0]!;
    expect(block.id).toBe('blk_mm_new');
    expect(block.attrs.objectId).toMatch(/^obj_/);
    expect(block.attrs.objectId).not.toBe(PENDING_OBJECT_ID);
    expect(() => validateAlterDoc(updated.doc)).not.toThrow();
  });

  it('a single batch cannot target the block it just inserted', () => {
    // Regression for the GUI bug: `update_object` resolves its target against
    // the batch's base document, so insert + update must be two batches.
    const base = emptyHostDoc();
    const payload = createMindmapPayload('中心主题') as unknown as JsonValue;
    expect(() =>
      applyHostOperations(
        base,
        [
          buildPendingObjectInsertOperation({
            blockId: 'blk_mm_new',
            kind: 'mindmap',
          }),
          buildUpdateObjectOperation('blk_mm_new', payload),
        ],
        makeContext(base),
      ),
    ).toThrow(/节点不存在/);
  });

  it('cleanup batch removes the placeholder after a failed second batch', () => {
    const base = emptyHostDoc();
    const inserted = applyHostOperations(
      base,
      [buildPendingObjectInsertOperation({ blockId: 'blk_mm_new', kind: 'mindmap' })],
      makeContext(base),
    );
    const cleaned = applyHostOperations(
      inserted.doc,
      [buildDeleteBlockOperation('blk_mm_new')],
      makeContext(inserted.doc),
    );
    expect(cleaned.doc.blocks).toHaveLength(0);
    expect(() => validateAlterDoc(cleaned.doc)).not.toThrow();
  });

  it('update_object batch rewrites the object reference of an existing block', () => {
    const base: AlterDoc = {
      ...emptyHostDoc(),
      blocks: [
        {
          id: 'blk_mm',
          type: 'mindmap',
          attrs: { objectId: 'obj_old', caption: '流程' },
        },
      ],
    };
    const payload = createMindmapPayload('新中心') as unknown as JsonValue;
    const result = applyHostOperations(
      base,
      [buildUpdateObjectOperation('blk_mm', payload)],
      makeContext(base),
    );
    const block = result.doc.blocks[0]!;
    expect(block.id).toBe('blk_mm');
    expect(block.attrs.caption).toBe('流程');
    expect(String(block.attrs.objectId)).toMatch(/^obj_/);
    expect(block.attrs.objectId).not.toBe('obj_old');
    expect(() => validateAlterDoc(result.doc)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Mindmap tree editor dialog
// ---------------------------------------------------------------------------

function renderDialog(
  overrides: Partial<Parameters<typeof MindmapEditor>[0]> = {},
) {
  const onSave = vi.fn();
  const onClose = vi.fn();
  const onReload = vi.fn();
  const props = {
    open: true,
    initial: sampleMindmap(),
    onSave,
    onClose,
    onReload,
    ...overrides,
  };
  render(createElement(MindmapEditor, props));
  return { onSave, onClose, onReload, props };
}

describe('MindmapEditor dialog', () => {
  it('renders the tree and renames nodes', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: '编辑思维导图' });
    expect(within(dialog).getByLabelText('节点文本：中心主题')).toBeTruthy();
    const input = within(dialog).getByLabelText(
      '节点文本：分支一',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '改名分支' } });
    expect(within(dialog).getByLabelText('节点文本：改名分支')).toBeTruthy();
    expect(dialog.textContent).toContain('4 / 500 节点');
  });

  it('adds a child node and deletes a subtree', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: '编辑思维导图' });
    fireEvent.click(
      within(dialog).getByLabelText('新增子节点：分支一'),
    );
    expect(within(dialog).getByLabelText('节点文本：新节点')).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText('删除节点：新节点'));
    expect(within(dialog).queryByLabelText('节点文本：新节点')).toBeNull();
    // Deleting the root is not offered.
    expect(within(dialog).queryByLabelText('删除节点：中心主题')).toBeNull();
    fireEvent.click(within(dialog).getByLabelText('删除节点：分支二'));
    expect(within(dialog).queryByLabelText('节点文本：子分支')).toBeNull();
  });

  it('saves the edited payload and closes on Escape', () => {
    const { onSave, onClose } = renderDialog();
    const dialog = screen.getByRole('dialog', { name: '编辑思维导图' });
    fireEvent.change(
      within(dialog).getByLabelText('节点文本：中心主题'),
      { target: { value: '新的中心' } },
    );
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0]![0] as MindmapPayload;
    expect(saved.root.text).toBe('新的中心');
    expect(countMindmapNodes(saved.root)).toBe(4);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows load errors, conflicts and the reload action', () => {
    const { onReload } = renderDialog({
      initial: null,
      loading: false,
      error: '思维导图对象不存在或已被删除',
      conflict: true,
    });
    const dialog = screen.getByRole('dialog', { name: '编辑思维导图' });
    expect(within(dialog).getByRole('alert').textContent).toContain(
      '思维导图对象不存在',
    );
    fireEvent.click(
      within(dialog).getByRole('button', { name: '重新加载文档' }),
    );
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('shows the loading state while the payload is fetched', () => {
    renderDialog({ initial: null, loading: true });
    const dialog = screen.getByRole('dialog', { name: '编辑思维导图' });
    expect(dialog.textContent).toContain('正在加载思维导图');
  });

  it('reports local node-limit errors instead of exceeding the cap', () => {
    // Build a payload at the node cap and try to add one more.
    let payload = createMindmapPayload('root');
    for (let index = 0; index < MINDMAP_MAX_NODES - 1; index += 1) {
      payload = addMindmapChild(payload, payload.root.id)!;
    }
    renderDialog({ initial: payload });
    const dialog = screen.getByRole('dialog', { name: '编辑思维导图' });
    fireEvent.click(within(dialog).getByLabelText('新增子节点：root'));
    expect(within(dialog).getByRole('alert').textContent).toContain('500');
  });
});
