import { realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Space } from '@alter/protocol';
import type { SpaceServiceLike } from '../host/workspace-sync.js';
import {
  FIXED_NOW,
  createSyncHarness,
  type SyncHarness,
} from './workspace-fixtures.js';

const harnesses: SyncHarness[] = [];

async function harness(): Promise<SyncHarness> {
  const created = await createSyncHarness();
  harnesses.push(created);
  return created;
}

afterEach(async () => {
  for (const current of harnesses.splice(0)) await current.cleanup();
});

async function canonical(path: string): Promise<string> {
  return await realpath(path);
}

async function createSpace(
  h: SyncHarness,
  name: string,
  directories: string[],
): Promise<Space> {
  // The product flow picks existing folders in the directory browser; make
  // every `~/…` entry real before exercising the bridge.
  for (const directory of directories) {
    if (typeof directory === 'string' && directory.startsWith('~/')) {
      const relative = directory.slice(2);
      if (relative !== '') await h.homeDir(relative);
    }
  }
  return await h.sync.createSpace(h.service, { name, directories });
}

describe('Space ↔ workspace bridge: creation', () => {
  it('requires a primary directory and creates no Space without one', async () => {
    const h = await harness();
    const before = (await h.service.listSpaces()).length;
    await expect(
      h.sync.createSpace(h.service, { name: '空空间' }),
    ).rejects.toMatchObject({ code: 'space/workspace-required' });
    await expect(
      h.sync.createSpace(h.service, { name: '空空间', directories: [] }),
    ).rejects.toMatchObject({ code: 'space/workspace-required' });
    expect(await h.service.listSpaces()).toHaveLength(before);
    expect(h.registry.list()).toHaveLength(0);
  });

  it('maps only the primary directory and titles the workspace', async () => {
    const h = await harness();
    const work = await h.homeDir('work');
    const reference = await h.homeDir('reference');
    const space = await createSpace(h, '产品', ['~/work', reference]);
    expect(space.directories).toEqual(['~/work', reference]);
    expect(h.registry.list()).toHaveLength(1);
    const workspace = h.registry.list()[0]!;
    expect(workspace.path).toBe(await canonical(work));
    expect(workspace.title).toBe('🪐 产品');
    const link = h.store.getWorkspaceLink(space.id);
    expect(link).toMatchObject({
      spaceId: space.id,
      workspaceId: workspace.id,
      path: await canonical(work),
      appliedTitle: '🪐 产品',
    });
  });

  it('rejects a missing, relative or non-directory primary path', async () => {
    const h = await harness();
    await expect(
      h.sync.createSpace(h.service, {
        name: '缺失',
        directories: ['~/missing-directory'],
      }),
    ).rejects.toMatchObject({ code: 'space/workspace-missing' });
    await expect(
      h.sync.createSpace(h.service, {
        name: '相对',
        directories: ['relative/path'],
      }),
    ).rejects.toMatchObject({ code: 'space/workspace-invalid' });
    const file = join(h.home, 'plain.txt');
    await writeFile(file, 'not a directory');
    await expect(
      h.sync.createSpace(h.service, { name: '文件', directories: [file] }),
    ).rejects.toMatchObject({ code: 'space/workspace-invalid' });
    expect(h.registry.list()).toHaveLength(0);
    expect(await h.service.listSpaces()).toHaveLength(1);
  });

  it('adopts an existing unowned workspace and keeps its sessions', async () => {
    const h = await harness();
    const work = await h.homeDir('work');
    const seeded = h.registry.seed(
      await canonical(work),
      '原生工作区',
      ['session-1'],
    );
    const space = await createSpace(h, '项目', ['~/work']);
    expect(h.registry.list()).toHaveLength(1);
    const adopted = h.registry.get(seeded.id)!;
    expect(adopted.title).toBe('🪐 项目');
    expect(adopted.sessionIds).toEqual(['session-1']);
    expect(h.store.getWorkspaceLink(space.id)?.workspaceId).toBe(seeded.id);
  });

  it('rejects a directory already claimed by another Space', async () => {
    const h = await harness();
    const first = await createSpace(h, '甲', ['~/work']);
    await expect(
      createSpace(h, '乙', ['~/work']),
    ).rejects.toMatchObject({
      code: 'space/workspace-conflict',
      message: expect.stringContaining('甲'),
    });
    // The same canonical directory spelled as an absolute path.
    await expect(
      createSpace(h, '丙', [await h.homeDir('work')]),
    ).rejects.toMatchObject({ code: 'space/workspace-conflict' });
    // Archived Spaces keep their claim.
    await h.service.archiveSpace(first.id);
    await expect(
      createSpace(h, '丁', ['~/work']),
    ).rejects.toMatchObject({ code: 'space/workspace-conflict' });
    expect(h.registry.list()).toHaveLength(1);
  });

  it('detects a legacy Space claim that has no sidecar binding', async () => {
    const h = await harness();
    await h.homeDir('work');
    await h.service.createSpace({ name: '旧空间', directories: ['~/work'] });
    await expect(
      createSpace(h, '新空间', ['~/work']),
    ).rejects.toMatchObject({
      code: 'space/workspace-conflict',
      message: expect.stringContaining('旧空间'),
    });
  });

  it('de-duplicates workspace titles', async () => {
    const h = await harness();
    await createSpace(h, '同名', ['~/a']);
    await createSpace(h, '同名', ['~/b']);
    expect(h.registry.list().map((workspace) => workspace.title)).toEqual([
      '🪐 同名',
      '🪐 同名（2）',
    ]);
  });

  it('rolls back a workspace created for a failed Space', async () => {
    const h = await harness();
    await h.homeDir('work');
    const failing: SpaceServiceLike = {
      ...h.service,
      createSpace: async () => {
        throw new Error('空间名称不能为空');
      },
    };
    await expect(
      h.sync.createSpace(failing, { name: '回滚', directories: ['~/work'] }),
    ).rejects.toThrow('空间名称不能为空');
    expect(h.registry.list()).toHaveLength(0);
  });

  it('does not delete an adopted workspace when Space creation fails', async () => {
    const h = await harness();
    const work = await h.homeDir('work');
    const seeded = h.registry.seed(await canonical(work), '原生');
    const failing: SpaceServiceLike = {
      ...h.service,
      createSpace: async () => {
        throw new Error('空间名称不能为空');
      },
    };
    await expect(
      h.sync.createSpace(failing, { name: '回滚', directories: ['~/work'] }),
    ).rejects.toThrow();
    // Adoption is reused, and the applied title is rolled back.
    expect(h.registry.get(seeded.id)?.title).toBe('原生');
    expect(h.registry.list()).toHaveLength(1);
  });

  it('does not create a workspace when the Space name is invalid', async () => {
    const h = await harness();
    await h.homeDir('work');
    await expect(
      h.sync.createSpace(h.service, { name: '   ', directories: ['~/work'] }),
    ).rejects.toThrow();
    expect(h.registry.list()).toHaveLength(0);
  });
});

describe('Space ↔ workspace bridge: rename', () => {
  it('keeps the workspace title in sync and de-duplicates', async () => {
    const h = await harness();
    const first = await createSpace(h, '甲', ['~/a']);
    await createSpace(h, '乙', ['~/b']);
    const firstWorkspace = h.registry
      .list()
      .find((workspace) => workspace.title === '🪐 甲')!;
    await h.sync.updateSpace(h.service, first.id, { name: '乙' });
    expect(firstWorkspace.title).toBe('🪐 乙（2）');
    expect(h.store.getWorkspaceLink(first.id)?.appliedTitle).toBe('🪐 乙（2）');
  });

  it('overwrites a workspace title the user renamed in DSH', async () => {
    const h = await harness();
    const space = await createSpace(h, '原名', ['~/work']);
    const workspace = h.registry.list()[0]!;
    workspace.title = '手工标题';
    await h.sync.updateSpace(h.service, space.id, { name: '新名' });
    expect(workspace.title).toBe('🪐 新名');
  });

  it('does not resurrect a workspace deleted in DSH on rename', async () => {
    const h = await harness();
    const space = await createSpace(h, '原名', ['~/work']);
    await h.registry.delete(h.registry.list()[0]!.id);
    const renamed = await h.sync.updateSpace(h.service, space.id, {
      name: '新名',
    });
    expect(renamed.name).toBe('新名');
    expect(h.registry.list()).toHaveLength(0);
    expect(h.store.getWorkspaceLink(space.id)).toBeDefined();
  });
});

describe('Space ↔ workspace bridge: primary directory changes', () => {
  it('releases the old workspace and binds the new primary directory', async () => {
    const h = await harness();
    const space = await createSpace(h, '项目', ['~/old']);
    const oldWorkspace = h.registry.list()[0]!;
    const next = await h.homeDir('next');
    const nextCanonical = await canonical(next);
    await h.sync.updateSpace(h.service, space.id, {
      directories: ['~/next', '~/old'],
    });
    // Old registration survives without the marker; sessions stay accounted.
    const released = h.registry.get(oldWorkspace.id)!;
    expect(released.title).toBe('项目');
    // New primary directory owns a fresh workspace with the marker.
    const bound = h.registry.list().find(
      (workspace) => workspace.path === nextCanonical,
    )!;
    expect(bound.title).toBe('🪐 项目');
    expect(h.store.getWorkspaceLink(space.id)).toMatchObject({
      workspaceId: bound.id,
      path: await canonical(next),
    });
  });

  it('does not rebind when only reference directories change', async () => {
    const h = await harness();
    const space = await createSpace(h, '项目', ['~/work', '~/ref-one']);
    const before = h.registry.list()[0]!;
    await h.homeDir('ref-two');
    await h.sync.updateSpace(h.service, space.id, {
      directories: ['~/work', '~/ref-two'],
    });
    expect(h.registry.list()).toHaveLength(1);
    expect(h.registry.list()[0]!.id).toBe(before.id);
    expect(before.title).toBe('🪐 项目');
  });

  it('treats a different spelling of the same directory as unchanged', async () => {
    const h = await harness();
    const work = await h.homeDir('work');
    const space = await createSpace(h, '项目', [work]);
    const before = h.registry.list()[0]!;
    await h.sync.updateSpace(h.service, space.id, {
      directories: ['~/work'],
    });
    expect(h.registry.list()).toHaveLength(1);
    expect(h.registry.list()[0]!.id).toBe(before.id);
    expect(h.store.getWorkspaceLink(space.id)?.workspaceId).toBe(before.id);
  });

  it('releases the binding when the primary directory is cleared', async () => {
    const h = await harness();
    const space = await createSpace(h, '项目', ['~/work']);
    const workspace = h.registry.list()[0]!;
    await h.sync.updateSpace(h.service, space.id, { directories: [] });
    expect(h.store.getWorkspaceLink(space.id)).toBeUndefined();
    expect(h.registry.get(workspace.id)?.title).toBe('项目');
  });

  it('rejects a new primary directory claimed by another Space', async () => {
    const h = await harness();
    await createSpace(h, '甲', ['~/shared']);
    const second = await createSpace(h, '乙', ['~/other']);
    await expect(
      h.sync.updateSpace(h.service, second.id, { directories: ['~/shared'] }),
    ).rejects.toMatchObject({ code: 'space/workspace-conflict' });
    // The Space itself was not updated.
    expect((await h.service.getSpace(second.id))?.directories).toEqual([
      '~/other',
    ]);
  });

  it('rejects an invalid new primary directory without touching the Space', async () => {
    const h = await harness();
    const space = await createSpace(h, '项目', ['~/work']);
    await expect(
      h.sync.updateSpace(h.service, space.id, {
        directories: ['~/missing'],
      }),
    ).rejects.toMatchObject({ code: 'space/workspace-missing' });
    expect((await h.service.getSpace(space.id))?.directories).toEqual([
      '~/work',
    ]);
    expect(h.store.getWorkspaceLink(space.id)).toBeDefined();
  });

  it('binds a legacy Space on its first edit', async () => {
    const h = await harness();
    const work = await h.homeDir('legacy');
    const legacy = await h.service.createSpace({
      name: '旧空间',
      directories: [work],
    });
    expect(h.store.getWorkspaceLink(legacy.id)).toBeUndefined();
    await h.sync.updateSpace(h.service, legacy.id, { goal: '更新目标' });
    const link = h.store.getWorkspaceLink(legacy.id);
    expect(link?.path).toBe(await canonical(work));
    expect(h.registry.list()[0]?.title).toBe('🪐 旧空间');
  });
});

describe('Space ↔ workspace bridge: archive, restore and delete', () => {
  it('leaves the workspace untouched on archive', async () => {
    const h = await harness();
    const space = await createSpace(h, '项目', ['~/work']);
    const workspace = h.registry.list()[0]!;
    await h.service.archiveSpace(space.id);
    expect(h.registry.get(workspace.id)?.title).toBe('🪐 项目');
    expect(h.store.getWorkspaceLink(space.id)).toBeDefined();
  });

  it('keeps a healthy binding on restore', async () => {
    const h = await harness();
    const space = await createSpace(h, '项目', ['~/work']);
    const workspace = h.registry.list()[0]!;
    await h.service.archiveSpace(space.id);
    const restored = await h.sync.unarchiveSpace(h.service, space.id);
    expect(restored.archivedAt).toBeNull();
    expect(h.registry.list()).toHaveLength(1);
    expect(h.store.getWorkspaceLink(space.id)?.workspaceId).toBe(workspace.id);
  });

  it('rebinds a workspace deleted in DSH on restore', async () => {
    const h = await harness();
    const space = await createSpace(h, '项目', ['~/work']);
    const work = await canonical(await h.homeDir('work'));
    await h.service.archiveSpace(space.id);
    await h.registry.delete(h.registry.list()[0]!.id);
    await h.sync.unarchiveSpace(h.service, space.id);
    const recreated = h.registry.list()[0]!;
    expect(recreated.path).toBe(work);
    expect(recreated.title).toBe('🪐 项目');
    expect(h.store.getWorkspaceLink(space.id)?.workspaceId).toBe(recreated.id);
  });

  it('restores the Space even when the directory is gone', async () => {
    const h = await harness();
    const space = await createSpace(h, '项目', ['~/gone']);
    const link = h.store.getWorkspaceLink(space.id);
    await h.service.archiveSpace(space.id);
    await rm(join(h.home, 'gone'), { recursive: true, force: true });
    const restored = await h.sync.unarchiveSpace(h.service, space.id);
    expect(restored.archivedAt).toBeNull();
    // The stale link is kept so a later explicit action can rebind.
    expect(h.store.getWorkspaceLink(space.id)).toEqual(link);
  });

  it('deletes the Space but keeps the workspace registration', async () => {
    const h = await harness();
    const space = await createSpace(h, '项目', ['~/work']);
    const workspace = h.registry.list()[0]!;
    workspace.sessionIds.push('session-1');
    await h.sync.deleteSpace(h.service, space.id);
    expect(await h.service.getSpace(space.id)).toBeUndefined();
    const kept = h.registry.get(workspace.id)!;
    expect(kept.title).toBe('项目');
    expect(kept.sessionIds).toEqual(['session-1']);
    expect(h.store.getWorkspaceLink(space.id)).toBeUndefined();
  });

  it('keeps a title the user renamed by hand on delete', async () => {
    const h = await harness();
    const space = await createSpace(h, '项目', ['~/work']);
    const workspace = h.registry.list()[0]!;
    workspace.title = '手工命名';
    await h.sync.deleteSpace(h.service, space.id);
    expect(h.registry.get(workspace.id)?.title).toBe('手工命名');
  });
});

describe('Space ↔ workspace bridge: reconciliation', () => {
  it('drops sidecar rows whose Space is gone', async () => {
    const h = await harness();
    const space = await createSpace(h, '项目', ['~/work']);
    await h.service.deleteSpace(space.id); // bypasses the bridge on purpose
    await h.sync.reconcileAll();
    expect(h.store.getWorkspaceLink(space.id)).toBeUndefined();
  });

  it('does not resurrect workspaces the user deleted in DSH at startup', async () => {
    const h = await harness();
    const space = await createSpace(h, '项目', ['~/work']);
    const link = h.store.getWorkspaceLink(space.id);
    await h.registry.delete(link!.workspaceId);
    await h.sync.reconcileAll();
    expect(h.registry.list()).toHaveLength(0);
    expect(h.store.getWorkspaceLink(space.id)).toBeDefined();
  });

  it('releases a binding whose Space lost its primary directory', async () => {
    const h = await harness();
    const space = await createSpace(h, '项目', ['~/work']);
    await h.store.update((data) => {
      const target = data.spaces.find((item) => item.id === space.id);
      if (target !== undefined) target.directories = [];
    });
    await h.sync.reconcileAll();
    expect(h.store.getWorkspaceLink(space.id)).toBeUndefined();
  });

  it('keeps timestamps deterministic under the injected clock', async () => {
    const h = await harness();
    const space = await createSpace(h, '项目', ['~/work']);
    expect(h.store.getWorkspaceLink(space.id)?.updatedAt).toBe(
      FIXED_NOW().toISOString(),
    );
  });
});
