/**
 * Bridge identity regression: every crossing payload is stamped with its
 * origin, the Agent Space/document ports stay `alter` end-to-end, browser
 * bodies cannot impersonate the Agent, and offline structure writes fail
 * explicitly instead of queueing.
 */
import { describe, expect, it } from 'vitest';
import { createRemoteBridge, type RemoteBridge } from '../../../host/remote/bridge.js';
import { RemoteSpaceClient } from '../../../host/remote/client.js';
import { startSpaceServer, type RunningSpaceServer } from '../../../server/core/index.js';
import { dispose, tempDir } from '../../support/lifecycle.js';

const TOKEN = '0123456789abcdef0123456789abcdef';

function quiet(): { info: (message: string) => void; warn: (message: string) => void } {
  return { info: () => undefined, warn: () => undefined };
}

function envelopeReply(rpcId: string, value: unknown): Response {
  return new Response(
    JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }),
    { headers: { 'content-type': 'application/json' } },
  );
}

function versionResponse(): Response {
  return new Response(
    JSON.stringify({
      product: '@alter-dsh/space',
      version: '0.0.0-test',
      protocolVersion: 1,
      databaseSchemaVersion: 3,
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}

const TEST_DOC = {
  format: 'alter-doc/1',
  schemaVersion: 1,
  revision: 1,
  blocks: [
    { id: 'blk_p', type: 'paragraph', attrs: {}, content: [{ type: 'text', text: '原文' }] },
  ],
};

interface Captured {
  op: string;
  envelopeActor: unknown;
  inlineActor: unknown;
}

/** One stub fetch that records the stamp on every crossing payload. */
function capturingFetch(captured: Captured[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith('/version')) return versionResponse();
    const envelope = JSON.parse(String(init?.body ?? '{}')) as {
      rpcId: string;
      payload?: { op?: string; args?: unknown[]; actor?: unknown };
    };
    const op = envelope.payload?.op ?? '';
    if (op === 'doc.get')
      return envelopeReply(envelope.rpcId, {
        value: { docId: 'doc-1', revision: 1, title: 'T', doc: TEST_DOC },
      });
    const first = envelope.payload?.args?.[0];
    captured.push({
      op,
      envelopeActor: envelope.payload?.actor,
      inlineActor:
        typeof first === 'object' && first !== null
          ? (first as { actor?: unknown }).actor
          : undefined,
    });
    if (op === 'space.listSpaces') return envelopeReply(envelope.rpcId, { value: [] });
    return envelopeReply(envelope.rpcId, {
      value: {
        docId: 'doc-1',
        revision: 2,
        changedBlockIds: [],
        diff: { added: [], updated: [], removed: [] },
        warnings: [],
        assetId: 'asset_1',
        mime: 'image/png',
        bytes: 3,
        id: 'doc-1',
        creator: 'alter',
      },
    });
  }) as typeof fetch;
}

describe('bridge stamp audit', () => {
  it('stamps every browser write with user, overwriting forged actors', async () => {
    const captured: Captured[] = [];
    const dir = await tempDir('space-stamp-user-');
    const bridge = createRemoteBridge({
      baseUrl: 'http://stub.invalid:8787',
      token: TOKEN,
      directory: dir,
      fetchImpl: capturingFetch(captured),
      logger: quiet(),
    });
    dispose(() => bridge.close());

    const call = (op: string, args: unknown[], forged?: unknown) =>
      bridge.rpc(op, {
        op,
        args,
        ...(forged === undefined ? {} : { actor: forged }),
      });

    // Structure writes: envelope stamp, positional or object args untouched.
    await call('space.createSpace', [{ name: '空间' }], 'alter');
    await call('space.createNode', [{ spaceId: 'sp-1', kind: 'folder', actor: 'alter' }], 'alter');
    await call('space.setArchived', ['doc-1', true], 'alter');
    await call('space.addComment', [{ docId: 'doc-1', body: '评论' }], 'alter');
    await call('space.convertThought', ['th-1'], 'alter');
    await call('space.emptyTrash', ['sp-1'], 'alter');
    // Hub and storage writes.
    await call('hub.setPolicy', ['sp-1', 'judge'], 'alter');
    await call('storage.set', [{ historyLimit: 10 }], 'alter');
    // Document writes: envelope AND inline stamp (queue replay carries inline).
    await call('doc.applyOps', [{ docId: 'doc-1', baseRevision: 1, ops: [], actor: 'alter' }], 'alter');
    await call('doc.generate', [{ spaceId: 'sp-1', markdown: '新', actor: 'alter' }], 'alter');
    await call('doc.undo', [{ docId: 'doc-1', baseRevision: 1, actor: 'alter' }], 'alter');
    await call('doc.restoreVersion', [{ docId: 'doc-1', versionId: 'ver-1', baseRevision: 1, actor: 'alter' }], 'alter');
    await call('doc.updateObject', [{ docId: 'doc-1', blockId: 'blk_p', baseRevision: 1, payload: {}, actor: 'alter' }], 'alter');
    await call('doc.importAsset', [{ mime: 'image/png', dataBase64: 'AQID' }], 'alter');
    // Reads are stamped too: a forged envelope actor cannot select a stack.
    await call('space.listSpaces', [], 'alter');

    expect(captured.length).toBe(15);
    for (const entry of captured) {
      expect(entry.envelopeActor, entry.op).toBe('user');
    }
    const inline = captured.filter((entry) => entry.inlineActor !== undefined);
    expect(inline.map((entry) => entry.op)).toEqual([
      'doc.applyOps',
      'doc.generate',
      'doc.undo',
      'doc.restoreVersion',
      'doc.updateObject',
    ]);
    for (const entry of inline) expect(entry.inlineActor, entry.op).toBe('user');
  });

  it('keeps Agent space and document ports stamped alter', async () => {
    const captured: Captured[] = [];
    const dir = await tempDir('space-stamp-alter-');
    const agentBridge = createRemoteBridge({
      baseUrl: 'http://stub.invalid:8787',
      token: TOKEN,
      directory: dir,
      fetchImpl: capturingFetch(captured),
      logger: quiet(),
    });
    dispose(() => agentBridge.close());

    await agentBridge.space.createNode({ spaceId: 'sp-1', kind: 'folder' });
    await agentBridge.space.setArchived('doc-1', true);
    await agentBridge.space.listSpaces();
    await agentBridge.document.applyOperations({ docId: 'doc-1', baseRevision: 1, ops: [] });
    await agentBridge.document.generate({ spaceId: 'sp-1', markdown: '新' });
    await agentBridge.document.updateObject({
      docId: 'doc-1',
      blockId: 'blk_p',
      baseRevision: 1,
      payload: {},
    });
    await agentBridge.assets.import({ data: new Uint8Array([1, 2, 3]), mime: 'image/png' });

    expect(captured.map((entry) => entry.op)).toEqual([
      'space.createNode',
      'space.setArchived',
      'space.listSpaces',
      'doc.applyOps',
      'doc.generate',
      'doc.updateObject',
      'doc.importAsset',
    ]);
    for (const entry of captured) expect(entry.envelopeActor, entry.op).toBe('alter');
    const inline = captured.filter((entry) => entry.inlineActor !== undefined);
    expect(inline.map((entry) => entry.op)).toEqual([
      'doc.applyOps',
      'doc.generate',
      'doc.updateObject',
    ]);
    for (const entry of inline) expect(entry.inlineActor, entry.op).toBe('alter');
  });
});

describe('bridge attribution end-to-end', () => {
  async function startHarness(): Promise<{
    server: RunningSpaceServer;
    bridge: RemoteBridge;
    observer: RemoteSpaceClient;
  }> {
    const dataDir = await tempDir('space-bridge-e2e-');
    const localDir = await tempDir('space-bridge-e2e-local-');
    const server = await startSpaceServer(
      {
        dataDir,
        host: '127.0.0.1',
        port: 0,
        tokens: [{ label: 'test', token: TOKEN }],
        snapshots: false,
      },
      quiet(),
    );
    const bridge = createRemoteBridge({
      baseUrl: server.url,
      token: TOKEN,
      directory: localDir,
      logger: quiet(),
    });
    const observer = new RemoteSpaceClient({ baseUrl: server.url, token: TOKEN });
    dispose(async () => {
      await bridge.close();
      await server.close();
    });
    await bridge.refresh();
    return { server, bridge, observer };
  }

  it('attributes Agent port writes to alter and browser writes to me on the server', async () => {
    const { bridge, observer } = await startHarness();
    const space = (await bridge.space.listSpaces())[0]!;

    const agentNode = await bridge.space.createNode({ spaceId: space.id, kind: 'folder' });
    expect(agentNode.creator).toBe('alter');
    const browserNode = (await bridge.rpc('space.createNode', {
      op: 'space.createNode',
      args: [{ spaceId: space.id, kind: 'folder' }],
    })) as { value: { creator: string } };
    expect(browserNode.value.creator).toBe('me');

    const agentDoc = await bridge.document.generate({ spaceId: space.id, markdown: 'Agent 正文' });
    const agentVersions = await observer.call<Array<{ author: string }>>('space.listVersions', [agentDoc.docId]);
    expect(agentVersions.every((version) => version.author === 'alter')).toBe(true);

    const browserDoc = (await bridge.rpc('doc.generate', {
      op: 'doc.generate',
      args: [{ spaceId: space.id, markdown: '浏览器正文' }],
    })) as { value: { docId: string } };
    const browserVersions = await observer.call<Array<{ author: string }>>('space.listVersions', [browserDoc.value.docId]);
    expect(browserVersions.every((version) => version.author === 'me')).toBe(true);

    // doc.updateObject through the Agent port keeps alter provenance.
    const mindmap = await bridge.document.generate({
      spaceId: space.id,
      markdown: ':::mindmap{objectId="obj_seed"}\n:::\n',
    });
    const snapshot = await bridge.document.read(mindmap.docId);
    const blockId = snapshot.blocks.find((block) => block.type === 'mindmap')!.id;
    const updated = await bridge.document.updateObject({
      docId: mindmap.docId,
      blockId,
      baseRevision: mindmap.revision,
      payload: { root: { id: 'n1', text: '目标' } },
    });
    const record = await observer.call<{ provenance?: { generatedBy?: string } }>('object.get', [updated.objectId]);
    expect(record.provenance?.generatedBy).toBe('alter');
  });

  it('browser bodies cannot impersonate the Agent through the bridge', async () => {
    const { bridge, observer } = await startHarness();
    const space = (await bridge.space.listSpaces())[0]!;
    const forged = (await bridge.rpc('space.createNode', {
      op: 'space.createNode',
      actor: 'alter',
      args: [{ spaceId: space.id, kind: 'folder', actor: 'alter' }],
    })) as { value: { id: string; creator: string } };
    expect(forged.value.creator).toBe('me');
    const reread = await observer.call<{ creator: string }>('space.getNode', [forged.value.id]);
    expect(reread.creator).toBe('me');
  });

  it('offline structure writes fail explicitly while cached reads keep working', async () => {
    const { server, bridge } = await startHarness();
    const space = (await bridge.space.listSpaces())[0]!;
    await server.close();
    await expect(
      bridge.space.createNode({ spaceId: space.id, kind: 'folder' }),
    ).rejects.toMatchObject({ code: 'remote/unavailable' });
    // The read was cached while online; offline it is served from the cache.
    const cached = await bridge.space.listSpaces();
    expect(cached.map((item) => item.id)).toContain(space.id);
    expect(bridge.status.pendingWrites).toBe(0);
  });
});