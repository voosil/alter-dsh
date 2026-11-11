/**
 * Storage policy end-to-end: persisted settings, bounded version history,
 * daily snapshots, and the footprint estimate the settings UI displays.
 */
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { createSpaceAuthority } from '../../../host/authority/compose.js';
import {
  createDailySnapshot,
  listSnapshots,
  snapshotFileName,
} from '../../../host/persistence/backup.js';
import { trimAllVersions, withVersionRetention } from '../../../host/persistence/retention.js';
import { DEFAULT_STORAGE_SETTINGS } from '../../../host/persistence/settings.js';
import { createSpaceStorage } from '../../../host/persistence/storage.js';
import { DEFAULT_SPACE_ID, openSpaceStore } from '../../../host/persistence/store.js';

const dirs: string[] = [];
const logger = { info: () => undefined, warn: () => undefined };

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'alter-space-storage-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const fixedNow = () => new Date('2026-11-06T00:00:00.000Z');

function note(id: string, spaceId: string, content = ''): Record<string, unknown> {
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
    content,
    activity: 0,
    activityAt: '2026-01-01T00:00:00.000Z',
    lastOpenCreditAt: null,
    lastEditCreditAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    order: 0,
  };
}

describe('storage settings', () => {
  it('starts at the defaults and persists a change across reopen', async () => {
    const dir = await tempDir();
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    expect(store.getStorageSettings()).toEqual(DEFAULT_STORAGE_SETTINGS);
    await store.setStorageSettings({ historyLimit: 7, snapshotKeep: 2 });
    await store.close();

    const reopened = await openSpaceStore({ directory: dir, now: fixedNow });
    expect(reopened.getStorageSettings()).toEqual({
      historyLimit: 7,
      snapshotKeep: 2,
    });
    await reopened.close();
  });

  it('falls back to defaults for an unreadable policy row', async () => {
    const dir = await tempDir();
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    await store.close();
    const db = new DatabaseSync(join(dir, 'space.db'));
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('settings:storage', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run('not-json');
    db.close();
    const reopened = await openSpaceStore({ directory: dir, now: fixedNow });
    expect(reopened.getStorageSettings()).toEqual(DEFAULT_STORAGE_SETTINGS);
    await reopened.close();
  });
});

describe('bounded version history', () => {
  it('keeps only the newest versions of the document being edited', async () => {
    let clock = Date.parse('2026-05-01T00:00:00.000Z');
    const now = () => new Date(clock);
    const dir = await tempDir();
    const store = await openSpaceStore({ directory: dir, now });
    await store.setStorageSettings({ historyLimit: 2, snapshotKeep: 3 });
    const retained = withVersionRetention(store, () => store.getStorageSettings());
    const service = createSpaceAuthority(retained, now);
    const node = await service.createNode({
      spaceId: DEFAULT_SPACE_ID,
      kind: 'note',
      title: 'doc',
    });
    for (let index = 0; index < 6; index += 1) {
      clock += 6 * 60_000;
      await service.saveNode(node.id, { content: `v${index}` });
    }
    const versions = store
      .read()
      .versions.filter((version) => version.docId === node.id);
    expect(versions).toHaveLength(2);
    expect(versions.at(-1)?.content).toBe('v5');
    await store.close();
  });

  it('applies a lowered limit to history that already exists', async () => {
    let clock = Date.parse('2026-05-01T00:00:00.000Z');
    const now = () => new Date(clock);
    const dir = await tempDir();
    const store = await openSpaceStore({ directory: dir, now });
    const service = createSpaceAuthority(store, now);
    const node = await service.createNode({
      spaceId: DEFAULT_SPACE_ID,
      kind: 'note',
      title: 'doc',
    });
    for (let index = 0; index < 5; index += 1) {
      clock += 6 * 60_000;
      await service.saveNode(node.id, { content: `v${index}` });
    }
    expect(store.read().versions).toHaveLength(5);

    const storage = createSpaceStorage({ store, directory: dir });
    const state = await storage.set({ historyLimit: 2 });
    expect(state.settings).toEqual({ historyLimit: 2, snapshotKeep: 3 });
    expect(store.read().versions).toHaveLength(2);
    await store.close();
  });

  it('honours the per-document byte budget for large documents', () => {
    const data = {
      version: 1 as const,
      spaces: [],
      nodes: [],
      thoughts: [],
      comments: [],
      agents: [],
      tasks: [],
      events: [],
      milestones: [],
      hub: {},
      versions: Array.from({ length: 3 }, (_, index) => ({
        id: `ver-${index}`,
        docId: 'doc-1',
        title: 't',
        content: 'x'.repeat(40 * 1024),
        author: 'me' as const,
        at: `2026-01-01T00:0${index}:00.000Z`,
      })),
    };
    trimAllVersions(data, { historyLimit: 100, snapshotKeep: 3 });
    // 64 KiB budget fits only the newest 40 KiB version.
    expect(data.versions).toHaveLength(1);
    expect(data.versions[0]?.id).toBe('ver-2');
  });
});

describe('daily snapshots', () => {
  it('writes one consistent snapshot per day and prunes the ring', async () => {
    let clock = new Date('2026-02-01T10:00:00.000Z');
    const now = () => new Date(clock);
    const dir = await tempDir();
    const store = await openSpaceStore({ directory: dir, now });
    await store.setStorageSettings({ historyLimit: 10, snapshotKeep: 2 });
    await store.update((data) => {
      (data.nodes as unknown as Array<Record<string, unknown>>).push(
        note('doc-1', DEFAULT_SPACE_ID, 'hello'),
      );
    });

    const first = await createDailySnapshot({ store, directory: dir, now, logger });
    expect(first.status).toBe('created');
    let files = await listSnapshots(dir);
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe(snapshotFileName(clock));

    // The compressed copy is a valid database with the committed data.
    const archive = await readFile(files[0]!.path);
    const restoredFile = join(dir, 'restored.db');
    await writeFile(restoredFile, gunzipSync(archive));
    const restored = new DatabaseSync(restoredFile, { readOnly: true });
    expect(restored.prepare('PRAGMA quick_check').get()).toEqual({
      quick_check: 'ok',
    });
    expect(restored.prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({
      n: 1,
    });
    restored.close();

    const repeated = await createDailySnapshot({ store, directory: dir, now, logger });
    expect(repeated.status).toBe('skipped');

    clock = new Date('2026-02-02T10:00:00.000Z');
    expect(
      (await createDailySnapshot({ store, directory: dir, now, logger })).status,
    ).toBe('created');
    clock = new Date('2026-02-03T10:00:00.000Z');
    expect(
      (await createDailySnapshot({ store, directory: dir, now, logger })).status,
    ).toBe('created');

    files = await listSnapshots(dir);
    expect(files).toHaveLength(2);
    expect(files.map((file) => file.name)).toEqual([
      'space-20260202.db.gz',
      'space-20260203.db.gz',
    ]);
    expect((await stat(files[0]!.path)).size).toBeGreaterThan(0);
    await store.close();
  });

  it('copies committed data out of the WAL while the store stays open', async () => {
    const dir = await tempDir();
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    await store.update((data) => {
      (data.nodes as unknown as Array<Record<string, unknown>>).push(
        note('doc-wal', DEFAULT_SPACE_ID, 'in the wal'),
      );
    });
    const snapshot = join(dir, 'snapshot.db');
    await store.snapshotInto(snapshot);
    const copy = new DatabaseSync(snapshot, { readOnly: true });
    expect(copy.prepare('PRAGMA quick_check').get()).toEqual({
      quick_check: 'ok',
    });
    expect(copy.prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({
      n: 1,
    });
    copy.close();
    // The live store still accepts writes afterwards.
    await store.update((data) => {
      data.nodes[0]!.title = 'after snapshot';
    });
    expect(store.read().nodes[0]?.title).toBe('after snapshot');
    await store.close();
  });
});

describe('storage estimate', () => {
  it('reports the current data and a policy-dependent upper bound', async () => {
    const dir = await tempDir();
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    await store.update((data) => {
      for (let index = 0; index < 3; index += 1)
        (data.nodes as unknown as Array<Record<string, unknown>>).push(
          note(`doc-${index}`, DEFAULT_SPACE_ID, 'y'.repeat(2000)),
        );
      data.versions.push({
        id: 'ver-1',
        docId: 'doc-0',
        title: 'doc-0',
        content: 'y'.repeat(2000),
        author: 'me',
        at: '2026-01-01T00:00:00.000Z',
      });
    });
    const storage = createSpaceStorage({ store, directory: dir });
    const state = await storage.get();
    expect(state.settings).toEqual(DEFAULT_STORAGE_SETTINGS);
    expect(state.estimate.documentCount).toBe(3);
    expect(state.estimate.averageDocumentBytes).toBeGreaterThan(0);
    expect(state.estimate.currentBytes).toBeGreaterThan(0);

    const wide = await storage.estimate({ historyLimit: 100 });
    const narrow = await storage.estimate({ historyLimit: 1 });
    expect(wide.projectedMainBytes).toBeGreaterThan(
      narrow.projectedMainBytes,
    );
    expect(wide.projectedBytes).toBeGreaterThanOrEqual(
      wide.projectedMainBytes,
    );
    expect(state.estimate.deltaBytes).toBe(
      state.estimate.projectedBytes - state.estimate.currentBytes,
    );
    await store.close();
  });
});

describe('snapshot policy pruning', () => {
  it('prunes existing snapshots as soon as the keep count is lowered', async () => {
    let clock = new Date('2026-02-01T10:00:00.000Z');
    const now = () => new Date(clock);
    const dir = await tempDir();
    const store = await openSpaceStore({ directory: dir, now });
    await store.setStorageSettings({ historyLimit: 10, snapshotKeep: 3 });
    for (const day of [1, 2, 3]) {
      clock = new Date(`2026-02-0${day}T10:00:00.000Z`);
      expect(
        (await createDailySnapshot({ store, directory: dir, now, logger }))
          .status,
      ).toBe('created');
    }
    expect(await listSnapshots(dir)).toHaveLength(3);

    const storage = createSpaceStorage({ store, directory: dir });
    const state = await storage.set({ snapshotKeep: 1 });

    const files = await listSnapshots(dir);
    expect(files.map((file) => file.name)).toEqual(['space-20260203.db.gz']);
    expect(state.settings.snapshotKeep).toBe(1);
    await store.close();
  });
});
