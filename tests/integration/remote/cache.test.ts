/**
 * Disposable remote cache: corrupt-file recovery, outbox re-arming, cache key
 * cleanup and the content-addressed asset budget.
 */
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createRemoteBridge } from '../../../host/remote/bridge.js';
import {
  MAX_CACHED_ASSET_TOTAL_BYTES,
  cacheFileName,
  openRemoteCache,
} from '../../../host/remote/cache.js';
import type { AlterDoc } from '../../../host/document/editors/legacy/types.js';
import { tempDir } from '../../support/lifecycle.js';

const SERVER = 'http://127.0.0.1:59999';

function shadow(revision: number): {
  docId: string;
  revision: number;
  title: string;
  doc: AlterDoc;
} {
  return {
    docId: 'doc-1',
    revision,
    title: '缓存文档',
    doc: {
      format: 'alter-doc/1',
      schemaVersion: 1,
      revision,
      blocks: [],
    },
  };
}

function queueEntry(
  baseRevision: number,
  idempotencyKey: string,
): {
  docId: string;
  endpoint: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  baseRevision: number;
  now: number;
} {
  return {
    docId: 'doc-1',
    endpoint: 'doc.applyOps',
    payload: {
      docId: 'doc-1',
      baseRevision,
      idempotencyKey,
      ops: [{ op: 'insert_markdown', index: 0, markdown: idempotencyKey }],
    },
    idempotencyKey,
    baseRevision,
    now: 1_000,
  };
}

describe('remote cache durability and recovery', () => {
  it('quarantines an unreadable cache database instead of failing activation', async () => {
    const directory = await tempDir('space-cache-');
    const file = join(directory, cacheFileName(SERVER));
    await writeFile(file, 'this file is not a sqlite database');
    await writeFile(`${file}-wal`, 'garbage wal');

    const warnings: string[] = [];
    const bridge = createRemoteBridge({
      baseUrl: SERVER,
      token: 'token',
      directory,
      logger: { warn: (message) => warnings.push(message) },
    });
    try {
      const names = await readdir(directory);
      // The unreadable file is kept for inspection under a distinct name.
      expect(
        names.some((name) =>
          name.startsWith(`${cacheFileName(SERVER)}.corrupt-`),
        ),
      ).toBe(true);
      expect(warnings.some((message) => message.includes('不可读'))).toBe(true);

      // The recreated cache is usable: a corrupt disposable file must never
      // prevent the plugin from activating.
      const cache = openRemoteCache(directory, SERVER);
      try {
        cache.setJson('probe', { ok: true });
        expect(cache.getJson('probe')).toEqual({ ok: true });
        expect(cache.counts()).toEqual({ pending: 0, conflicts: 0, failed: 0 });
      } finally {
        cache.close();
      }
    } finally {
      await bridge.close();
    }
  });

  it('rewrites the stored payload base revision when re-arming conflicts', async () => {
    const directory = await tempDir();
    const cache = openRemoteCache(directory, SERVER);
    try {
      cache.putShadow(shadow(2));
      cache.enqueue(queueEntry(3, 'idem-a'));
      cache.enqueue(queueEntry(4, 'idem-b'));
      cache.markConflict('doc-1', '文档已在其他设备修改', 2_000);
      expect(cache.counts()).toEqual({ pending: 0, conflicts: 2, failed: 0 });

      const resolved = cache.requeue('doc-1', 9, 3_000);
      expect(resolved).toBe(2);
      expect(cache.counts()).toEqual({ pending: 2, conflicts: 0, failed: 0 });

      const pending = cache.pendingFor('doc-1');
      // Replay applies entries in order, so each is armed against the
      // revision the previous one produces.
      expect(pending.map((entry) => entry.baseRevision)).toEqual([9, 10]);
      for (const entry of pending) {
        const payload = JSON.parse(entry.payload) as { baseRevision: number };
        // The business payload carries the same value as the column; a payload
        // left stale made every replay conflict again.
        expect(payload.baseRevision).toBe(entry.baseRevision);
      }
      // A re-armed document must not keep its stale optimistic tree.
      expect(cache.getShadow('doc-1')).toBeUndefined();
    } finally {
      cache.close();
    }
  });

  it('commits a queued write together with its optimistic shadow', async () => {
    const directory = await tempDir();
    const cache = openRemoteCache(directory, SERVER);
    try {
      const seq = cache.enqueue(queueEntry(2, 'idem-tx'), shadow(3));
      expect(seq).toBeGreaterThan(0);
      expect(cache.counts()).toEqual({ pending: 1, conflicts: 0, failed: 0 });
      expect(cache.getShadow('doc-1')?.revision).toBe(3);
      expect(cache.nextPending()?.seq).toBe(seq);
    } finally {
      cache.close();
    }
  });

  it('clears every cached read of a discarded document', async () => {
    const directory = await tempDir();
    const cache = openRemoteCache(directory, SERVER);
    try {
      cache.setJson('doc.get\u0000["doc-1"]', { value: 1 });
      cache.setJson('doc.read\u0000["doc-1",{}]', { value: 2 });
      cache.setJson('doc.outline\u0000["doc-1"]', { value: 3 });
      cache.setJson('doc.get\u0000["doc-10"]', { value: 4 });

      expect(cache.deleteKeysContaining(JSON.stringify('doc-1'))).toBe(3);
      expect(cache.getJson('doc.get\u0000["doc-1"]')).toBeUndefined();
      expect(cache.getJson('doc.read\u0000["doc-1",{}]')).toBeUndefined();
      expect(cache.getJson('doc.outline\u0000["doc-1"]')).toBeUndefined();
      // A different document that merely shares a prefix is untouched.
      expect(cache.getJson('doc.get\u0000["doc-10"]')).toEqual({ value: 4 });
    } finally {
      cache.close();
    }
  });

  it('seeds the asset byte budget from disk so the cap survives a restart', async () => {
    const directory = await tempDir();
    const first = openRemoteCache(directory, SERVER);
    first.putAsset('asset_keep', 'image/png', new Uint8Array([1, 2, 3]));
    expect(first.getAsset('asset_keep')).toBeDefined();
    const file = first.file;
    first.close();

    // Pretend a previous run already filled almost the whole asset budget.
    const raw = new DatabaseSync(file);
    raw
      .prepare(
        'INSERT INTO asset (id, mime, bytes, data, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        'asset_huge',
        'image/png',
        MAX_CACHED_ASSET_TOTAL_BYTES - 10,
        new Uint8Array([0]),
        0,
      );
    raw.close();

    const reopened = openRemoteCache(directory, SERVER);
    try {
      // Without seeding the total from SUM(bytes), this small row would fit and
      // the eviction pass would never run against the restarted cache.
      reopened.putAsset('asset_new', 'image/png', new Uint8Array(64));
      expect(reopened.getAsset('asset_new')).toBeDefined();
      expect(reopened.getAsset('asset_huge')).toBeUndefined();
      // The recently used small asset is not evicted.
      expect(reopened.getAsset('asset_keep')).toBeDefined();
    } finally {
      reopened.close();
    }
  });
});