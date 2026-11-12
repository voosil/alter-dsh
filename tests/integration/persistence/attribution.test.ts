/**
 * Attribution guard: same-transaction identity invariants, rollback on
 * violation, historical backfill and system idle-archiving on both stacks.
 */
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createSpaceAuthority } from '../../../host/authority/compose.js';
import { AttributionGuardError } from '../../../host/persistence/attribution.js';
import {
  DEFAULT_SPACE_ID,
  SPACE_DB_FILE,
  openSpaceStore,
  type SpaceStoreHandle,
} from '../../../host/persistence/store.js';
import { FIXED_NOW, dispose, tempDir } from '../../support/lifecycle.js';

async function openStore(now?: () => Date): Promise<{
  store: SpaceStoreHandle;
  dir: string;
}> {
  const dir = await tempDir('space-attribution-');
  const store = await openSpaceStore({ directory: dir, now: now ?? FIXED_NOW });
  dispose(() => store.close());
  return { store, dir };
}

function note(id: string, creator: 'me' | 'alter'): Record<string, unknown> {
  return {
    id,
    spaceId: DEFAULT_SPACE_ID,
    kind: 'note',
    title: id,
    parentId: null,
    creator,
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
    activityAt: FIXED_NOW().toISOString(),
    lastOpenCreditAt: null,
    lastEditCreditAt: null,
    createdAt: FIXED_NOW().toISOString(),
    updatedAt: FIXED_NOW().toISOString(),
    order: 0,
  };
}

function thought(id: string, creator: 'me' | 'alter'): Record<string, unknown> {
  return {
    id,
    spaceId: DEFAULT_SPACE_ID,
    content: `随想 ${id}`,
    creator,
    createdAt: FIXED_NOW().toISOString(),
    updatedAt: FIXED_NOW().toISOString(),
    archived: false,
    archivedAt: null,
    deletedAt: null,
    convertedDocId: null,
  };
}

function event(id: string, source: 'user' | 'agent' | 'system'): Record<string, unknown> {
  return {
    id,
    spaceId: DEFAULT_SPACE_ID,
    title: `事件 ${id}`,
    detail: '',
    at: FIXED_NOW().toISOString(),
    docId: null,
    taskId: null,
    source,
  };
}

describe('attribution guard', () => {
  it('accepts new entities whose attribution matches the acting identity', async () => {
    const { store } = await openStore();
    await store.updateAs('user', (data) => {
      (data.nodes as unknown as Array<Record<string, unknown>>).push(note('n-user', 'me'));
      (data.thoughts as unknown as Array<Record<string, unknown>>).push(thought('t-user', 'me'));
      (data.events as unknown as Array<Record<string, unknown>>).push(event('e-user', 'user'));
      data.tasks.push({
        id: 'task-user',
        spaceId: DEFAULT_SPACE_ID,
        title: '任务',
        detail: '',
        status: 'pending',
        owner: 'me',
        docId: null,
        createdAt: FIXED_NOW().toISOString(),
      });
    });
    await store.updateAs('alter', (data) => {
      (data.nodes as unknown as Array<Record<string, unknown>>).push(note('n-alter', 'alter'));
      (data.thoughts as unknown as Array<Record<string, unknown>>).push(thought('t-alter', 'alter'));
      (data.events as unknown as Array<Record<string, unknown>>).push(event('e-alter', 'agent'));
      data.tasks.push({
        id: 'task-alter',
        spaceId: DEFAULT_SPACE_ID,
        title: '任务',
        detail: '',
        status: 'pending',
        owner: 'alter',
        docId: null,
        createdAt: FIXED_NOW().toISOString(),
      });
    });
    expect(store.read().nodes.map((node) => node.creator)).toEqual(['me', 'alter']);
    expect(store.read().events.map((item) => item.source)).toEqual(['user', 'agent']);
  });

  it('refuses a new entity with the wrong attribution and rolls back memory and disk', async () => {
    const { store, dir } = await openStore();
    await expect(
      store.updateAs('user', (data) => {
        (data.nodes as unknown as Array<Record<string, unknown>>).push(note('n-forged', 'alter'));
      }),
    ).rejects.toBeInstanceOf(AttributionGuardError);
    expect(store.read().nodes).toHaveLength(0);
    await store.close();
    const reopened = await openSpaceStore({ directory: dir, now: FIXED_NOW });
    expect(reopened.read().nodes).toHaveLength(0);
    await reopened.close();
  });

  it('refuses a new entity that lacks its attribution field', async () => {
    const { store } = await openStore();
    const missing = event('e-missing', 'agent');
    delete missing.source;
    await expect(
      store.updateAs('alter', (data) => {
        (data.events as unknown as Array<Record<string, unknown>>).push(missing);
      }),
    ).rejects.toBeInstanceOf(AttributionGuardError);
    expect(store.read().events).toHaveLength(0);
  });

  it('keeps existing attribution immutable on both stacks', async () => {
    const { store } = await openStore();
    await store.updateAs('user', (data) => {
      (data.nodes as unknown as Array<Record<string, unknown>>).push(note('n-1', 'me'));
      (data.thoughts as unknown as Array<Record<string, unknown>>).push(thought('t-1', 'me'));
      (data.events as unknown as Array<Record<string, unknown>>).push(event('e-1', 'user'));
      data.comments.push({
        id: 'cm-1',
        docId: 'n-1',
        author: 'me',
        body: '评论',
        quote: null,
        anchor: null,
        status: 'open',
        createdAt: FIXED_NOW().toISOString(),
        resolvedAt: null,
        editedAt: null,
        supplements: [],
      });
      data.versions.push({
        id: 'ver-1',
        docId: 'n-1',
        title: 'n-1',
        content: '',
        author: 'me',
        at: FIXED_NOW().toISOString(),
      });
    });
    // Even the matching identity cannot rewrite attribution afterwards.
    await expect(
      store.updateAs('user', (data) => {
        data.nodes[0]!.creator = 'alter';
      }),
    ).rejects.toBeInstanceOf(AttributionGuardError);
    await expect(
      store.updateAs('alter', (data) => {
        data.comments[0]!.author = 'alter';
      }),
    ).rejects.toBeInstanceOf(AttributionGuardError);
    await expect(
      store.updateAs('alter', (data) => {
        data.versions[0]!.author = 'alter';
      }),
    ).rejects.toBeInstanceOf(AttributionGuardError);
    await expect(
      store.updateAs('user', (data) => {
        (data.thoughts[0] as unknown as { creator: string }).creator = 'alter';
      }),
    ).rejects.toBeInstanceOf(AttributionGuardError);
    await expect(
      store.updateAs('alter', (data) => {
        (data.events[0] as unknown as { source: string }).source = 'agent';
      }),
    ).rejects.toBeInstanceOf(AttributionGuardError);
    expect(store.read().nodes[0]?.creator).toBe('me');
    expect(store.read().comments[0]?.author).toBe('me');
    expect(store.read().versions[0]?.author).toBe('me');
  });

  it('treats comment supplements as append-only with derived authors', async () => {
    const { store } = await openStore();
    await store.updateAs('user', (data) => {
      (data.nodes as unknown as Array<Record<string, unknown>>).push(note('n-1', 'me'));
      data.comments.push({
        id: 'cm-1',
        docId: 'n-1',
        author: 'me',
        body: '评论',
        quote: null,
        anchor: null,
        status: 'open',
        createdAt: FIXED_NOW().toISOString(),
        resolvedAt: null,
        editedAt: null,
        supplements: [
          { id: 'cs-1', author: 'me', body: '补充', createdAt: FIXED_NOW().toISOString() },
        ],
      });
    });
    // Alter may append under its own identity…
    await store.updateAs('alter', (data) => {
      data.comments[0]!.supplements.push({
        id: 'cs-2',
        author: 'alter',
        body: 'Agent 补充',
        createdAt: FIXED_NOW().toISOString(),
      });
    });
    // …but not rewrite, delete, or append under a foreign identity.
    await expect(
      store.updateAs('alter', (data) => {
        data.comments[0]!.supplements[0]!.body = '篡改';
      }),
    ).rejects.toBeInstanceOf(AttributionGuardError);
    await expect(
      store.updateAs('user', (data) => {
        data.comments[0]!.supplements.pop();
      }),
    ).rejects.toBeInstanceOf(AttributionGuardError);
    await expect(
      store.updateAs('user', (data) => {
        data.comments[0]!.supplements.push({
          id: 'cs-3',
          author: 'alter',
          body: '冒充',
          createdAt: FIXED_NOW().toISOString(),
        });
      }),
    ).rejects.toBeInstanceOf(AttributionGuardError);
    expect(store.read().comments[0]?.supplements.map((s) => s.author)).toEqual(['me', 'alter']);
  });

  it('restricts archivedBy transitions to null, the actor source, or system', async () => {
    const { store } = await openStore();
    await store.updateAs('user', (data) => {
      (data.nodes as unknown as Array<Record<string, unknown>>).push(note('n-1', 'me'));
    });
    await store.updateAs('user', (data) => {
      data.nodes[0]!.archivedBy = 'user';
    });
    await store.updateAs('alter', (data) => {
      data.nodes[0]!.archivedBy = 'agent';
    });
    await store.updateAs('alter', (data) => {
      data.nodes[0]!.archivedBy = 'system';
    });
    await store.updateAs('user', (data) => {
      data.nodes[0]!.archivedBy = null;
    });
    await expect(
      store.updateAs('user', (data) => {
        data.nodes[0]!.archivedBy = 'agent';
      }),
    ).rejects.toBeInstanceOf(AttributionGuardError);
    await expect(
      store.updateAs('alter', (data) => {
        data.nodes[0]!.archivedBy = 'user';
      }),
    ).rejects.toBeInstanceOf(AttributionGuardError);
    expect(store.read().nodes[0]?.archivedBy).toBeNull();
  });

  it('unscoped updates keep immutability but refuse new attributed entities', async () => {
    const { store } = await openStore();
    await store.updateAs('user', (data) => {
      (data.nodes as unknown as Array<Record<string, unknown>>).push(note('n-1', 'me'));
    });
    // Non-attribution writes stay allowed (here: a plain title edit).
    await store.update((data) => {
      data.nodes[0]!.title = '改标题';
    });
    await expect(
      store.update((data) => {
        (data.nodes as unknown as Array<Record<string, unknown>>).push(note('n-2', 'me'));
      }),
    ).rejects.toBeInstanceOf(AttributionGuardError);
    await expect(
      store.update((data) => {
        data.nodes[0]!.creator = 'alter';
      }),
    ).rejects.toBeInstanceOf(AttributionGuardError);
    expect(store.read().nodes).toHaveLength(1);
    expect(store.read().nodes[0]?.title).toBe('改标题');
  });

  it('rolls back sidecar writes when the guard rejects a document transaction', async () => {
    const { store } = await openStore();
    await expect(
      store.transactDocument((data, sidecar) => {
        (data.nodes as unknown as Array<Record<string, unknown>>).push(note('n-bad', 'alter'));
        sidecar.putObject({
          id: 'obj_bad',
          docId: 'n-bad',
          type: 'mindmap',
          schemaVersion: 1,
          payload: { root: { id: 'n1', text: 'root' } },
          createdAt: FIXED_NOW().toISOString(),
        });
      }, 'user'),
    ).rejects.toBeInstanceOf(AttributionGuardError);
    expect(store.read().nodes).toHaveLength(0);
    expect(store.getDocumentObject('obj_bad')).toBeUndefined();
  });
});

describe('historical attribution backfill', () => {
  it('loads pre-attribution thoughts as me and events as agent without a schema bump', async () => {
    const { store, dir } = await openStore();
    await store.updateAs('user', (data) => {
      (data.thoughts as unknown as Array<Record<string, unknown>>).push(thought('t-old', 'me'));
    });
    await store.updateAs('alter', (data) => {
      (data.events as unknown as Array<Record<string, unknown>>).push(event('e-old', 'agent'));
    });
    await store.close();

    // Simulate rows written before the fields existed.
    const file = join(dir, SPACE_DB_FILE);
    const db = new DatabaseSync(file);
    const strip = (table: string, id: string, field: string): void => {
      const row = db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data: string };
      const parsed = JSON.parse(row.data) as Record<string, unknown>;
      delete parsed[field];
      db.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`).run(JSON.stringify(parsed), id);
    };
    strip('thoughts', 't-old', 'creator');
    strip('events', 'e-old', 'source');
    db.close();

    const reopened = await openSpaceStore({ directory: dir, now: FIXED_NOW });
    expect(reopened.read().thoughts[0]?.creator).toBe('me');
    expect(reopened.read().events[0]?.source).toBe('agent');
    const probe = new DatabaseSync(file, { readOnly: true });
    const version = probe.prepare('PRAGMA user_version').get() as { user_version?: number };
    expect(Number(version.user_version)).toBe(3);
    probe.close();
    await reopened.close();
  });
});

describe('idle auto-archiving', () => {
  it('sweep archives as system on both identity stacks', async () => {
    let current = FIXED_NOW();
    const clock = () => current;
    const { store } = await openStore(clock);
    const stacks = createSpaceAuthority(store, clock);
    const doc = await stacks.user.createNode({
      spaceId: DEFAULT_SPACE_ID,
      kind: 'note',
      title: '沉底旧文',
    });
    // Activity decays 8 points/day; after 13 days the note is idle.
    current = new Date(FIXED_NOW().getTime() + 13 * 86_400_000);
    await stacks.alter.listNodes(DEFAULT_SPACE_ID);
    const swept = store.read().nodes.find((node) => node.id === doc.id);
    expect(swept?.archived).toBe(true);
    expect(swept?.archivedBy).toBe('system');

    // The user stack's sweep writes the same system source.
    const second = await stacks.user.createNode({
      spaceId: DEFAULT_SPACE_ID,
      kind: 'note',
      title: '另一篇',
    });
    current = new Date(current.getTime() + 13 * 86_400_000);
    await stacks.user.listNodes(DEFAULT_SPACE_ID);
    expect(
      store.read().nodes.find((node) => node.id === second.id)?.archivedBy,
    ).toBe('system');
  });
});