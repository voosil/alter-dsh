/**
 * Write-identity attribution matrix: both authority stacks derive every
 * attribution field from their bound actor; Agent writes force versions;
 * the RPC boundary selects stacks and never trusts request-body identities.
 */
import { describe, expect, it } from 'vitest';
import { createSpaceAuthority } from '../../../host/authority/compose.js';
import { createDocumentService } from '../../../host/document/editors/legacy/service.js';
import { createStructuredSpaceService } from '../../../host/document/editors/legacy/notes.js';
import { createSpaceRpc } from '../../../host/authority/rpc.js';
import { createSpaceStorage } from '../../../host/persistence/storage.js';
import { openSpaceStore } from '../../../host/persistence/store.js';
import { FIXED_NOW, dispose, tempDir } from '../../support/lifecycle.js';
import { startAuthority } from '../../support/harness.js';

const signal = new AbortController().signal;

function valueOf(result: unknown): unknown {
  return (result as { value?: unknown }).value;
}

describe('attribution matrix across identity stacks', () => {
  it.each([
    { actor: 'user', creator: 'me', archivedBy: 'user' },
    { actor: 'alter', creator: 'alter', archivedBy: 'agent' },
  ] as const)('$actor stack derives creator/author/archivedBy', async ({ actor, creator, archivedBy }) => {
    const authority = await startAuthority();
    const service = actor === 'user' ? authority.service : authority.agentService;
    const space = await service.createSpace({ name: `矩阵-${actor}` });

    const folder = await service.createNode({ spaceId: space.id, kind: 'folder' });
    expect(folder.creator).toBe(creator);

    const note = await service.createNode({ spaceId: space.id, kind: 'note', title: '文档' });
    expect(note.creator).toBe(creator);
    const versions = await service.listVersions(note.id);
    expect(versions[0]?.author).toBe(creator);

    const thought = await service.createThought({ spaceId: space.id, content: '随想' });
    expect(thought.creator).toBe(creator);

    const comment = await service.addComment({ docId: note.id, body: '评论' });
    expect(comment.author).toBe(creator);
    const supplemented = await service.addCommentSupplement(comment.id, '补充');
    expect(supplemented.supplements[0]?.author).toBe(creator);

    const archived = await service.setArchived(note.id, true);
    expect(archived.archivedBy).toBe(archivedBy);
    const unarchived = await service.setArchived(note.id, false);
    expect(unarchived.archivedBy).toBeNull();

    // The vendor content path (saveNode) derives version authors too.
    const raw = createSpaceAuthority(authority.store, FIXED_NOW)[actor];
    const legacy = await raw.createNode({ spaceId: space.id, kind: 'note', title: '旧路径' });
    await raw.saveNode(legacy.id, { content: 'v1' });
    expect((await raw.listVersions(legacy.id))[0]?.author).toBe(creator);
  });

  it('convertThought attributes the NEW node to the converting identity, not the thought creator', async () => {
    const authority = await startAuthority();
    const space = await authority.service.createSpace({ name: '转换' });
    const thought = await authority.service.createThought({ spaceId: space.id, content: '用户随想' });
    expect(thought.creator).toBe('me');
    const converted = await authority.agentService.convertThought(thought.id);
    expect(converted.node.creator).toBe('alter');
    expect(converted.thought.creator).toBe('me');
    // The thought's own attribution never moves.
    const reread = await authority.service.listThoughts(space.id, { includeArchived: true });
    expect(reread.find((item) => item.id === thought.id)).toBeUndefined();
  });

  it('restoreNode keeps the original creator across identities', async () => {
    const authority = await startAuthority();
    const space = await authority.service.createSpace({ name: '恢复' });
    const note = await authority.service.createNode({ spaceId: space.id, kind: 'note' });
    await authority.service.deleteNode(note.id);
    const restored = await authority.agentService.restoreNode(note.id);
    expect(restored.creator).toBe('me');
  });

  it('event source and task owner derive from the scoped write identity', async () => {
    const authority = await startAuthority();
    const space = await authority.service.createSpace({ name: '事件' });
    await authority.store.updateAs('alter', (data) => {
      data.events.push({
        id: 'ev-alter',
        spaceId: space.id,
        title: 'Alter 整理了文档',
        detail: '',
        at: FIXED_NOW().toISOString(),
        docId: null,
        taskId: null,
        source: 'agent',
      });
      data.tasks.push({
        id: 'task-alter',
        spaceId: space.id,
        title: '任务',
        detail: '',
        status: 'pending',
        owner: 'alter',
        docId: null,
        createdAt: FIXED_NOW().toISOString(),
      });
    });
    const overview = await authority.service.getOverview(space.id);
    expect(overview.agentEvents[0]?.source).toBe('agent');
    expect(overview.tasks[0]?.owner).toBe('alter');
  });
});

describe('forced versions for Agent writes', () => {
  it('alter writes inside the throttle window still record a version; user writes stay throttled', async () => {
    const dir = await tempDir('space-forced-version-');
    const store = await openSpaceStore({ directory: dir, now: FIXED_NOW });
    dispose(() => store.close());
    const user = createDocumentService({ store, now: FIXED_NOW, actor: 'user' });
    const alter = createDocumentService({ store, now: FIXED_NOW, actor: 'alter' });

    const userDoc = await user.generate({ spaceId: 'sp-inbox', markdown: '原文' });
    const alterDoc = await alter.generate({ spaceId: 'sp-inbox', markdown: '原文' });
    const blockOf = async (service: typeof user, docId: string) =>
      (await service.get(docId)).doc.blocks[0]!.id;

    // Two consecutive writes at the SAME instant (inside the 5-minute window).
    for (const [service, docId] of [[user, userDoc.docId], [alter, alterDoc.docId]] as const) {
      const blockId = await blockOf(service, docId);
      await service.applyOperations({
        docId,
        baseRevision: 1,
        ops: [{ op: 'update_text', target: blockId, edits: [{ oldText: '原文', newText: '一改' }] }],
      });
      await service.applyOperations({
        docId,
        baseRevision: 2,
        ops: [{ op: 'update_text', target: blockId, edits: [{ oldText: '一改', newText: '二改' }] }],
      });
    }

    const userVersions = store.read().versions.filter((v) => v.docId === userDoc.docId);
    const alterVersions = store.read().versions.filter((v) => v.docId === alterDoc.docId);
    // generate + first edit are throttled into one user version; the second
    // user edit adds none. Alter forces one version per write.
    expect(userVersions).toHaveLength(1);
    expect(userVersions.every((version) => version.author === 'me')).toBe(true);
    expect(alterVersions).toHaveLength(3);
    expect(alterVersions.every((version) => version.author === 'alter')).toBe(true);
  });

  it('forced versions stay subject to the history limit', async () => {
    const dir = await tempDir('space-forced-trim-');
    const store = await openSpaceStore({ directory: dir, now: FIXED_NOW });
    dispose(() => store.close());
    await store.setStorageSettings({ historyLimit: 2, snapshotKeep: 3 });
    const alter = createDocumentService({ store, now: FIXED_NOW, actor: 'alter' });
    const created = await alter.generate({ spaceId: 'sp-inbox', markdown: '原文' });
    let revision = 1;
    for (const text of ['一改', '二改', '三改']) {
      const blockId = (await alter.get(created.docId)).doc.blocks[0]!.id;
      const previous = text === '一改' ? '原文' : text === '二改' ? '一改' : '二改';
      await alter.applyOperations({
        docId: created.docId,
        baseRevision: revision,
        ops: [{ op: 'update_text', target: blockId, edits: [{ oldText: previous, newText: text }] }],
      });
      revision += 1;
    }
    const versions = store.read().versions.filter((v) => v.docId === created.docId);
    expect(versions).toHaveLength(2);
    expect(versions.every((version) => version.author === 'alter')).toBe(true);
  });
});

describe('RPC stack selection', () => {
  async function rpcHarness(actorPolicy?: 'browser' | 'passthrough') {
    const dir = await tempDir('space-rpc-attribution-');
    const store = await openSpaceStore({ directory: dir, now: FIXED_NOW });
    dispose(() => store.close());
    const stacks = createSpaceAuthority(store, FIXED_NOW);
    const document = createDocumentService({ store, now: FIXED_NOW, actor: 'user' });
    const agentDocument = createDocumentService({ store, now: FIXED_NOW, actor: 'alter' });
    const handler = createSpaceRpc({
      service: createStructuredSpaceService(stacks.user, document),
      agentService: createStructuredSpaceService(stacks.alter, agentDocument),
      storage: createSpaceStorage({ store, directory: dir }),
      document,
      agentDocument,
      ...(actorPolicy === undefined ? {} : { actorPolicy }),
    });
    return { store, handler };
  }

  it('browser policy ignores forged actors on both structure and document writes', async () => {
    const { store, handler } = await rpcHarness();
    const node = valueOf(
      await handler(
        'space.createNode',
        { op: 'space.createNode', actor: 'alter', args: [{ spaceId: 'sp-inbox', kind: 'folder', actor: 'alter' }] },
        signal,
        {},
      ),
    ) as { id: string; creator: string };
    expect(node.creator).toBe('me');

    const generated = valueOf(
      await handler('doc.generate', { args: [{ spaceId: 'sp-inbox', markdown: '原文', actor: 'alter' }] }, signal, {}),
    ) as { docId: string };
    const snapshot = valueOf(
      await handler('doc.get', { args: [generated.docId] }, signal, {}),
    ) as { revision: number; doc: { blocks: Array<{ id: string }> } };
    await handler(
      'doc.applyOps',
      {
        actor: 'alter',
        args: [{
          docId: generated.docId,
          baseRevision: snapshot.revision,
          ops: [{ op: 'update_text', target: snapshot.doc.blocks[0]!.id, edits: [{ oldText: '原文', newText: '改过' }] }],
          actor: 'alter',
        }],
      },
      signal,
      {},
    );
    const versions = store.read().versions.filter((v) => v.docId === generated.docId);
    expect(versions.every((version) => version.author === 'me')).toBe(true);
    expect(store.read().nodes.find((n) => n.id === generated.docId)?.creator).toBe('me');
  });

  it('passthrough selects the alter stack from the bridge stamp and strips the actor', async () => {
    const { store, handler } = await rpcHarness('passthrough');
    const node = valueOf(
      await handler(
        'space.createNode',
        { op: 'space.createNode', actor: 'alter', args: [{ spaceId: 'sp-inbox', kind: 'folder' }] },
        signal,
        {},
      ),
    ) as { creator: string };
    expect(node.creator).toBe('alter');

    // No stamp → user stack.
    const plain = valueOf(
      await handler(
        'space.createNode',
        { args: [{ spaceId: 'sp-inbox', kind: 'folder' }] },
        signal,
        {},
      ),
    ) as { creator: string };
    expect(plain.creator).toBe('me');

    // Document writes carry the stamp inline (queue-replay shape).
    const generated = valueOf(
      await handler('doc.generate', { actor: 'alter', args: [{ spaceId: 'sp-inbox', markdown: '原文' }] }, signal, {}),
    ) as { docId: string };
    expect(store.read().nodes.find((n) => n.id === generated.docId)?.creator).toBe('alter');
    const snapshot = valueOf(
      await handler('doc.get', { args: [generated.docId] }, signal, {}),
    ) as { revision: number; doc: { blocks: Array<{ id: string }> } };
    await handler(
      'doc.applyOps',
      {
        args: [{
          docId: generated.docId,
          baseRevision: snapshot.revision,
          ops: [{ op: 'update_text', target: snapshot.doc.blocks[0]!.id, edits: [{ oldText: '原文', newText: '改过' }] }],
          actor: 'alter',
        }],
      },
      signal,
      {},
    );
    const versions = store.read().versions.filter((v) => v.docId === generated.docId);
    expect(versions.every((version) => version.author === 'alter')).toBe(true);
  });

  it('passthrough doc.updateObject attributes the version and object provenance to alter', async () => {
    const { store, handler } = await rpcHarness('passthrough');
    const generated = valueOf(
      await handler(
        'doc.generate',
        { actor: 'alter', args: [{ spaceId: 'sp-inbox', markdown: ':::mindmap{objectId="obj_seed"}\n:::\n' }] },
        signal,
        {},
      ),
    ) as { docId: string; revision: number };
    const snapshot = valueOf(
      await handler('doc.get', { args: [generated.docId] }, signal, {}),
    ) as { doc: { blocks: Array<{ id: string; type: string }> } };
    const block = snapshot.doc.blocks.find((entry) => entry.type === 'mindmap')!;
    const updated = valueOf(
      await handler(
        'doc.updateObject',
        {
          args: [{
            docId: generated.docId,
            blockId: block.id,
            baseRevision: generated.revision,
            payload: { root: { id: 'n1', text: '目标' } },
            actor: 'alter',
          }],
        },
        signal,
        {},
      ),
    ) as { objectId: string };
    const record = store.getDocumentObject(updated.objectId);
    expect(record?.provenance?.generatedBy).toBe('alter');
    const versions = store.read().versions.filter((v) => v.docId === generated.docId);
    expect(versions.every((version) => version.author === 'alter')).toBe(true);
  });
});