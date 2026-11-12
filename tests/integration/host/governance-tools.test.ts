/**
 * Agent `space_governance` and `space_collaborators` tools over a real local
 * authority runtime.
 *
 * The two tools share one registrar but stay separate model-facing tools:
 * governance owns the space lifecycle (including the two irreversible actions,
 * which must be approved and must not run when the user rejects or when no
 * approval service exists), collaborators own collaborator creation and
 * directory browsing. Both drive the real SQLite authority through
 * `runtimeAgentRpc`, so the assertions read state back through the same
 * alter-bound endpoint caller instead of trusting the tool result alone.
 */
import { describe, expect, it } from 'vitest';
import type { Agent, Space, SpaceNode, Thought } from '@alter/protocol';
import { registerGovernanceTools } from '../../../host/authority/governance-tools.js';
import type {
  ToolDefinitionLike,
  ToolsLike,
} from '../../../host/document/editors/legacy/tools.js';
import type { RpcCall } from '../../../host/authority/tool-support.js';
import {
  approvalStub,
  runtimeAgentRpc,
  type ApprovalStub,
} from '../../support/agent-rpc.js';
import { startRuntime, type TestRuntime } from '../../support/harness.js';
import { dispose, subDir, tempDir } from '../../support/lifecycle.js';

const signal = new AbortController().signal;

interface ToolHarness {
  definitions: Map<string, ToolDefinitionLike>;
  rpc: RpcCall;
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  render(name: string, args: unknown, value: unknown): string;
}

interface HarnessOptions {
  /** Omit to exercise the fail-closed path without an approval service. */
  approval?: ApprovalStub;
}

/** Capture both tool definitions over one real alter-bound endpoint caller. */
function captureTools(
  runtime: TestRuntime['runtime'],
  options: HarnessOptions = {},
): ToolHarness {
  const rpc = runtimeAgentRpc(runtime);
  const definitions = new Map<string, ToolDefinitionLike>();
  const tools: ToolsLike = {
    register(definition) {
      definitions.set(definition.name, definition);
      return () => {
        definitions.delete(definition.name);
      };
    },
  };
  dispose(
    registerGovernanceTools(tools, {
      rpc,
      ...(options.approval === undefined
        ? {}
        : { approval: options.approval.approval }),
    }),
  );
  return {
    definitions,
    rpc,
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
    render(name, args, value) {
      const definition = definitions.get(name);
      if (definition === undefined)
        throw new Error(`tool ${name} is not registered`);
      return definition.output
        .render(args, value)
        .map((block) => block.text)
        .join('\n');
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

interface SpaceMeta {
  id: string;
  name: string;
  goal: string;
  directories: string[];
  is_default: boolean;
  order: number;
  created_at: string;
  archived_at: string | null;
}

interface AgentMeta {
  id: string;
  name: string;
  role: string;
  description?: string;
  model?: string;
  created_at: string;
}

function spaceOf(result: unknown): SpaceMeta {
  return (result as { space: SpaceMeta }).space;
}

function createSpace(h: ToolHarness, name: string): Promise<SpaceMeta> {
  return h
    .call('space_governance', { action: 'create_space', name })
    .then(spaceOf);
}

describe('space_governance', () => {
  it('creates, updates, archives, unarchives and reorders spaces', async () => {
    const { runtime } = await startRuntime();
    const h = captureTools(runtime);
    const workspace = await tempDir('space-governance-workspace-');

    const created = spaceOf(
      await h.call('space_governance', {
        action: 'create_space',
        name: '治理空间',
        goal: '验证治理',
        directories: [workspace],
      }),
    );
    expect(created.name).toBe('治理空间');
    expect(created.goal).toBe('验证治理');
    expect(created.directories).toEqual([workspace]);
    expect(created.is_default).toBe(false);
    expect(created.archived_at).toBeNull();
    expect(created.created_at).toBeTruthy();
    const raw = (await h.rpc('space.getSpace', [created.id])) as Space | null;
    expect(raw?.name).toBe('治理空间');
    expect(
      h.render('space_governance', { action: 'create_space' }, { space: created }),
    ).toContain('已创建空间');

    // update_space sends only the fields the caller provided.
    const renamed = spaceOf(
      await h.call('space_governance', {
        action: 'update_space',
        space_id: created.id,
        name: '改名空间',
      }),
    );
    expect(renamed.name).toBe('改名空间');
    expect(renamed.goal).toBe('验证治理');
    const goalCleared = spaceOf(
      await h.call('space_governance', {
        action: 'update_space',
        space_id: created.id,
        goal: '',
      }),
    );
    expect(goalCleared.goal).toBe('');

    const archived = spaceOf(
      await h.call('space_governance', {
        action: 'archive_space',
        space_id: created.id,
      }),
    );
    expect(archived.archived_at).not.toBeNull();
    expect(
      ((await h.rpc('space.listArchivedSpaces', [])) as Space[]).map(
        (space) => space.id,
      ),
    ).toContain(created.id);
    expect(
      ((await h.rpc('space.listSpaces', [])) as Space[]).map((space) => space.id),
    ).not.toContain(created.id);

    const unarchived = spaceOf(
      await h.call('space_governance', {
        action: 'unarchive_space',
        space_id: created.id,
      }),
    );
    expect(unarchived.archived_at).toBeNull();
    expect(
      ((await h.rpc('space.listSpaces', [])) as Space[]).map((space) => space.id),
    ).toContain(created.id);

    const before = (await h.rpc('space.listSpaces', [])) as Space[];
    const ids = before.map((space) => space.id).reverse();
    const reordered = (await h.call('space_governance', {
      action: 'reorder_spaces',
      space_ids: ids,
    })) as { spaces: Array<{ id: string; name: string; order: number }> };
    expect(reordered.spaces.map((space) => space.id)).toEqual(ids);
    expect(reordered.spaces.map((space) => space.order)).toEqual(
      ids.map((_, index) => index),
    );
    const after = (await h.rpc('space.listSpaces', [])) as Space[];
    expect(after.map((space) => space.id)).toEqual(ids);
    expect(
      h.render('space_governance', { action: 'reorder_spaces' }, reordered),
    ).toContain('空间顺序已更新');
  });

  it('deletes a space only after approval and keeps it when rejected', async () => {
    const { runtime } = await startRuntime();
    const h = captureTools(runtime);
    const space = await createSpace(h, '待删空间');
    await h.rpc('space.createThought', [
      { spaceId: space.id, content: '会随空间一起删除' },
    ]);

    const rejectedStub = approvalStub('rejected');
    const rejected = captureTools(runtime, { approval: rejectedStub });
    const error = await failure(
      rejected.call('space_governance', {
        action: 'delete_space',
        space_id: space.id,
      }),
    );
    expect(error.message).toContain('未批准');
    expect(rejectedStub.requests).toHaveLength(1);
    expect(rejectedStub.requests[0]?.toolName).toBe('space_governance');
    expect(rejectedStub.requests[0]?.reason).toContain('不可恢复');
    // Nothing was deleted: the space and its thought are still readable.
    expect(await rejected.rpc('space.getSpace', [space.id])).not.toBeNull();
    const survivor = (await rejected.rpc('space.listThoughts', [
      space.id,
      { includeArchived: true },
    ])) as Thought[];
    expect(survivor).toHaveLength(1);

    const allowedStub = approvalStub('allowed-once');
    const allowed = captureTools(runtime, { approval: allowedStub });
    const deleted = (await allowed.call('space_governance', {
      action: 'delete_space',
      space_id: space.id,
    })) as { deleted: boolean; space_id: string };
    expect(deleted).toEqual({ deleted: true, space_id: space.id });
    expect(allowedStub.requests).toHaveLength(1);
    expect(await allowed.rpc('space.getSpace', [space.id])).toBeNull();
    expect(
      ((await allowed.rpc('space.listSpaces', [])) as Space[]).map(
        (item) => item.id,
      ),
    ).not.toContain(space.id);
    expect(
      await allowed.rpc('space.listThoughts', [
        space.id,
        { includeArchived: true },
      ]),
    ).toEqual([]);
    expect(
      allowed.render('space_governance', { action: 'delete_space' }, deleted),
    ).toContain('不可恢复');
  });

  it('empties the trash only after approval and keeps it when rejected', async () => {
    const { runtime } = await startRuntime();
    const h = captureTools(runtime);
    const space = await createSpace(h, '清空空间');
    const thought = (await h.rpc('space.createThought', [
      { spaceId: space.id, content: '回收站里的随想' },
    ])) as Thought;
    await h.rpc('space.deleteThought', [thought.id]);
    const folder = (await h.rpc('space.createNode', [
      { spaceId: space.id, kind: 'folder', title: '回收站文件夹' },
    ])) as SpaceNode;
    await h.rpc('space.deleteNode', [folder.id]);
    const trash = (await h.rpc('space.listDeleted', [space.id])) as {
      nodes: SpaceNode[];
      thoughts: Thought[];
    };
    expect(trash.thoughts.map((entry) => entry.id)).toContain(thought.id);
    expect(trash.nodes.map((entry) => entry.id)).toContain(folder.id);

    const rejectedStub = approvalStub('rejected');
    const rejected = captureTools(runtime, { approval: rejectedStub });
    const error = await failure(
      rejected.call('space_governance', {
        action: 'empty_trash',
        space_id: space.id,
      }),
    );
    expect(error.message).toContain('未批准');
    expect(rejectedStub.requests).toHaveLength(1);
    expect(rejectedStub.requests[0]?.reason).toContain('不可恢复');
    const kept = (await rejected.rpc('space.listDeleted', [space.id])) as {
      nodes: SpaceNode[];
      thoughts: Thought[];
    };
    expect(kept.thoughts.map((entry) => entry.id)).toContain(thought.id);
    expect(kept.nodes.map((entry) => entry.id)).toContain(folder.id);

    const allowedStub = approvalStub('allowed-once');
    const allowed = captureTools(runtime, { approval: allowedStub });
    const emptied = (await allowed.call('space_governance', {
      action: 'empty_trash',
      space_id: space.id,
    })) as { emptied: boolean; space_id: string };
    expect(emptied).toEqual({ emptied: true, space_id: space.id });
    expect(allowedStub.requests).toHaveLength(1);
    const empty = (await allowed.rpc('space.listDeleted', [space.id])) as {
      nodes: SpaceNode[];
      thoughts: Thought[];
    };
    expect(empty.nodes).toEqual([]);
    expect(empty.thoughts).toEqual([]);
    expect(
      allowed.render('space_governance', { action: 'empty_trash' }, emptied),
    ).toContain('不可恢复');
  });

  it('fails closed when no approval service is available', async () => {
    const { runtime } = await startRuntime();
    const h = captureTools(runtime);
    const space = await createSpace(h, '无审批空间');
    await h.rpc('space.createThought', [
      { spaceId: space.id, content: '应当保留' },
    ]);

    const deleteError = await failure(
      h.call('space_governance', {
        action: 'delete_space',
        space_id: space.id,
      }),
    );
    expect(deleteError.message).toContain('space/failed');
    expect(deleteError.message).toContain('没有审批服务');
    expect(await h.rpc('space.getSpace', [space.id])).not.toBeNull();

    const thoughts = (await h.rpc('space.listThoughts', [
      space.id,
      { includeArchived: true },
    ])) as Thought[];
    expect(thoughts).toHaveLength(1);
    await h.rpc('space.deleteThought', [thoughts[0]?.id]);
    const trashError = await failure(
      h.call('space_governance', {
        action: 'empty_trash',
        space_id: space.id,
      }),
    );
    expect(trashError.message).toContain('没有审批服务');
    const kept = (await h.rpc('space.listDeleted', [space.id])) as {
      thoughts: Thought[];
    };
    expect(kept.thoughts).toHaveLength(1);
  });

  it('rejects invalid governance arguments and unknown ids', async () => {
    const { runtime } = await startRuntime();
    const h = captureTools(runtime);

    const missingName = await failure(
      h.call('space_governance', { action: 'create_space' }),
    );
    expect(missingName.message).toContain('space/invalid-input');
    expect(missingName.message).toContain('name');

    const emptyUpdate = await failure(
      h.call('space_governance', {
        action: 'update_space',
        space_id: 'sp-inbox',
      }),
    );
    expect(emptyUpdate.message).toContain('至少提供 name 或 goal');

    const missingSpace = await failure(
      h.call('space_governance', { action: 'archive_space' }),
    );
    expect(missingSpace.message).toContain('space_id');

    const emptyOrder = await failure(
      h.call('space_governance', {
        action: 'reorder_spaces',
        space_ids: [],
      }),
    );
    expect(emptyOrder.message).toContain('space_ids');

    const unknownAction = await failure(
      h.call('space_governance', { action: 'launch_rocket' }),
    );
    expect(unknownAction.message).toContain('space/invalid-input');
    expect(unknownAction.message).toContain('action 必须是');

    const unknownSpace = await failure(
      h.call('space_governance', {
        action: 'update_space',
        space_id: 'sp-missing',
        name: '不存在',
      }),
    );
    expect(unknownSpace.message).toContain('space/not-found');
  });

  it('declares the ledger action enum and edit metadata', async () => {
    const { runtime } = await startRuntime();
    const h = captureTools(runtime);
    const definition = h.definitions.get('space_governance');
    if (definition === undefined)
      throw new Error('space_governance is not registered');
    const properties = definition.parameters.properties as Record<
      string,
      { enum?: string[] }
    >;
    expect(properties.action?.enum).toEqual([
      'create_space',
      'update_space',
      'archive_space',
      'unarchive_space',
      'delete_space',
      'reorder_spaces',
      'empty_trash',
    ]);
    expect(definition.isConcurrencySafe?.({ action: 'create_space' })).toBe(
      false,
    );
    expect(definition.presentCall?.({ action: 'create_space' })).toEqual({
      card: 'generic',
      title: 'Space governance',
      kind: 'edit',
    });
  });
});

describe('space_collaborators', () => {
  it('creates and lists collaborators', async () => {
    const { runtime } = await startRuntime();
    const h = captureTools(runtime);

    const created = (await h.call('space_collaborators', {
      action: 'create_agent',
      name: '研究协作者',
      role: 'researcher',
      description: '擅长调研',
      model: 'ds-v4',
    })) as { agent: AgentMeta };
    expect(created.agent.name).toBe('研究协作者');
    expect(created.agent.role).toBe('researcher');
    expect(created.agent.description).toBe('擅长调研');
    expect(created.agent.model).toBe('ds-v4');
    expect(created.agent.created_at).toBeTruthy();
    expect(
      h.render('space_collaborators', { action: 'create_agent' }, created),
    ).toContain('已创建协作者');

    // role is required by the protocol but defaults to `collaborator`.
    const defaulted = (await h.call('space_collaborators', {
      action: 'create_agent',
      name: '默认协作者',
    })) as { agent: AgentMeta };
    expect(defaulted.agent.role).toBe('collaborator');

    const raw = (await h.rpc('space.listAgents', [])) as Agent[];
    expect(raw.map((agent) => agent.id)).toEqual(
      expect.arrayContaining([created.agent.id, defaulted.agent.id]),
    );

    const listed = (await h.call('space_collaborators', {
      action: 'list_agents',
    })) as { total: number; truncated: boolean; agents: AgentMeta[] };
    expect(listed.total).toBe(2);
    expect(listed.truncated).toBe(false);
    expect(listed.agents.map((agent) => agent.name)).toEqual(
      expect.arrayContaining(['研究协作者', '默认协作者']),
    );
    for (const agent of listed.agents)
      expect(Object.keys(agent).sort()).toEqual(
        expect.arrayContaining(['created_at', 'id', 'name', 'role']),
      );
    expect(
      h.render('space_collaborators', { action: 'list_agents' }, listed),
    ).toContain('研究协作者');
  });

  it('lists subdirectories with a 100-entry cap', async () => {
    const { runtime } = await startRuntime();
    const h = captureTools(runtime);
    const base = await tempDir('space-directories-');
    await subDir(base, 'beta');
    await subDir(base, 'alpha');
    await subDir(base, 'zeta');

    interface DirectoryResult {
      path: string;
      total: number;
      truncated: boolean;
      entries: Array<{ path: string; name: string }>;
    }
    const listing = (await h.call('space_collaborators', {
      action: 'list_directories',
      path: base,
    })) as DirectoryResult;
    expect(listing.path).toBe(base);
    expect(listing.total).toBe(3);
    expect(listing.truncated).toBe(false);
    // Latin names sort before other scripts, which these all are.
    expect(listing.entries.map((entry) => entry.name)).toEqual([
      'alpha',
      'beta',
      'zeta',
    ]);
    expect(listing.entries[0]?.path).toBe(`${base}/alpha`);
    expect(
      h.render('space_collaborators', { action: 'list_directories' }, listing),
    ).toContain('alpha');

    const crowded = await tempDir('space-directories-many-');
    for (let index = 0; index < 101; index += 1)
      await subDir(crowded, `d${String(index).padStart(3, '0')}`);
    const capped = (await h.call('space_collaborators', {
      action: 'list_directories',
      path: crowded,
    })) as DirectoryResult;
    expect(capped.total).toBe(101);
    expect(capped.truncated).toBe(true);
    expect(capped.entries).toHaveLength(100);
  });

  it('rejects invalid collaborator arguments and unreadable paths', async () => {
    const { runtime } = await startRuntime();
    const h = captureTools(runtime);

    const missingName = await failure(
      h.call('space_collaborators', { action: 'create_agent' }),
    );
    expect(missingName.message).toContain('space/invalid-input');
    expect(missingName.message).toContain('name');

    const missingPath = await failure(
      h.call('space_collaborators', { action: 'list_directories' }),
    );
    expect(missingPath.message).toContain('path');

    const unreadable = await failure(
      h.call('space_collaborators', {
        action: 'list_directories',
        path: '/definitely/not/a/real/directory-xyz',
      }),
    );
    expect(unreadable.message).toContain('space/failed');
    expect(unreadable.message).toContain('目录不存在');
    expect(unreadable.message).toContain('绝对路径');
  });

  it('declares the ledger action enum and read/write metadata', async () => {
    const { runtime } = await startRuntime();
    const h = captureTools(runtime);
    const definition = h.definitions.get('space_collaborators');
    if (definition === undefined)
      throw new Error('space_collaborators is not registered');
    const properties = definition.parameters.properties as Record<
      string,
      { enum?: string[] }
    >;
    expect(properties.action?.enum).toEqual([
      'list_agents',
      'create_agent',
      'list_directories',
    ]);
    expect(definition.isConcurrencySafe?.({ action: 'list_agents' })).toBe(
      true,
    );
    expect(
      definition.isConcurrencySafe?.({ action: 'list_directories' }),
    ).toBe(true);
    expect(definition.isConcurrencySafe?.({ action: 'create_agent' })).toBe(
      false,
    );
    expect(definition.presentCall?.({ action: 'list_agents' })).toEqual({
      card: 'generic',
      title: 'Space collaborators',
      kind: 'read',
    });
    expect(definition.presentCall?.({ action: 'create_agent' })).toEqual({
      card: 'generic',
      title: 'Space collaborators',
      kind: 'edit',
    });
  });

  it('removes every registration on dispose', async () => {
    const { runtime } = await startRuntime();
    const rpc = runtimeAgentRpc(runtime);
    const definitions = new Map<string, ToolDefinitionLike>();
    const tools: ToolsLike = {
      register(definition) {
        definitions.set(definition.name, definition);
        return () => {
          definitions.delete(definition.name);
        };
      },
    };
    const disposer = registerGovernanceTools(tools, { rpc });
    expect([...definitions.keys()]).toEqual([
      'space_governance',
      'space_collaborators',
    ]);
    disposer();
    expect(definitions.size).toBe(0);
  });
});