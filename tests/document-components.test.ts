// @vitest-environment jsdom
/**
 * P4 declarative component v1.
 *
 * Covers the shared catalog contract (validation + AI capability), safe
 * rendering of the three built-in components, the picker/props-editor forms,
 * the two-batch insert flow and props updates against the real Host
 * Document-Operations engine.
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
  COMPONENT_CATALOG,
  getComponentDefinition,
  validateComponentPayload,
  type ComponentPayload,
} from '@alter/protocol';
import {
  DocumentError,
  type AlterDoc,
  type BlockNode,
  type JsonValue,
  type OperationContext,
} from '../host/document/types.js';
import {
  validateAlterDoc,
  validateObjectPayload,
} from '../host/document/schema.js';
import { applyOperations } from '../host/document/ops.js';
import {
  registerDocumentTools,
  type ToolDefinitionLike,
  type ToolsLike,
} from '../host/document/tools.js';
import type { DocumentService } from '../host/document/service.js';
import {
  PENDING_OBJECT_ID,
  buildDeleteBlockOperation,
  buildPendingObjectInsertOperation,
  buildUpdateObjectOperation,
} from '../src/document/objects';
import {
  ChecklistComponent,
  ComponentFallbackCard,
  ComponentPicker,
  ComponentRenderer,
  ProgressComponent,
  PropsEditor,
  StatComponent,
  clearComponentObjectStates,
  componentPayloadOf,
  createDefaultComponentPayload,
} from '../src/document/components';

afterEach(() => {
  cleanup();
  clearComponentObjectStates();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Catalog fixtures / validation
// ---------------------------------------------------------------------------

function payloadOf(componentId: string): ComponentPayload {
  const payload = createDefaultComponentPayload(componentId);
  if (payload === undefined) throw new Error(`missing catalog entry ${componentId}`);
  return payload;
}

describe('component catalog validation', () => {
  it('ships exactly the three built-in safe components', () => {
    expect(COMPONENT_CATALOG.map((definition) => definition.id)).toEqual([
      'builtin/progress',
      'builtin/checklist',
      'builtin/stat',
    ]);
    expect(getComponentDefinition('builtin/progress')?.name).toBe('进度');
    expect(getComponentDefinition('builtin/missing')).toBeUndefined();
  });

  it('accepts the defaults of every catalog component', () => {
    for (const definition of COMPONENT_CATALOG) {
      expect(validateComponentPayload(payloadOf(definition.id))).toEqual([]);
    }
  });

  it('rejects malformed envelopes, unknown components and version drift', () => {
    expect(validateComponentPayload(null)).toEqual([
      'component payload 必须是对象',
    ]);
    expect(
      validateComponentPayload({ ...payloadOf('builtin/progress'), format: 'x' }),
    ).toEqual(['component payload 的 format 必须是 alter-component/1']);
    expect(
      validateComponentPayload({
        format: 'alter-component/1',
        componentId: 'builtin/missing',
        componentVersion: 1,
        props: {},
      }),
    ).toEqual(['未知组件：builtin/missing']);
    expect(
      validateComponentPayload({
        ...payloadOf('builtin/progress'),
        componentVersion: 2,
      }),
    ).toEqual([
      '组件 builtin/progress 的版本不受支持：2（当前 1）',
    ]);
  });

  it('rejects unknown props, wrong types, required gaps and bounds', () => {
    const progress = payloadOf('builtin/progress');
    expect(
      validateComponentPayload({
        ...progress,
        props: { label: '进度', value: 50, extra: true },
      }),
    ).toEqual(['组件 builtin/progress 不支持属性 extra']);
    expect(
      validateComponentPayload({ ...progress, props: { value: 50 } }),
    ).toEqual(['组件 builtin/progress 的属性 标题（label） 必填']);
    expect(
      validateComponentPayload({
        ...progress,
        props: { label: '进度', value: '50' },
      }),
    ).toEqual(['属性 进度（value） 必须是数字']);
    expect(
      validateComponentPayload({
        ...progress,
        props: { label: '进度', value: 150 },
      }),
    ).toEqual(['属性 进度（value） 不能大于 100']);
    expect(
      validateComponentPayload({
        ...progress,
        props: { label: '进度', value: -1 },
      }),
    ).toEqual(['属性 进度（value） 不能小于 0']);
    expect(
      validateComponentPayload({
        ...progress,
        props: { label: 'x'.repeat(81), value: 50 },
      }),
    ).toEqual(['属性 标题（label） 超过长度上限 80']);
  });

  it('enforces list limits for the checklist component', () => {
    const checklist = payloadOf('builtin/checklist');
    expect(
      validateComponentPayload({
        ...checklist,
        props: { title: '清单', items: [] },
      }),
    ).toEqual(['属性 清单项（items） 至少需要 1 项']);
    expect(
      validateComponentPayload({
        ...checklist,
        props: {
          title: '清单',
          items: Array.from({ length: 21 }, (_, index) => `项 ${index}`),
        },
      }),
    ).toEqual(['属性 清单项（items） 最多 20 项']);
    expect(
      validateComponentPayload({
        ...checklist,
        props: { title: '清单', items: ['x'.repeat(121)] },
      }),
    ).toEqual(['属性 清单项（items） 的第 1 项超过长度上限 120']);
    expect(
      validateComponentPayload({
        ...checklist,
        props: { title: '清单', items: 'not-a-list' },
      }),
    ).toEqual(['属性 清单项（items） 必须是字符串数组']);
  });

  it('fails closed in the Host object validator', () => {
    expect(() =>
      validateObjectPayload('component', payloadOf('builtin/progress')),
    ).not.toThrow();
    expect(() =>
      validateObjectPayload('component', {
        format: 'alter-component/1',
        componentId: 'builtin/progress',
        componentVersion: 1,
        props: { label: '进度', value: 101 },
      }),
    ).toThrow(/不能大于 100/);
    expect(() =>
      validateObjectPayload('component', {
        format: 'alter-component/1',
        componentId: 'builtin/missing',
        componentVersion: 1,
        props: {},
      }),
    ).toThrow(/未知组件/);
    expect(() =>
      validateObjectPayload('component', {
        format: 'alter-component/1',
        componentId: 'builtin/progress',
        componentVersion: 1,
        props: { label: '进度', value: 50, renderer: 'x' },
      }),
    ).toThrow(/不支持属性 renderer/);
  });

  it('reads payloads from object records and builds defaults', () => {
    const record = { payload: payloadOf('builtin/stat') };
    expect(componentPayloadOf(record)?.componentId).toBe('builtin/stat');
    expect(componentPayloadOf({ payload: { format: 'other' } })).toBeUndefined();
    expect(componentPayloadOf(undefined)).toBeUndefined();
    expect(createDefaultComponentPayload('builtin/missing')).toBeUndefined();
    expect(validateComponentPayload(payloadOf('builtin/checklist'))).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// Safe rendering
// ---------------------------------------------------------------------------

describe('component registry rendering', () => {
  it('renders the progress component as a safe progress bar', () => {
    render(createElement(ProgressComponent, { payload: payloadOf('builtin/progress') }));
    expect(screen.getByText('任务进度')).toBeTruthy();
    const bar = screen.getByRole('progressbar', { name: '任务进度' });
    expect(bar.getAttribute('aria-valuenow')).toBe('60');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
  });

  it('renders the checklist and keeps check state local', () => {
    render(
      createElement(ChecklistComponent, {
        payload: payloadOf('builtin/checklist'),
      }),
    );
    expect(screen.getByText('检查清单')).toBeTruthy();
    expect(screen.getByText('勾选状态仅本地预览，不写入文档')).toBeTruthy();
    const checkbox = screen.getByRole('checkbox', {
      name: '第一项',
    }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
  });

  it('renders the stat component with its hint', () => {
    render(createElement(StatComponent, { payload: payloadOf('builtin/stat') }));
    expect(screen.getByText('核心指标')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('较昨日 +5')).toBeTruthy();
  });

  it('degrades unknown and invalid payloads to a readable card', () => {
    const unknown = {
      format: 'alter-component/1',
      componentId: 'builtin/missing',
      componentVersion: 1,
      props: {},
    } as ComponentPayload;
    const first = render(createElement(ComponentRenderer, { payload: unknown }));
    expect(screen.getByText(/未知组件：builtin\/missing/)).toBeTruthy();
    first.unmount();

    const invalid = {
      ...payloadOf('builtin/progress'),
      props: { label: '进度', value: 150 },
    };
    render(createElement(ComponentRenderer, { payload: invalid }));
    expect(screen.getByText(/不能大于 100/)).toBeTruthy();
    expect(
      document.querySelectorAll('[data-component-fallback="true"]'),
    ).toHaveLength(1);
  });

  it('renders a fallback card for a broken renderer payload', () => {
    render(
      createElement(ComponentFallbackCard, {
        payload: payloadOf('builtin/stat'),
        message: '组件渲染失败',
      }),
    );
    expect(screen.getByText('组件渲染失败')).toBeTruthy();
    expect(screen.getByText('builtin/stat')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Picker and props editor forms
// ---------------------------------------------------------------------------

describe('component picker', () => {
  it('lists the catalog and reports the picked component', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      createElement(ComponentPicker, {
        open: true,
        onSelect,
        onClose,
      }),
    );
    const dialog = screen.getByRole('dialog', { name: '插入组件' });
    expect(
      within(dialog).getByText(/文档只保存组件 id 与 props/),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: /进度/ }));
    expect(onSelect).toHaveBeenCalledWith('builtin/progress');
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('component props editor', () => {
  it('edits props and saves a catalog-valid payload', () => {
    const onSave = vi.fn();
    render(
      createElement(PropsEditor, {
        open: true,
        initial: payloadOf('builtin/progress'),
        onSave,
        onClose: () => {},
      }),
    );
    const dialog = screen.getByRole('dialog', { name: '编辑组件' });
    const label = within(dialog).getByLabelText('标题') as HTMLInputElement;
    expect(label.value).toBe('任务进度');
    fireEvent.change(label, { target: { value: '新进度' } });
    fireEvent.change(within(dialog).getByLabelText('进度'), {
      target: { value: '80' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      format: 'alter-component/1',
      componentId: 'builtin/progress',
      componentVersion: 1,
      props: { label: '新进度', value: 80 },
    });
  });

  it('blocks out-of-range and required-gap saves in the dialog', () => {
    const onSave = vi.fn();
    render(
      createElement(PropsEditor, {
        open: true,
        initial: payloadOf('builtin/progress'),
        onSave,
        onClose: () => {},
      }),
    );
    const dialog = screen.getByRole('dialog', { name: '编辑组件' });
    fireEvent.change(within(dialog).getByLabelText('进度'), {
      target: { value: '150' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('alert').textContent).toContain(
      '不能大于 100',
    );
    fireEvent.change(within(dialog).getByLabelText('标题'), {
      target: { value: '' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(within(dialog).getByRole('alert').textContent).toContain(
      '不能为空',
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it('edits a string list and drops cleared optional fields', () => {
    const onSave = vi.fn();
    render(
      createElement(PropsEditor, {
        open: true,
        initial: payloadOf('builtin/checklist'),
        onSave,
        onClose: () => {},
      }),
    );
    const dialog = screen.getByRole('dialog', { name: '编辑组件' });
    fireEvent.change(within(dialog).getByLabelText('清单项'), {
      target: { value: '甲\n乙\n\n丙' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      props: { title: '检查清单', items: ['甲', '乙', '丙'] },
    });
  });

  it('removes an emptied optional prop instead of failing', () => {
    const onSave = vi.fn();
    render(
      createElement(PropsEditor, {
        open: true,
        initial: payloadOf('builtin/stat'),
        onSave,
        onClose: () => {},
      }),
    );
    const dialog = screen.getByRole('dialog', { name: '编辑组件' });
    fireEvent.change(within(dialog).getByLabelText('说明'), {
      target: { value: '' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      props: { label: '核心指标', value: '42' },
    });
    expect(
      (onSave.mock.calls[0]![0] as ComponentPayload).props['hint'],
    ).toBeUndefined();
  });

  it('offers a document reload after a conflict', () => {
    const onReload = vi.fn();
    render(
      createElement(PropsEditor, {
        open: true,
        initial: payloadOf('builtin/stat'),
        error: '文档已被其他修改更新，请重新加载后再保存',
        conflict: true,
        onSave: () => {},
        onClose: () => {},
        onReload,
      }),
    );
    const dialog = screen.getByRole('dialog', { name: '编辑组件' });
    fireEvent.click(
      within(dialog).getByRole('button', { name: '重新加载文档' }),
    );
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Document-Operations flows (real Host engine)
// ---------------------------------------------------------------------------

function emptyDoc(): AlterDoc {
  return {
    format: 'alter-doc/1',
    schemaVersion: 1,
    revision: 1,
    blocks: [],
  };
}

/** Mimic the real DocumentService object factory: target must already exist. */
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
    docId: 'doc-components',
    nowIso: () => '2026-11-10T00:00:00.000Z',
    createBlockId: () => `blk_gen_${(blockSequence += 1)}`,
    parseMarkdown: () => {
      throw new Error('unused');
    },
    createObject: ({ blockId, type, payload }) => {
      const block = findBlock(blockId);
      if (block === undefined)
        throw new DocumentError('node/not-found', `节点不存在：${blockId}`);
      if (block.type !== type)
        throw new DocumentError('object/invalid', '对象类型与节点不一致');
      validateObjectPayload(type, payload);
      return `obj_gen_${(objectSequence += 1)}`;
    },
  };
}

describe('component Document-Operations batch', () => {
  it('inserts a placeholder component block first', () => {
    const base = emptyDoc();
    const result = applyOperations(
      base,
      [
        buildPendingObjectInsertOperation({
          blockId: 'blk_cmp_new',
          kind: 'component',
        }),
      ],
      makeContext(base),
    );
    expect(result.doc.blocks).toHaveLength(1);
    const block = result.doc.blocks[0]!;
    expect(block.type).toBe('component');
    expect(block.attrs.objectId).toBe(PENDING_OBJECT_ID);
    expect(() => validateAlterDoc(result.doc)).not.toThrow();
  });

  it('creates the catalog object in the second batch', () => {
    const base = emptyDoc();
    const inserted = applyOperations(
      base,
      [
        buildPendingObjectInsertOperation({
          blockId: 'blk_cmp_new',
          kind: 'component',
        }),
      ],
      makeContext(base),
    );
    const payload = payloadOf('builtin/progress') as unknown as JsonValue;
    const updated = applyOperations(
      inserted.doc,
      [buildUpdateObjectOperation('blk_cmp_new', payload)],
      makeContext(inserted.doc),
    );
    const block = updated.doc.blocks[0]!;
    expect(block.id).toBe('blk_cmp_new');
    expect(block.attrs.objectId).toMatch(/^obj_gen_/);
    expect(() => validateAlterDoc(updated.doc)).not.toThrow();
  });

  it('cannot target the block inserted in the same batch', () => {
    const base = emptyDoc();
    expect(() =>
      applyOperations(
        base,
        [
          buildPendingObjectInsertOperation({
            blockId: 'blk_cmp_new',
            kind: 'component',
          }),
          buildUpdateObjectOperation(
            'blk_cmp_new',
            payloadOf('builtin/progress') as unknown as JsonValue,
          ),
        ],
        makeContext(base),
      ),
    ).toThrow(/节点不存在/);
  });

  it('cleans up the placeholder after a failed second batch', () => {
    const base = emptyDoc();
    const inserted = applyOperations(
      base,
      [
        buildPendingObjectInsertOperation({
          blockId: 'blk_cmp_new',
          kind: 'component',
        }),
      ],
      makeContext(base),
    );
    const cleaned = applyOperations(
      inserted.doc,
      [buildDeleteBlockOperation('blk_cmp_new')],
      makeContext(inserted.doc),
    );
    expect(cleaned.doc.blocks).toHaveLength(0);
  });

  it('rejects invalid component payloads fail-closed', () => {
    const base: AlterDoc = {
      ...emptyDoc(),
      blocks: [
        {
          id: 'blk_cmp',
          type: 'component',
          attrs: { objectId: 'obj_old' },
        },
      ],
    };
    expect(() =>
      applyOperations(
        base,
        [
          buildUpdateObjectOperation('blk_cmp', {
            format: 'alter-component/1',
            componentId: 'builtin/progress',
            componentVersion: 1,
            props: { label: '进度', value: 999 },
          } as unknown as JsonValue),
        ],
        makeContext(base),
      ),
    ).toThrow(/不能大于 100/);
  });

  it('updates props through update_object with a new immutable object', () => {
    const base: AlterDoc = {
      ...emptyDoc(),
      blocks: [
        {
          id: 'blk_cmp',
          type: 'component',
          attrs: { objectId: 'obj_old', title: '进度' },
        },
      ],
    };
    const payload = {
      ...payloadOf('builtin/progress'),
      props: { label: '新进度', value: 80 },
    } as unknown as JsonValue;
    const result = applyOperations(
      base,
      [buildUpdateObjectOperation('blk_cmp', payload)],
      makeContext(base),
    );
    const block = result.doc.blocks[0]!;
    expect(block.id).toBe('blk_cmp');
    expect(block.attrs.title).toBe('进度');
    expect(String(block.attrs.objectId)).toMatch(/^obj_gen_/);
    expect(() => validateAlterDoc(result.doc)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AI capability declaration
// ---------------------------------------------------------------------------

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

const exec = (name: string) => ({
  callId: name,
  name,
  arguments: {},
  signal: new AbortController().signal,
});

describe('component AI capability', () => {
  it('exposes the catalog through a read-only tool and validates fail-closed', async () => {
    const { tools, definitions } = fakeTools();
    const dispose = registerDocumentTools(tools, {
      service: {} as unknown as DocumentService,
    });
    try {
      expect(definitions.size).toBe(11);
      const definition = definitions.get('space_component_catalog')!;
      expect(definition.isConcurrencySafe?.({})).toBe(true);
      const value = (await definition.execute(
        {},
        exec('space_component_catalog'),
      )) as {
        components: Array<{
          id: string;
          ai_writable: string[];
          defaults: Record<string, JsonValue>;
          props: Record<string, Record<string, JsonValue>>;
        }>;
      };
      expect(value.components.map((component) => component.id)).toEqual([
        'builtin/progress',
        'builtin/checklist',
        'builtin/stat',
      ]);
      const progress = value.components[0]!;
      expect(progress.ai_writable).toEqual(['label', 'value']);
      expect(progress.defaults).toEqual({ label: '任务进度', value: 60 });
      expect(progress.props['label']).toMatchObject({
        type: 'string',
        label: '标题',
        required: true,
        max_length: 80,
      });
      expect(progress.props['value']).toMatchObject({
        type: 'number',
        min: 0,
        max: 100,
      });
      const rendered = definition.output.render({}, value)[0]?.text ?? '';
      expect(rendered).toContain('builtin/progress');
      expect(rendered).toContain('AI 可写');
      expect(
        definitions.get('space_object_update')?.description,
      ).toContain('space_component_catalog');
    } finally {
      dispose();
    }
  });

  it('rejects unknown props through the Host validator used by update_object', () => {
    expect(() =>
      validateObjectPayload('component', {
        format: 'alter-component/1',
        componentId: 'builtin/stat',
        componentVersion: 1,
        props: { label: '指标', value: '42', extra: 1 },
      }),
    ).toThrow(/不支持属性 extra/);
  });
});
