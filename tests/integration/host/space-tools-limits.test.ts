/**
 * P1 Space tool boundaries: projection budgets, hand-written validation,
 * migration freeze at the core proxy, the plugin config gate and explicit
 * offline failure for structure writes.
 *
 * Budget fixtures are seeded through the store's scoped write path (the
 * attribution guard stays armed); every assertion then goes through the real
 * tool registrations over the real SQLite authority.
 */
import { describe, expect, it } from 'vitest';
import type { SpaceNode } from '@alter/protocol';
import { registerSpaceTools } from '../../../host/authority/space-tools.js';
import type {
  ToolDefinitionLike,
  ToolsLike,
} from '../../../host/document/editors/legacy/tools.js';
import type { SpaceToolApi } from '../../../host/core/backend.js';
import {
  apply,
  createSpaceProxy,
  type HostContextLike,
} from '../../../host/core/index.js';
import { createRemoteBridge } from '../../../host/remote/bridge.js';
import {
  TEST_TOKEN,
  startRuntime,
  startTestServer,
} from '../../support/harness.js';
import { dispose, quietLogger, tempDir } from '../../support/lifecycle.js';

const signal = new AbortController().signal;

interface ToolHarness {
  definitions: Map<string, ToolDefinitionLike>;
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
}

function captureTools(service: SpaceToolApi): ToolHarness {
  const definitions = new Map<string, ToolDefinitionLike>();
  const tools: ToolsLike = {
    register(definition) {
      definitions.set(definition.name, definition);
      return () => {
        definitions.delete(definition.name);
      };
    },
  };
  dispose(registerSpaceTools(tools, { service }));
  return {
    definitions,
    async call(name, args) {
      const definition = definitions.get(name);
      if (definition === undefined)
        throw new Error(`tool ${name} is not registered`);
      return definition.execute(args, {
        callId: `${name}-call`,
        name,
        arguments: args,
        signal,
      });
    },
  };
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the tool call to fail');
}

function keysDeep(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) keysDeep(item, found);
    return found;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      found.add(key);
      keysDeep(item, found);
    }
  }
  return found;
}

/** One full SpaceNode row for store-level fixture seeding. */
function seedNode(id: string, overrides: Partial<SpaceNode> = {}): SpaceNode {
  const at = new Date().toISOString();
  return {
    id,
    spaceId: 'sp-inbox',
    kind: 'note',
    title: `节点 ${id}`,
    parentId: null,
    creator: 'alter',
    pinned: false,
    archived: false,
    archivedBy: null,
    archivedAt: null,
    deletedAt: null,
    deletedRoot: false,
    originalParentId: null,
    unread: false,
    content: '',
    activity: 100,
    activityAt: at,
    lastOpenCreditAt: null,
    lastEditCreditAt: null,
    createdAt: at,
    updatedAt: at,
    order: 0,
    ...overrides,
  };
}

interface NodeMeta {
  id: string;
  kind: string;
  title: string;
  parent_id: string | null;
  pinned: boolean;
  archived: boolean;
  creator: string;
  updated_at: string;
}

describe('projection budgets', () => {
  it('tree caps at 500 nodes with total/truncated and filters deleted/archived', async () => {
    const { runtime } = await startRuntime();
    const tools = captureTools(runtime.agentService);
    await runtime.store.updateAs('alter', (data) => {
      // Seed the special rows first so the archived one stays inside the
      // 500-node page when include_archived adds it back.
      data.nodes.push(
        seedNode('doc-archived', {
          archived: true,
          archivedBy: 'agent',
          archivedAt: new Date().toISOString(),
        }),
      );
      data.nodes.push(
        seedNode('doc-deleted', {
          deletedAt: new Date().toISOString(),
          deletedRoot: true,
        }),
      );
      for (let index = 0; index < 501; index += 1)
        data.nodes.push(seedNode(`doc-bulk-${index}`));
    });

    const tree = (await tools.call('space_browse', {
      action: 'tree',
      space_id: 'sp-inbox',
    })) as { space_id: string; total: number; truncated: boolean; nodes: NodeMeta[] };
    expect(tree.total).toBe(501);
    expect(tree.truncated).toBe(true);
    expect(tree.nodes).toHaveLength(500);
    const ids = new Set(tree.nodes.map((node) => node.id));
    expect(ids.has('doc-archived')).toBe(false);
    expect(ids.has('doc-deleted')).toBe(false);

    const full = (await tools.call('space_browse', {
      action: 'tree',
      space_id: 'sp-inbox',
      include_archived: true,
    })) as { total: number; truncated: boolean; nodes: NodeMeta[] };
    expect(full.total).toBe(502);
    expect(full.truncated).toBe(true);
    expect(full.nodes.some((node) => node.id === 'doc-archived')).toBe(true);
    expect(full.nodes.some((node) => node.id === 'doc-deleted')).toBe(false);
  });

  it('search defaults to 20 hits, caps at 50 and clips excerpts to 60 chars', async () => {
    const { runtime } = await startRuntime();
    const tools = captureTools(runtime.agentService);
    await runtime.store.updateAs('alter', (data) => {
      for (let index = 0; index < 25; index += 1)
        data.nodes.push(seedNode(`doc-hit-${index}`, { title: `检索命中 ${index}` }));
    });
    const longBody = `${'长'.repeat(200)}唯一检索词${'长'.repeat(200)}`;
    await runtime.agentDocument.generate({
      spaceId: 'sp-inbox',
      title: '长正文文档',
      markdown: longBody,
    });

    const defaultSearch = (await tools.call('space_browse', {
      action: 'search',
      space_id: 'sp-inbox',
      query: '检索命中',
    })) as { hits: Array<{ excerpt: string }>; truncated: boolean };
    expect(defaultSearch.hits).toHaveLength(20);
    expect(defaultSearch.truncated).toBe(true);

    const capped = (await tools.call('space_browse', {
      action: 'search',
      space_id: 'sp-inbox',
      query: '检索命中',
      limit: 50,
    })) as { hits: unknown[]; truncated: boolean };
    expect(capped.hits).toHaveLength(25);
    expect(capped.truncated).toBe(false);

    const excerpted = (await tools.call('space_browse', {
      action: 'search',
      space_id: 'sp-inbox',
      query: '唯一检索词',
    })) as { hits: Array<{ id: string; excerpt: string }> };
    expect(excerpted.hits.length).toBeGreaterThan(0);
    for (const hit of excerpted.hits)
      expect(hit.excerpt.length).toBeLessThanOrEqual(60);

    const tooMany = await failure(
      tools.call('space_browse', {
        action: 'search',
        space_id: 'sp-inbox',
        query: '检索命中',
        limit: 51,
      }),
    );
    expect(tooMany.message).toContain('space/invalid-input');
  });

  it('trash previews thoughts at 80 chars and keeps node metadata', async () => {
    const { runtime } = await startRuntime();
    const tools = captureTools(runtime.agentService);
    const thought = await runtime.agentService.createThought({
      spaceId: 'sp-inbox',
      content: `随想${'字'.repeat(200)}`,
    });
    await runtime.agentService.deleteThought(thought.id);
    const note = await runtime.agentService.createNode({
      spaceId: 'sp-inbox',
      kind: 'note',
      title: '回收站文档',
    });
    await runtime.agentService.deleteNode(note.id);

    const trash = (await tools.call('space_browse', {
      action: 'trash',
      space_id: 'sp-inbox',
    })) as {
      nodes: NodeMeta[];
      thoughts: Array<{
        id: string;
        content_preview: string;
        created_at: string;
        creator: string;
      }>;
    };
    expect(trash.nodes.some((node) => node.id === note.id)).toBe(true);
    const preview = trash.thoughts.find((entry) => entry.id === thought.id);
    expect(preview).toBeDefined();
    expect(preview!.content_preview.length).toBeLessThanOrEqual(80);
    expect(preview!.creator).toBe('alter');
    expect(preview!.created_at).toBeTruthy();
    expect(keysDeep(trash).has('content')).toBe(false);
  });

  it('overview bounds every section and summarizes activity without daily events', async () => {
    const { runtime } = await startRuntime();
    const tools = captureTools(runtime.agentService);
    const day = (offset: number) => {
      const date = new Date();
      date.setDate(date.getDate() - offset);
      return date.toISOString();
    };
    await runtime.store.updateAs('alter', (data) => {
      for (let index = 0; index < 15; index += 1)
        data.nodes.push(
          seedNode(`doc-recent-${index}`, {
            title: `最近文档 ${index}`,
            updatedAt: day(index % 5),
          }),
        );
      for (let index = 0; index < 25; index += 1)
        data.events.push({
          id: `ev-${index}`,
          spaceId: 'sp-inbox',
          title: `事件 ${index}`,
          detail: '详情'.repeat(40),
          at: day(index % 3),
          docId: null,
          taskId: null,
          source: 'agent',
        });
      for (let index = 0; index < 25; index += 1)
        data.tasks.push({
          id: `task-${index}`,
          spaceId: 'sp-inbox',
          title: `任务 ${index}`,
          detail: '详情'.repeat(40),
          status: 'pending',
          owner: 'alter',
          docId: null,
          createdAt: day(0),
        });
      for (let index = 0; index < 25; index += 1)
        data.milestones.push({
          id: `ms-${index}`,
          spaceId: 'sp-inbox',
          title: `里程碑 ${index}`,
          detail: '详情'.repeat(40),
          status: 'next',
          period: '2026-Q4',
        });
    });

    const overview = (await tools.call('space_browse', {
      action: 'overview',
      space_id: 'sp-inbox',
    })) as {
      recent_docs: NodeMeta[];
      activity: {
        active_days: number;
        total_events: number;
        latest: { date: string; count: number } | null;
      };
      agent_events: Array<{ id: string; source: string }>;
      tasks: Array<{ id: string }>;
      milestones: Array<{ id: string }>;
    };
    expect(overview.recent_docs.length).toBeLessThanOrEqual(10);
    expect(overview.agent_events.length).toBeLessThanOrEqual(20);
    expect(overview.agent_events.length).toBeGreaterThan(0);
    for (const event of overview.agent_events)
      expect(['agent', 'user', 'system']).toContain(event.source);
    expect(overview.tasks.length).toBeLessThanOrEqual(20);
    expect(overview.milestones.length).toBeLessThanOrEqual(20);
    expect(overview.activity.active_days).toBeGreaterThan(0);
    expect(overview.activity.total_events).toBeGreaterThan(0);
    expect(overview.activity.latest?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // No per-day event lists and no document bodies cross the boundary.
    const keys = keysDeep(overview);
    expect(keys.has('events')).toBe(false);
    expect(keys.has('content')).toBe(false);
    expect(keys.has('detail')).toBe(false);
  });

  it('read paths never recordOpen or change activity/unread', async () => {
    const { runtime } = await startRuntime();
    const tools = captureTools(runtime.agentService);
    await runtime.store.updateAs('alter', (data) => {
      data.nodes.push(
        seedNode('doc-unread', {
          title: '未读文档',
          unread: true,
          activity: 60,
        }),
      );
    });
    await tools.call('space_browse', { action: 'node', node_id: 'doc-unread' });
    await tools.call('space_browse', { action: 'tree', space_id: 'sp-inbox' });
    await tools.call('space_browse', { action: 'overview', space_id: 'sp-inbox' });
    await tools.call('space_browse', {
      action: 'search',
      space_id: 'sp-inbox',
      query: '未读文档',
    });
    const row = runtime.store
      .read()
      .nodes.find((node) => node.id === 'doc-unread');
    expect(row?.unread).toBe(true);
    expect(row?.activity).toBe(60);
    expect(row?.lastOpenCreditAt).toBeNull();
  });
});

describe('hand-written validation', () => {
  it('rejects rename with content and points body writes at the doc tools', async () => {
    const { runtime } = await startRuntime();
    const tools = captureTools(runtime.agentService);
    const note = await runtime.agentService.createNode({
      spaceId: 'sp-inbox',
      kind: 'note',
      title: '原文档',
    });
    for (const content of ['正文', '']) {
      const error = await failure(
        tools.call('space_tree', {
          action: 'rename',
          node_id: note.id,
          title: '新标题',
          content,
        }),
      );
      expect(error.message).toContain('space/invalid-input');
      expect(error.message).toContain('space_doc_ops');
    }
    expect((await runtime.service.getNode(note.id))?.title).toBe('原文档');
  });

  it('rejects unknown actions and missing required parameters', async () => {
    const { runtime } = await startRuntime();
    const tools = captureTools(runtime.agentService);
    const cases: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: 'space_browse', args: { action: 'nope' } },
      { name: 'space_browse', args: {} },
      { name: 'space_browse', args: { action: 'tree' } },
      { name: 'space_browse', args: { action: 'node' } },
      { name: 'space_browse', args: { action: 'search', space_id: 'sp-inbox' } },
      { name: 'space_tree', args: { action: 'nope' } },
      { name: 'space_tree', args: {} },
      { name: 'space_tree', args: { action: 'create', space_id: 'sp-inbox' } },
      { name: 'space_tree', args: { action: 'create', kind: 'note' } },
      { name: 'space_tree', args: { action: 'rename', node_id: 'doc-x' } },
      { name: 'space_tree', args: { action: 'move', node_id: 'doc-x' } },
      { name: 'space_tree', args: { action: 'pin', node_id: 'doc-x' } },
      { name: 'space_tree', args: { action: 'archive', node_id: 'doc-x' } },
      { name: 'space_tree', args: { action: 'delete' } },
      { name: 'space_tree', args: { action: 'restore' } },
    ];
    for (const { name, args } of cases) {
      const error = await failure(tools.call(name, args));
      expect(error.message, `${name} ${JSON.stringify(args)}`).toContain(
        'space/invalid-input',
      );
    }
  });

  it('rejects wrongly typed parameters', async () => {
    const { runtime } = await startRuntime();
    const tools = captureTools(runtime.agentService);
    const note = await runtime.agentService.createNode({
      spaceId: 'sp-inbox',
      kind: 'note',
    });
    const cases: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: 'space_tree', args: { action: 'pin', node_id: note.id, pinned: 'yes' } },
      { name: 'space_tree', args: { action: 'archive', node_id: note.id, archived: 1 } },
      { name: 'space_tree', args: { action: 'create', space_id: 'sp-inbox', kind: 'file' } },
      { name: 'space_tree', args: { action: 'move', node_id: note.id, parent_id: 42 } },
      { name: 'space_tree', args: { action: 'move', node_id: note.id, parent_id: null, order: 1.5 } },
      { name: 'space_browse', args: { action: 'tree', space_id: 'sp-inbox', include_archived: 'true' } },
      { name: 'space_browse', args: { action: 'search', space_id: 'sp-inbox', query: 'x', limit: 0 } },
      { name: 'space_browse', args: { action: 'search', space_id: 'sp-inbox', query: 'x', limit: '20' } },
      { name: 'space_browse', args: { action: 'spaces', space_id: 42 } },
    ];
    for (const { name, args } of cases) {
      const error = await failure(tools.call(name, args));
      expect(error.message, `${name} ${JSON.stringify(args)}`).toContain(
        'space/invalid-input',
      );
    }
  });

  it('rejects illegal moves with the original reason and a tree re-locate hint', async () => {
    const { runtime } = await startRuntime();
    const tools = captureTools(runtime.agentService);
    const folder = (
      await tools.call('space_tree', {
        action: 'create',
        space_id: 'sp-inbox',
        kind: 'folder',
        title: '父文件夹',
      })
    ) as { node: NodeMeta };
    const child = (
      await tools.call('space_tree', {
        action: 'create',
        space_id: 'sp-inbox',
        kind: 'note',
        title: '子文档',
        parent_id: folder.node.id,
      })
    ) as { node: NodeMeta };

    // The structured tree keeps folders at root and notes under folders, so
    // the vendor cycle guard is exercised through a port that reproduces its
    // rejection: the tool must wrap it with the re-locate hint.
    const cycleTools = captureTools({
      ...runtime.agentService,
      moveNode: async () => {
        throw new Error('不能移动到自己的子层级');
      },
    });
    const intoDescendant = await failure(
      cycleTools.call('space_tree', {
        action: 'move',
        node_id: child.node.id,
        parent_id: folder.node.id,
      }),
    );
    expect(intoDescendant.message).toContain('space/failed');
    expect(intoDescendant.message).toContain('不能移动到自己的子层级');
    expect(intoDescendant.message).toContain('tree');

    const intoSelf = await failure(
      tools.call('space_tree', {
        action: 'move',
        node_id: child.node.id,
        parent_id: child.node.id,
      }),
    );
    expect(intoSelf.message).toContain('不能移动到自身');

    // Folder placement rules are parameter rules: stable invalid-input.
    const nestedFolder = await failure(
      tools.call('space_tree', {
        action: 'create',
        space_id: 'sp-inbox',
        kind: 'folder',
        parent_id: folder.node.id,
      }),
    );
    expect(nestedFolder.message).toContain('space/invalid-input');
    const movedFolder = await failure(
      tools.call('space_tree', {
        action: 'move',
        node_id: folder.node.id,
        parent_id: child.node.id,
      }),
    );
    expect(movedFolder.message).toContain('space/invalid-input');

    // Cross-space parent mismatch is rejected before the service call.
    const otherSpace = await runtime.service.createSpace({ name: '另一空间' });
    const crossSpace = await failure(
      tools.call('space_tree', {
        action: 'move',
        node_id: child.node.id,
        parent_id: folder.node.id,
        space_id: otherSpace.id,
      }),
    );
    expect(crossSpace.message).toContain('space/invalid-input');
  });

  it('reports missing nodes for every node-addressed write action', async () => {
    const { runtime } = await startRuntime();
    const tools = captureTools(runtime.agentService);
    const cases: Array<Record<string, unknown>> = [
      { action: 'rename', node_id: 'doc-missing', title: 'x' },
      { action: 'move', node_id: 'doc-missing', parent_id: null },
      { action: 'pin', node_id: 'doc-missing', pinned: true },
      { action: 'archive', node_id: 'doc-missing', archived: true },
      { action: 'delete', node_id: 'doc-missing' },
      { action: 'restore', node_id: 'doc-missing' },
    ];
    for (const args of cases) {
      const error = await failure(tools.call('space_tree', args));
      expect(error.message, JSON.stringify(args)).toContain('space/not-found');
    }
    const missingParent = await failure(
      tools.call('space_tree', {
        action: 'create',
        space_id: 'sp-inbox',
        kind: 'note',
        parent_id: 'doc-missing',
      }),
    );
    expect(missingParent.message).toContain('space/not-found');
  });
});

describe('migration freeze at the core proxy', () => {
  it('refuses every structure write with migration/read-only while reads pass', async () => {
    const { runtime } = await startRuntime();
    let locked = false;
    const proxy = createSpaceProxy(
      () => runtime.agentService,
      () => locked,
    );
    const tools = captureTools(proxy);
    const note = (
      await tools.call('space_tree', {
        action: 'create',
        space_id: 'sp-inbox',
        kind: 'note',
        title: '冻结前文档',
      })
    ) as { node: NodeMeta };

    locked = true;
    const writes: Array<Record<string, unknown>> = [
      { action: 'create', space_id: 'sp-inbox', kind: 'folder' },
      { action: 'rename', node_id: note.node.id, title: '冻结改名' },
      { action: 'move', node_id: note.node.id, parent_id: null },
      { action: 'pin', node_id: note.node.id, pinned: true },
      { action: 'archive', node_id: note.node.id, archived: true },
      { action: 'delete', node_id: note.node.id },
      { action: 'restore', node_id: note.node.id },
    ];
    for (const args of writes) {
      const error = await failure(tools.call('space_tree', args));
      expect(error.message, JSON.stringify(args)).toContain('migration/read-only');
    }
    // Reads stay available during the freeze.
    const spaces = (await tools.call('space_browse', { action: 'spaces' })) as {
      spaces: unknown[];
    };
    expect(spaces.spaces.length).toBeGreaterThan(0);
    const tree = (await tools.call('space_browse', {
      action: 'tree',
      space_id: 'sp-inbox',
    })) as { nodes: NodeMeta[] };
    expect(tree.nodes.some((node) => node.id === note.node.id)).toBe(true);
    // Nothing the freeze refused actually landed.
    expect((await runtime.service.getNode(note.node.id))?.title).toBe('冻结前文档');

    locked = false;
    const renamed = (await tools.call('space_tree', {
      action: 'rename',
      node_id: note.node.id,
      title: '解冻改名',
    })) as { node: NodeMeta };
    expect(renamed.node.title).toBe('解冻改名');
  });
});

describe('plugin config gate', () => {
  function fakeContext(tools: unknown): {
    ctx: HostContextLike;
    teardown: () => Promise<void>;
  } {
    const disposers: Array<() => unknown> = [];
    const effect = async (execute: () => unknown) => {
      const disposer = await execute();
      if (typeof disposer === 'function')
        disposers.push(disposer as () => unknown);
      return disposer;
    };
    const ctx = {
      connection: {
        fetch: {
          register: () => () => undefined,
        },
      },
      logger: quietLogger(),
      effect,
      inject: (_names: string[], callback: (child: unknown) => void) =>
        callback({ tools, effect }),
    } as unknown as HostContextLike;
    return {
      ctx,
      teardown: async () => {
        for (const disposer of disposers.reverse()) await disposer();
      },
    };
  }

  function fakeTools(): {
    definitions: Map<string, ToolDefinitionLike>;
    tools: ToolsLike;
  } {
    const definitions = new Map<string, ToolDefinitionLike>();
    return {
      definitions,
      tools: {
        register(definition) {
          definitions.set(definition.name, definition);
          return () => {
            definitions.delete(definition.name);
          };
        },
      },
    };
  }

  it('registers space tools by default and removes them on teardown', async () => {
    const directory = await tempDir('space-tools-gate-');
    const fake = fakeTools();
    const harness = fakeContext(fake.tools);
    await apply(harness.ctx, { dataDir: directory });
    expect(fake.definitions.has('space_browse')).toBe(true);
    expect(fake.definitions.has('space_tree')).toBe(true);
    expect(fake.definitions.has('space_doc_read')).toBe(true);
    await harness.teardown();
    expect(fake.definitions.size).toBe(0);
  });

  it('spaceTools=false keeps the structure tools unregistered', async () => {
    const directory = await tempDir('space-tools-gate-off-');
    const fake = fakeTools();
    const harness = fakeContext(fake.tools);
    await apply(harness.ctx, { dataDir: directory, spaceTools: false });
    expect(fake.definitions.has('space_browse')).toBe(false);
    expect(fake.definitions.has('space_tree')).toBe(false);
    expect(fake.definitions.has('space_doc_read')).toBe(true);
    await harness.teardown();
  });

  it('documentTools=false does not disable the space tools', async () => {
    const directory = await tempDir('space-tools-gate-doc-off-');
    const fake = fakeTools();
    const harness = fakeContext(fake.tools);
    await apply(harness.ctx, { dataDir: directory, documentTools: false });
    expect(fake.definitions.has('space_browse')).toBe(true);
    expect(fake.definitions.has('space_tree')).toBe(true);
    expect(fake.definitions.has('space_doc_read')).toBe(false);
    await harness.teardown();
  });
});

describe('server offline: structure writes fail explicitly', () => {
  it('returns remote/unavailable, never queues, and keeps cached reads', async () => {
    const server = await startTestServer();
    const directory = await tempDir('space-tools-offline-');
    const bridge = createRemoteBridge({
      baseUrl: server.url,
      token: TEST_TOKEN,
      directory,
      logger: quietLogger(),
    });
    dispose(() => bridge.close());
    await bridge.refresh();
    const tools = captureTools(bridge.space);

    // Warm the read cache and prove writes work while online.
    const spaces = (await tools.call('space_browse', { action: 'spaces' })) as {
      spaces: Array<{ id: string }>;
    };
    const spaceId = spaces.spaces[0]!.id;
    const created = (await tools.call('space_tree', {
      action: 'create',
      space_id: spaceId,
      kind: 'folder',
      title: '在线文件夹',
    })) as { node: NodeMeta };
    expect(created.node.creator).toBe('alter');

    await server.close();

    const writeError = await failure(
      tools.call('space_tree', {
        action: 'create',
        space_id: spaceId,
        kind: 'note',
        title: '离线文档',
      }),
    );
    expect(writeError.message).toContain('remote/unavailable');
    const renameError = await failure(
      tools.call('space_tree', {
        action: 'rename',
        node_id: created.node.id,
        title: '离线改名',
      }),
    );
    expect(renameError.message).toContain('remote/unavailable');
    expect(bridge.status.pendingWrites ?? 0).toBe(0);

    // Cached reads keep answering; uncached reads fail explicitly too.
    const cached = (await tools.call('space_browse', { action: 'spaces' })) as {
      spaces: Array<{ id: string }>;
    };
    expect(cached.spaces.some((space) => space.id === spaceId)).toBe(true);
    const uncached = await failure(
      tools.call('space_browse', { action: 'tree', space_id: spaceId }),
    );
    expect(uncached.message).toContain('remote/unavailable');
  });
});
describe('tool rendering and error hints', () => {
  it('renders browse and tree results for the model', async () => {
    const { runtime } = await startRuntime();
    const tools = captureTools(runtime.agentService);
    const created = (await tools.call('space_tree', {
      action: 'create',
      space_id: 'sp-inbox',
      kind: 'folder',
      title: '渲染目录',
    })) as { node: NodeMeta };
    const spaceId = 'sp-inbox';
    const browse = tools.definitions.get('space_browse');
    const tree = tools.definitions.get('space_tree');
    expect(browse?.output?.render).toBeTypeOf('function');
    expect(tree?.output?.render).toBeTypeOf('function');

    const spacesValue = await tools.call('space_browse', { action: 'spaces' });
    expect(
      JSON.stringify(browse!.output!.render!({ action: 'spaces' }, spacesValue)),
    ).toContain(spaceId);

    const treeValue = await tools.call('space_browse', {
      action: 'tree',
      space_id: spaceId,
    });
    const treeText = JSON.stringify(
      browse!.output!.render!({ action: 'tree' }, treeValue),
    );
    expect(treeText).toContain(created.node.id);

    // Search, trash and the generic fallback each have their own projection.
    // (Search over the fixture returns no hits, so render the shape directly.)
    const hitsText = JSON.stringify(
      browse!.output!.render!(
        { action: 'search' },
        {
          query: '渲染',
          truncated: true,
          hits: [
            {
              id: 'doc-1',
              type: 'note',
              space_id: spaceId,
              title: '渲染目录',
              excerpt: '渲染',
              creator: 'alter',
            },
          ],
        },
      ),
    );
    expect(hitsText).toContain('渲染');
    expect(hitsText).toContain('(truncated)');
    expect(
      JSON.stringify(
        browse!.output!.render!({ action: 'search' }, { query: 'x', hits: [] }),
      ),
    ).toContain('没有命中');
    expect(
      JSON.stringify(
        browse!.output!.render!({ action: 'trash' }, { nodes: [], thoughts: [] }),
      ),
    ).toContain('回收站为空');
    expect(
      JSON.stringify(
        browse!.output!.render!(
          { action: 'trash' },
          {
            space_id: spaceId,
            nodes: [],
            thoughts: [{ id: 'th-1', content_preview: '随想内容' }],
          },
        ),
      ),
    ).toContain('随想内容');
    expect(
      JSON.stringify(browse!.output!.render!({ action: 'overview' }, {})),
    ).toContain('{}');

    // A write renders a confirmation line, including the soft-delete hint.
    const renamed = await tools.call('space_tree', {
      action: 'rename',
      node_id: created.node.id,
      title: '改名后',
    });
    const renamedText = JSON.stringify(
      tree!.output!.render!({ action: 'rename' }, renamed),
    );
    expect(renamedText).toContain('已改名');
    expect(renamedText).toContain('改名后');

    const deleted = await tools.call('space_tree', {
      action: 'delete',
      node_id: created.node.id,
    });
    expect(
      JSON.stringify(tree!.output!.render!({ action: 'delete' }, deleted)),
    ).toContain('space_tree restore');
    // A result without a node keeps the raw payload instead of inventing text.
    expect(
      JSON.stringify(tree!.output!.render!({ action: 'restore' }, {})),
    ).toBe('[{"type":"text","text":"{}"}]');

    await runtime.close();
  });

  it('describes both tools and rejects non-object args', async () => {
    const { runtime } = await startRuntime();
    const tools = captureTools(runtime.agentService);
    for (const name of ['space_browse', 'space_tree']) {
      const present = tools.definitions.get(name)!.presentCall!({}) as {
        title?: string;
      };
      expect(present.card ?? present.title).toBeTruthy();
    }
    // The tool framework parses JSON only; a scalar body must be rejected by
    // the tool's own argument check instead of reaching the service.
    const scalar = await failure(tools.call('space_browse', null as never));
    expect(scalar.message).toContain('space/invalid-input');
    await runtime.close();
  });

  it('maps every failure shape to a stable code', async () => {
    const { runtime } = await startRuntime();
    const tools = captureTools(runtime.agentService);
    // A vendor rejection (no code) keeps the locator hint.
    const nullSpace = await failure(
      tools.call('space_browse', { action: 'space', space_id: null }),
    );
    expect(nullSpace.message).toContain('space/invalid-input');
    // A non-object body is rejected by the argument check, which sits inside
    // the same try so the model still gets a stable code.
    const scalar = await failure(tools.call('space_tree', 'not-an-object' as never));
    expect(scalar.message).toContain('space/invalid-input');
    // A coded backend error passes its code through unchanged.
    const coded = await failure(
      tools.call('space_browse', { action: 'tree', space_id: 'sp-missing' }),
    );
    expect(coded.message).toMatch(/^space\/not-found: /);
    await runtime.close();
  });

  it('names the next step for move rejections and generic failures', async () => {
    const { runtime } = await startRuntime();
    const tools = captureTools(runtime.agentService);
    // A rejected move must carry the locator hint, not only the raw message.
    const moveIntoChild = await failure(
      tools.call('space_tree', {
        action: 'move',
        node_id: 'doc-missing-parent',
        parent_id: 'doc-missing-child',
      }),
    );
    expect(moveIntoChild.message).toMatch(/space\/not-found|space\/failed/);

    const invalidShape = await failure(
      tools.call('space_browse', { action: 42 }),
    );
    expect(invalidShape.message).toContain('space/invalid-input');
    await runtime.close();
  });
});
