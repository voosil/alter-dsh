import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SPACE_ID,
  SPACE_DB_FILE,
  openSpaceStore,
  type SpaceStoreHandle,
  type SpaceWorkspaceLink,
} from '../../host/persistence/store.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'alter-space-store-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function note(id: string, spaceId: string): Record<string, unknown> {
  return {
    id,
    spaceId,
    kind: 'note',
    title: id,
    parentId: null,
    creator: 'me',
    pinned: false,
    archived: false,
    archivedBy: null,
    archivedAt: null,
    deletedAt: null,
    deletedRoot: false,
    originalParentId: null,
    unread: false,
    content: '',
    activity: 0,
    activityAt: '2026-01-01T00:00:00.000Z',
    lastOpenCreditAt: null,
    lastEditCreditAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    order: 0,
  };
}

const fixedNow = () => new Date('2026-11-06T00:00:00.000Z');

describe('SQLite Space store', () => {
  it('creates the default database on first open', async () => {
    const dir = await tempDir();
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    expect(store.file).toBe(join(dir, SPACE_DB_FILE));
    const data = store.read();
    expect(data.version).toBe(1);
    expect(data.spaces).toHaveLength(1);
    expect(data.spaces[0]?.id).toBe(DEFAULT_SPACE_ID);
    await store.close();
    const files = await readdir(dir);
    expect(files).toContain(SPACE_DB_FILE);
  });

  it('persists entity changes and reloads them', async () => {
    const dir = await tempDir();
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    await store.update((data) => {
      data.spaces.push({
        id: 'sp-a',
        name: 'A',
        goal: '',
        directories: [],
        collaboratorIds: [],
        isDefault: false,
        order: 1,
        createdAt: fixedNow().toISOString(),
        archivedAt: null,
      });
      (data.nodes as unknown as Array<Record<string, unknown>>).push(note('node-1', 'sp-a'));
    });
    await store.close();

    const reopened = await openSpaceStore({ directory: dir, now: fixedNow });
    expect(reopened.read().spaces.map((space) => space.id)).toEqual([
      DEFAULT_SPACE_ID,
      'sp-a',
    ]);
    expect(reopened.read().nodes.map((node) => node.id)).toEqual(['node-1']);
    await reopened.close();
  });

  it('preserves array order across deletes and inserts', async () => {
    const dir = await tempDir();
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    await store.update((data) => {
      const nodes = data.nodes as unknown as Array<Record<string, unknown>>;
      nodes.push(note('a', DEFAULT_SPACE_ID), note('b', DEFAULT_SPACE_ID), note('c', DEFAULT_SPACE_ID));
    });
    await store.update((data) => {
      const nodes = data.nodes as unknown as Array<Record<string, unknown>>;
      nodes.splice(1, 1); // remove b
      nodes.unshift(note('z', DEFAULT_SPACE_ID));
    });
    await store.close();
    const reopened = await openSpaceStore({ directory: dir, now: fixedNow });
    expect(
      reopened.read().nodes.map((node) => node.id),
    ).toEqual(['z', 'a', 'c']);
    await reopened.close();
  });

  it('serializes concurrent updates', async () => {
    const dir = await tempDir();
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.update((data) => {
          (data.thoughts as unknown as Array<Record<string, unknown>>).push({
            id: `thought-${index}`,
            spaceId: DEFAULT_SPACE_ID,
            content: `t${index}`,
            createdAt: fixedNow().toISOString(),
          });
        }),
      ),
    );
    expect(store.read().thoughts).toHaveLength(20);
    await store.close();
    const reopened = await openSpaceStore({ directory: dir, now: fixedNow });
    expect(reopened.read().thoughts).toHaveLength(20);
    await reopened.close();
  });

  it('rolls back the in-memory value when a change throws', async () => {
    const dir = await tempDir();
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    await expect(
      store.update((data) => {
        (data.spaces as unknown as Array<Record<string, unknown>>).push({
          id: 'sp-throw',
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(store.read().spaces).toHaveLength(1);
    await store.close();
    const reopened = await openSpaceStore({ directory: dir, now: fixedNow });
    expect(reopened.read().spaces).toHaveLength(1);
    await reopened.close();
  });

  it('rejects writes after close', async () => {
    const dir = await tempDir();
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    await store.close();
    await expect(store.update(() => undefined)).rejects.toThrow('已关闭');
  });

  it('backs up a corrupt database and starts fresh', async () => {
    const dir = await tempDir();
    const first = await openSpaceStore({ directory: dir, now: fixedNow });
    await first.update((data) => {
      (data.spaces as unknown as Array<Record<string, unknown>>).push({
        id: 'sp-keep',
      });
    });
    await first.close();
    await writeFile(join(dir, SPACE_DB_FILE), 'not a sqlite database');
    const warnings: string[] = [];
    const reopened = await openSpaceStore({
      directory: dir,
      now: fixedNow,
      logger: { warn: (message) => warnings.push(message) },
    });
    expect(warnings.join('\n')).toContain('损坏');
    expect(reopened.read().spaces.map((space) => space.id)).toEqual([
      DEFAULT_SPACE_ID,
    ]);
    expect((await readdir(dir)).some((name) => name.includes('.corrupt-'))).toBe(true);
    await reopened.close();
  });


  it('bounds corruption backups across repeated failures', async () => {
    const dir = await tempDir();
    let clock = Date.parse('2026-03-01T00:00:00.000Z');
    const now = () => new Date((clock += 60_000));
    for (let index = 0; index < 5; index += 1) {
      await writeFile(join(dir, SPACE_DB_FILE), `not a sqlite database ${index}`);
      const store = await openSpaceStore({ directory: dir, now, logger: {} });
      await store.close();
    }
    const backupNames = (await readdir(dir)).filter((name) =>
      name.startsWith(`${SPACE_DB_FILE}.corrupt-`),
    );
    const groups = new Set(
      backupNames.map((name) =>
        name
          .replace(`${SPACE_DB_FILE}.corrupt-`, '')
          .replace(/-(?:wal|shm|journal)$/u, '')
          .replace(/-\d+-\d+$/u, ''),
      ),
    );
    expect(groups.size).toBeLessThanOrEqual(2);
    expect(backupNames.length).toBeGreaterThan(0);
  });

  it('does not move a healthy database aside on an unreadable file', async () => {
    if (
      process.platform === 'win32' ||
      (typeof process.getuid === 'function' && process.getuid() === 0)
    )
      return;
    const dir = await tempDir();
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    await store.update((data) => {
      (data.nodes as unknown as Array<Record<string, unknown>>).push(
        note('node-keep', DEFAULT_SPACE_ID),
      );
    });
    await store.close();
    const file = join(dir, SPACE_DB_FILE);
    await chmod(file, 0o000);
    try {
      await expect(
        openSpaceStore({ directory: dir, now: fixedNow }),
      ).rejects.toThrow();
      expect(
        (await readdir(dir)).some((name) => name.includes('.corrupt-')),
      ).toBe(false);
    } finally {
      await chmod(file, 0o600);
    }
    const reopened = await openSpaceStore({ directory: dir, now: fixedNow });
    expect(reopened.read().nodes.map((node) => node.id)).toEqual(['node-keep']);
    await reopened.close();
  });

  it('persists and deletes Space ↔ workspace links across reopens', async () => {
    const dir = await tempDir();
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    expect(store.listWorkspaceLinks()).toEqual([]);
    const link: SpaceWorkspaceLink = {
      spaceId: 'sp-link',
      workspaceId: 'ws-1',
      path: '/tmp/space-link',
      appliedTitle: '🪐 链接',
      updatedAt: fixedNow().toISOString(),
    };
    await store.setWorkspaceLink(link);
    expect(store.getWorkspaceLink('sp-link')).toEqual(link);
    expect(store.listWorkspaceLinks()).toEqual([link]);
    await store.close();

    const reopened = await openSpaceStore({ directory: dir, now: fixedNow });
    expect(reopened.getWorkspaceLink('sp-link')).toEqual(link);
    await reopened.deleteWorkspaceLink('sp-link');
    expect(reopened.listWorkspaceLinks()).toEqual([]);
    await reopened.close();

    const again = await openSpaceStore({ directory: dir, now: fixedNow });
    expect(again.getWorkspaceLink('sp-link')).toBeUndefined();
    await again.close();
  });

  it('upgrades a v1 database in place and keeps its business data', async () => {
    const dir = await tempDir();
    const file = join(dir, SPACE_DB_FILE);
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    await store.update((data) => {
      (data.nodes as unknown as Array<Record<string, unknown>>).push(
        note('node-v1', DEFAULT_SPACE_ID),
      );
    });
    await store.close();

    // Simulate a database written by the v1 plugin release.
    const legacy = new DatabaseSync(file);
    legacy.exec('DROP TABLE document_ops');
    legacy.exec('DROP TABLE document_assets');
    legacy.exec('DROP TABLE document_objects');
    legacy.exec('DROP TABLE workspace_links');
    legacy.exec('PRAGMA user_version = 1');
    legacy.close();

    const upgraded = await openSpaceStore({ directory: dir, now: fixedNow });
    expect(upgraded.read().nodes.map((node) => node.id)).toEqual(['node-v1']);
    expect(upgraded.getWorkspaceLink('sp-missing')).toBeUndefined();
    await upgraded.setWorkspaceLink({
      spaceId: 'sp-upgraded',
      workspaceId: 'ws-upgraded',
      path: '/tmp/upgraded',
      appliedTitle: '🪐 升级',
      updatedAt: fixedNow().toISOString(),
    });
    await upgraded.close();

    const probe = new DatabaseSync(file);
    const version = probe.prepare('PRAGMA user_version').get() as {
      user_version?: number;
    };
    expect(Number(version.user_version)).toBe(3);
    probe.close();
  });

  it('commits document sidecar rows atomically with entity writes', async () => {
    const dir = await tempDir();
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    await store.transactDocument((data, sidecar) => {
      (data.nodes as unknown as Array<Record<string, unknown>>).push(
        note('node-doc', DEFAULT_SPACE_ID),
      );
      sidecar.putObject({
        id: 'obj_1',
        docId: 'node-doc',
        type: 'mindmap',
        schemaVersion: 1,
        payload: { root: { id: 'n1', text: 'root' } },
        createdAt: fixedNow().toISOString(),
      });
      sidecar.appendOp({
        id: 'op_1',
        docId: 'node-doc',
        revision: 1,
        actor: 'alter',
        ops: [{ op: 'update_attrs', target: 'blk_1', attrs: {} }],
        inverseOps: [],
        changedBlockIds: ['blk_1'],
        diff: { applied: [], changedBlockIds: ['blk_1'] },
        createdAt: fixedNow().toISOString(),
      });
    });
    expect(store.read().nodes.map((node) => node.id)).toContain('node-doc');
    expect(store.getDocumentObject('obj_1')?.payload).toEqual({
      root: { id: 'n1', text: 'root' },
    });
    expect(store.listDocumentOps('node-doc')).toHaveLength(1);

    await expect(
      store.transactDocument((data, sidecar) => {
        (data.nodes as unknown as Array<Record<string, unknown>>).push(
          note('node-rollback', DEFAULT_SPACE_ID),
        );
        sidecar.putObject({
          id: 'obj_2',
          docId: 'node-doc',
          type: 'component',
          schemaVersion: 1,
          payload: {
            format: 'alter-component/1',
            componentId: 'builtin/stat',
            componentVersion: 1,
            props: { label: '指标', value: '42' },
          },
          createdAt: fixedNow().toISOString(),
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(store.read().nodes.map((node) => node.id)).not.toContain(
      'node-rollback',
    );
    expect(store.getDocumentObject('obj_2')).toBeUndefined();

    await store.close();
    const reopened = await openSpaceStore({ directory: dir, now: fixedNow });
    expect(reopened.getDocumentObject('obj_1')?.type).toBe('mindmap');
    expect(reopened.listDocumentObjects('node-doc')).toHaveLength(1);
    expect(reopened.listDocumentOps('node-doc')).toHaveLength(1);
    await reopened.close();
  });

  it('ignores malformed workspace link rows instead of failing startup', async () => {
    const dir = await tempDir();
    const file = join(dir, SPACE_DB_FILE);
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    await store.close();
    const db = new DatabaseSync(file);
    db.prepare(
      'INSERT INTO workspace_links (space_id, data) VALUES (?, ?)',
    ).run('sp-broken', '{"spaceId":"sp-broken"}');
    db.close();
    const reopened = await openSpaceStore({ directory: dir, now: fixedNow });
    expect(reopened.listWorkspaceLinks()).toEqual([]);
    await reopened.close();
  });

  it('refuses a database schema newer than the plugin supports', async () => {
    const dir = await tempDir();
    const file = join(dir, SPACE_DB_FILE);
    const db = new DatabaseSync(file);
    db.exec('PRAGMA user_version = 99');
    db.close();
    await expect(openSpaceStore({ directory: dir, now: fixedNow })).rejects.toThrow(
      '升级插件',
    );
  });
});
