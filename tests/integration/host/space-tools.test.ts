/**
 * P1 Space structure tools over both authority modes.
 *
 * The same tool registrations run against the local alter stack (real SQLite)
 * and the bridge's stamped alter port (real HTTP server): the eight browse
 * projections, the seven tree actions, the user-named lifecycle scenario,
 * attribution derivation and the metadata-only projection boundary. The local
 * mode additionally compares the tool entrance with the browser RPC entrance
 * (`createSpaceRpc` user stack) for identical state transitions.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { SpaceNode } from '@alter/protocol';
import { registerSpaceTools } from '../../../host/authority/space-tools.js';
import type {
  ToolDefinitionLike,
  ToolsLike,
} from '../../../host/document/editors/legacy/tools.js';
import type { SpaceToolApi } from '../../../host/core/backend.js';
import { createSpaceRpc } from '../../../host/authority/rpc.js';
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

/** Capture the two tool definitions over one structure port. */
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

/** The rejected error of a call that must fail. */
async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the tool call to fail');
}

interface RpcEnvelope {
  value?: unknown;
  error?: { code: string; message: string };
}

function unwrap(result: unknown): unknown {
  const envelope = result as RpcEnvelope;
  if (envelope.error !== undefined)
    throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
  return envelope.value;
}

interface ModeHarness {
  /** Alter-bound tool port under test. */
  service: SpaceToolApi;
  tools: ToolHarness;
  /** Default space id every fresh authority seeds. */
  spaceId: string;
  /** Browser (user) entrance for setup and dual-entrance comparison. */
  userRpc(op: string, args: unknown[]): Promise<unknown>;
  /** Raw node read including attribution fields the tools never return. */
  readNode(id: string): Promise<SpaceNode | undefined>;
  /** Create a note with a real body through the alter document port. */
  generateDoc(spaceId: string, title: string, markdown: string): Promise<string>;
}

async function startLocalMode(): Promise<ModeHarness> {
  const { runtime } = await startRuntime();
  const rpc = createSpaceRpc({
    service: runtime.service,
    agentService: runtime.agentService,
    storage: runtime.storage,
    document: runtime.document,
    agentDocument: runtime.agentDocument,
    assets: runtime.assets,
  });
  const userRpc = async (op: string, args: unknown[]) =>
    unwrap(await rpc(op, { op, args }, signal, undefined));
  return {
    service: runtime.agentService,
    tools: captureTools(runtime.agentService),
    spaceId: 'sp-inbox',
    userRpc,
    readNode: (id) => runtime.service.getNode(id),
    generateDoc: async (spaceId, title, markdown) => {
      const generated = await runtime.agentDocument.generate({
        spaceId,
        title,
        markdown,
      });
      return generated.docId;
    },
  };
}

async function startServerMode(): Promise<ModeHarness> {
  const server = await startTestServer();
  const directory = await tempDir('space-tools-bridge-');
  const bridge = createRemoteBridge({
    baseUrl: server.url,
    token: TEST_TOKEN,
    directory,
    logger: quietLogger(),
  });
  dispose(() => bridge.close());
  await bridge.refresh();
  const userRpc = async (op: string, args: unknown[]) =>
    unwrap(await bridge.rpc(op, { op, args }));
  return {
    service: bridge.space,
    tools: captureTools(bridge.space),
    spaceId: 'sp-inbox',
    userRpc,
    readNode: async (id) =>
      (await userRpc('space.getNode', [id])) as SpaceNode | undefined,
    generateDoc: async (spaceId, title, markdown) => {
      const generated = await bridge.document.generate({
        spaceId,
        title,
        markdown,
      });
      return generated.docId;
    },
  };
}

/** Recursively collect every object key appearing in a tool result. */
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

const NODE_META_KEYS = [
  'archived',
  'creator',
  'id',
  'kind',
  'parent_id',
  'pinned',
  'title',
  'updated_at',
];
const SPACE_META_KEYS = [
  'directories',
  'goal',
  'id',
  'is_default',
  'name',
  'order',
];

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

function metaOf(result: unknown): NodeMeta {
  return (result as { node: NodeMeta }).node;
}

const MODES = [
  { name: 'local', start: startLocalMode },
  { name: 'server', start: startServerMode },
];

describe.each(MODES)('$name mode: space_browse + space_tree', ({ start }) => {
  let h: ModeHarness;
  beforeEach(async () => {
    h = await start();
  });

  it('browse spaces/archived_spaces project exactly the space metadata', async () => {
    const listed = (await h.tools.call('space_browse', { action: 'spaces' })) as {
      spaces: Array<Record<string, unknown>>;
    };
    expect(listed.spaces.length).toBeGreaterThan(0);
    for (const space of listed.spaces)
      expect(Object.keys(space).sort()).toEqual(SPACE_META_KEYS);
    expect(listed.spaces.some((space) => space.id === h.spaceId)).toBe(true);

    const archived = (await h.tools.call('space_browse', {
      action: 'archived_spaces',
    })) as { spaces: Array<Record<string, unknown>> };
    expect(archived.spaces).toEqual([]);

    // Archive one space through the user entrance; the read tool must see it.
    const created = (await h.userRpc('space.createSpace', [
      { name: '待归档空间' },
    ])) as { id: string };
    await h.userRpc('space.archiveSpace', [created.id]);
    const after = (await h.tools.call('space_browse', {
      action: 'archived_spaces',
    })) as { spaces: Array<{ id: string }> };
    expect(after.spaces.map((space) => space.id)).toContain(created.id);
    const active = (await h.tools.call('space_browse', { action: 'spaces' })) as {
      spaces: Array<{ id: string }>;
    };
    expect(active.spaces.map((space) => space.id)).not.toContain(created.id);
  });

  it('runs the named scenario: folder → note inside → move → rename → pin → archive → delete → restore', async () => {
    const folder = metaOf(
      await h.tools.call('space_tree', {
        action: 'create',
        space_id: h.spaceId,
        kind: 'folder',
        title: '项目文件夹',
      }),
    );
    expect(folder.kind).toBe('folder');
    expect(folder.parent_id).toBeNull();
    expect(folder.creator).toBe('alter');

    const note = metaOf(
      await h.tools.call('space_tree', {
        action: 'create',
        space_id: h.spaceId,
        kind: 'note',
        title: '文件夹下的笔记',
        parent_id: folder.id,
      }),
    );
    expect(note.parent_id).toBe(folder.id);
    expect(note.kind).toBe('note');

    const moved = metaOf(
      await h.tools.call('space_tree', {
        action: 'move',
        node_id: note.id,
        parent_id: null,
      }),
    );
    expect(moved.parent_id).toBeNull();

    const renamed = metaOf(
      await h.tools.call('space_tree', {
        action: 'rename',
        node_id: note.id,
        title: '改名后的笔记',
      }),
    );
    expect(renamed.title).toBe('改名后的笔记');

    const pinned = metaOf(
      await h.tools.call('space_tree', {
        action: 'pin',
        node_id: note.id,
        pinned: true,
      }),
    );
    expect(pinned.pinned).toBe(true);

    const archived = metaOf(
      await h.tools.call('space_tree', {
        action: 'archive',
        node_id: note.id,
        archived: true,
      }),
    );
    expect(archived.archived).toBe(true);
    expect(archived.pinned).toBe(false);
    // Archived nodes leave the default tree but stay with include_archived.
    const defaultTree = (await h.tools.call('space_browse', {
      action: 'tree',
      space_id: h.spaceId,
    })) as { nodes: NodeMeta[] };
    expect(defaultTree.nodes.some((node) => node.id === note.id)).toBe(false);
    const fullTree = (await h.tools.call('space_browse', {
      action: 'tree',
      space_id: h.spaceId,
      include_archived: true,
    })) as { nodes: NodeMeta[] };
    expect(fullTree.nodes.some((node) => node.id === note.id)).toBe(true);

    const deleted = (await h.tools.call('space_tree', {
      action: 'delete',
      node_id: note.id,
    })) as { deleted: boolean; node_id: string };
    expect(deleted).toEqual({ deleted: true, node_id: note.id });
    const trash = (await h.tools.call('space_browse', {
      action: 'trash',
      space_id: h.spaceId,
    })) as { nodes: NodeMeta[] };
    expect(trash.nodes.some((node) => node.id === note.id)).toBe(true);

    const restored = metaOf(
      await h.tools.call('space_tree', { action: 'restore', node_id: note.id }),
    );
    expect(restored.id).toBe(note.id);
    expect(restored.title).toBe('改名后的笔记');
    const reread = await h.readNode(note.id);
    expect(reread?.deletedAt).toBeNull();
    expect(reread?.creator).toBe('alter');
  });

  it('browse covers all eight actions with metadata-only projections', async () => {
    const folder = metaOf(
      await h.tools.call('space_tree', {
        action: 'create',
        space_id: h.spaceId,
        kind: 'folder',
        title: '浏览文件夹',
      }),
    );
    const docId = await h.generateDoc(
      h.spaceId,
      '浏览文档',
      '# 浏览文档\n\n独一无二的正文标记 XYZBROWSE。\n',
    );
    const thought = (await h.userRpc('space.createThought', [
      { spaceId: h.spaceId, content: '随想预览内容' },
    ])) as { id: string };
    await h.userRpc('space.deleteThought', [thought.id]);
    await h.tools.call('space_tree', { action: 'delete', node_id: folder.id });

    const spaces = (await h.tools.call('space_browse', { action: 'spaces' })) as {
      spaces: unknown[];
    };
    expect(spaces.spaces.length).toBeGreaterThan(0);
    const archivedSpaces = await h.tools.call('space_browse', {
      action: 'archived_spaces',
    });
    expect(archivedSpaces).toHaveProperty('spaces');
    const space = (await h.tools.call('space_browse', {
      action: 'space',
      space_id: h.spaceId,
    })) as Record<string, unknown>;
    expect(Object.keys(space).sort()).toEqual(SPACE_META_KEYS);
    const tree = (await h.tools.call('space_browse', {
      action: 'tree',
      space_id: h.spaceId,
    })) as { space_id: string; total: number; truncated: boolean; nodes: NodeMeta[] };
    expect(tree.space_id).toBe(h.spaceId);
    expect(tree.truncated).toBe(false);
    expect(tree.total).toBe(tree.nodes.length);
    expect(tree.nodes.some((node) => node.id === docId)).toBe(true);
    for (const node of tree.nodes)
      expect(Object.keys(node).sort()).toEqual(NODE_META_KEYS);
    const node = (await h.tools.call('space_browse', {
      action: 'node',
      node_id: docId,
    })) as Record<string, unknown>;
    expect(Object.keys(node).sort()).toEqual(NODE_META_KEYS);
    const overview = (await h.tools.call('space_browse', {
      action: 'overview',
      space_id: h.spaceId,
    })) as Record<string, unknown>;
    expect(overview).toHaveProperty('recent_docs');
    expect(overview).toHaveProperty('activity');
    expect(overview).toHaveProperty('agent_events');
    expect(overview).toHaveProperty('tasks');
    expect(overview).toHaveProperty('milestones');
    const search = (await h.tools.call('space_browse', {
      action: 'search',
      space_id: h.spaceId,
      query: 'XYZBROWSE',
    })) as { query: string; hits: Array<Record<string, unknown>>; truncated: boolean };
    expect(search.query).toBe('XYZBROWSE');
    expect(search.hits.some((hit) => hit.id === docId)).toBe(true);
    for (const hit of search.hits)
      expect(Object.keys(hit).sort()).toEqual([
        'creator',
        'excerpt',
        'id',
        'space_id',
        'title',
        'type',
      ]);
    const trash = (await h.tools.call('space_browse', {
      action: 'trash',
      space_id: h.spaceId,
    })) as { nodes: NodeMeta[]; thoughts: Array<{ id: string }> };
    expect(trash.nodes.some((entry) => entry.id === folder.id)).toBe(true);
    expect(trash.thoughts.some((entry) => entry.id === thought.id)).toBe(true);

    // No projection ever carries a content field or the full document body.
    for (const result of [spaces, archivedSpaces, space, tree, node, overview, search, trash]) {
      expect(keysDeep(result).has('content')).toBe(false);
    }
    for (const result of [tree, node, overview, trash]) {
      expect(JSON.stringify(result)).not.toContain('XYZBROWSE');
    }
  });

  it('attributes tool writes to alter and archives to agent', async () => {
    const note = metaOf(
      await h.tools.call('space_tree', {
        action: 'create',
        space_id: h.spaceId,
        kind: 'note',
        title: '归属文档',
      }),
    );
    expect((await h.readNode(note.id))?.creator).toBe('alter');
    await h.tools.call('space_tree', {
      action: 'archive',
      node_id: note.id,
      archived: true,
    });
    expect((await h.readNode(note.id))?.archivedBy).toBe('agent');
    await h.tools.call('space_tree', {
      action: 'archive',
      node_id: note.id,
      archived: false,
    });
    expect((await h.readNode(note.id))?.archivedBy).toBeNull();
  });

  it('keeps user-node attribution across tool rename and move', async () => {
    const folder = (await h.userRpc('space.createNode', [
      { spaceId: h.spaceId, kind: 'folder', title: '用户文件夹' },
    ])) as SpaceNode;
    const note = (await h.userRpc('space.createNode', [
      { spaceId: h.spaceId, kind: 'note', title: '用户文档', parentId: folder.id },
    ])) as SpaceNode;
    expect(note.creator).toBe('me');

    await h.tools.call('space_tree', {
      action: 'rename',
      node_id: note.id,
      title: '工具改名',
    });
    await h.tools.call('space_tree', {
      action: 'move',
      node_id: note.id,
      parent_id: null,
    });
    const reread = await h.readNode(note.id);
    expect(reread?.creator).toBe('me');
    expect(reread?.title).toBe('工具改名');
    expect(reread?.parentId).toBeNull();
    expect((await h.readNode(folder.id))?.creator).toBe('me');
  });

  it('rejects unknown ids with space/not-found and a next step', async () => {
    for (const action of ['space', 'tree', 'overview', 'search', 'trash']) {
      const error = await failure(
        h.tools.call('space_browse', {
          action,
          space_id: 'sp-missing',
          ...(action === 'search' ? { query: '任意' } : {}),
        }),
      );
      expect(error.message, action).toContain('space/not-found');
      expect(error.message, action).toContain('spaces');
    }
    const nodeError = await failure(
      h.tools.call('space_browse', { action: 'node', node_id: 'doc-missing' }),
    );
    expect(nodeError.message).toContain('space/not-found');
    const createError = await failure(
      h.tools.call('space_tree', {
        action: 'create',
        space_id: 'sp-missing',
        kind: 'note',
      }),
    );
    expect(createError.message).toContain('space/not-found');
    const restoreError = await failure(
      h.tools.call('space_tree', { action: 'restore', node_id: 'doc-missing' }),
    );
    expect(restoreError.message).toContain('space/not-found');
  });
});

describe('local mode: tool entrance vs browser RPC entrance', () => {
  it('produces identical state transitions, differing only in attribution', async () => {
    const { runtime } = await startRuntime();
    const tools = captureTools(runtime.agentService);
    const rpc = createSpaceRpc({
      service: runtime.service,
      agentService: runtime.agentService,
      storage: runtime.storage,
      document: runtime.document,
      agentDocument: runtime.agentDocument,
      assets: runtime.assets,
    });
    const userCall = async (op: string, args: unknown[]) =>
      unwrap(await rpc(op, { op, args }, signal, undefined));

    // Isolated spaces keep sibling order identical between the two entrances.
    const toolSpace = (await userCall('space.createSpace', [
      { name: '工具入口' },
    ])) as { id: string };
    const rpcSpace = (await userCall('space.createSpace', [
      { name: '浏览器入口' },
    ])) as { id: string };

    const toolFolder = metaOf(
      await tools.call('space_tree', {
        action: 'create',
        space_id: toolSpace.id,
        kind: 'folder',
        title: '文件夹',
      }),
    );
    const rpcFolder = (await userCall('space.createNode', [
      { spaceId: rpcSpace.id, kind: 'folder', title: '文件夹' },
    ])) as SpaceNode;

    const toolNote = metaOf(
      await tools.call('space_tree', {
        action: 'create',
        space_id: toolSpace.id,
        kind: 'note',
        title: '笔记',
        parent_id: toolFolder.id,
      }),
    );
    const rpcNote = (await userCall('space.createNode', [
      { spaceId: rpcSpace.id, kind: 'note', title: '笔记', parentId: rpcFolder.id },
    ])) as SpaceNode;

    await tools.call('space_tree', {
      action: 'move',
      node_id: toolNote.id,
      parent_id: null,
      order: 3,
    });
    await userCall('space.moveNode', [rpcNote.id, { spaceId: rpcSpace.id, parentId: null, order: 3 }]);
    await tools.call('space_tree', {
      action: 'rename',
      node_id: toolNote.id,
      title: '改名',
    });
    await userCall('space.saveNode', [rpcNote.id, { title: '改名' }]);
    await tools.call('space_tree', { action: 'pin', node_id: toolNote.id, pinned: true });
    await userCall('space.setPinned', [rpcNote.id, true]);
    await tools.call('space_tree', {
      action: 'archive',
      node_id: toolNote.id,
      archived: true,
    });
    await userCall('space.setArchived', [rpcNote.id, true]);
    await tools.call('space_tree', { action: 'delete', node_id: toolNote.id });
    await userCall('space.deleteNode', [rpcNote.id]);
    await tools.call('space_tree', { action: 'restore', node_id: toolNote.id });
    await userCall('space.restoreNode', [rpcNote.id]);

    /** State shape without identity, attribution or wall-clock fields. */
    const shapeOf = (node: SpaceNode | undefined) => {
      expect(node).toBeDefined();
      return {
        kind: node!.kind,
        title: node!.title,
        parentId: node!.parentId === null ? null : 'folder',
        pinned: node!.pinned,
        archived: node!.archived,
        deleted: node!.deletedAt !== null,
        deletedRoot: node!.deletedRoot,
        originalParent: node!.originalParentId !== null,
        unread: node!.unread,
        order: node!.order,
      };
    };
    const toolState = shapeOf(await runtime.service.getNode(toolNote.id));
    const rpcState = shapeOf(await runtime.service.getNode(rpcNote.id));
    expect(toolState).toEqual(rpcState);
    expect(toolState.title).toBe('改名');
    expect(toolState.order).toBe(3);

    // Attribution is the only intended difference on the created entities.
    expect((await runtime.service.getNode(toolNote.id))?.creator).toBe('alter');
    expect((await runtime.service.getNode(rpcNote.id))?.creator).toBe('me');
    expect((await runtime.service.getNode(toolFolder.id))?.creator).toBe('alter');
    expect((await runtime.service.getNode(rpcFolder.id))?.creator).toBe('me');

    // The tool's metadata projection matches the raw node the RPC returns.
    const projected = metaOf(
      await tools.call('space_tree', {
        action: 'pin',
        node_id: toolNote.id,
        pinned: false,
      }),
    );
    const raw = (await runtime.service.getNode(toolNote.id))!;
    expect(projected).toEqual({
      id: raw.id,
      kind: raw.kind,
      title: raw.title,
      parent_id: raw.parentId,
      pinned: raw.pinned,
      archived: raw.archived,
      creator: raw.creator,
      updated_at: raw.updatedAt,
    });
  });
});