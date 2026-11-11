import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSpaceAuthority } from '../../host/authority/compose.js';
import { serializeAlterDoc, type AlterDoc } from '../../host/document/editors/legacy/types.js';
import { DEFAULT_SPACE_ID, openSpaceStore } from '../../host/persistence/store.js';

const dirs: string[] = [];
const fixedNow = () => new Date('2026-11-09T00:00:00.000Z');

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function node(
  id: string,
  title: string,
  content: string,
): Record<string, unknown> {
  return {
    id,
    spaceId: DEFAULT_SPACE_ID,
    kind: 'note',
    title,
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
    content,
    activity: 100,
    activityAt: fixedNow().toISOString(),
    lastOpenCreditAt: null,
    lastEditCreditAt: null,
    createdAt: fixedNow().toISOString(),
    updatedAt: fixedNow().toISOString(),
    order: 0,
  };
}

function astContent(text: string): string {
  const doc: AlterDoc = {
    format: 'alter-doc/1',
    schemaVersion: 1,
    revision: 1,
    blocks: [
      {
        id: 'blk_1',
        type: 'paragraph',
        attrs: {},
        content: [{ type: 'text', text }],
      },
    ],
  };
  return serializeAlterDoc(doc);
}

describe('AST content text extraction', () => {
  it('searches AST documents by plain text instead of raw JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'alter-space-text-'));
    dirs.push(dir);
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    await store.update((data) => {
      (data.nodes as unknown as Array<Record<string, unknown>>).push(
        node('doc-ast', '结构化文档', astContent('token 刷新策略')),
        node('doc-plain', '非结构化内容', '<p>token 纯文本内容</p>'),
      );
    });
    const service = createSpaceAuthority(store, fixedNow);
    const results = await service.search(DEFAULT_SPACE_ID, 'token');
    const astHit = results.find((result) => result.id === 'doc-ast');
    expect(astHit).toBeDefined();
    expect(astHit?.excerpt).toContain('token');
    expect(astHit?.excerpt).not.toContain('"format"');
    expect(astHit?.excerpt).not.toContain('blk_');
    // Non-AST bodies yield no searchable text (no HTML stripping fallback).
    expect(results.find((result) => result.id === 'doc-plain')).toBeUndefined();
    await store.close();
  });

  it('treats AST blocks as body content when building the activity feed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'alter-space-text-'));
    dirs.push(dir);
    const store = await openSpaceStore({ directory: dir, now: fixedNow });
    await store.update((data) => {
      (data.nodes as unknown as Array<Record<string, unknown>>).push(
        node('doc-ast', '', astContent('正文内容')),
      );
    });
    const service = createSpaceAuthority(store, fixedNow);
    const overview = await service.getOverview(DEFAULT_SPACE_ID);
    const titles = overview.activity.flatMap((day) =>
      day.events.map((event) => event.title),
    );
    expect(titles.some((title) => title.includes('未命名文档'))).toBe(true);
    await store.close();
  });
});
