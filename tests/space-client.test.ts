import { describe, expect, it } from 'vitest';
import {
  SPACE_RPC_CHANNEL,
  SPACE_RPC_ENDPOINT,
  createSpaceClient,
  createSpaceDocumentClient,
  type SpaceRpcCaller,
} from '../src/space-client.js';

describe('createSpaceClient', () => {
  it('targets the Host alter-space RPC channel', async () => {
    const calls: Array<{ channel: string; endpoint: string }> = [];
    const rpc: SpaceRpcCaller = {
      async call(channel, endpoint) {
        calls.push({ channel, endpoint });
        return { ok: true, value: { value: null } };
      },
    };
    const service = createSpaceClient(rpc);
    await service.listSpaces();
    expect(calls).toEqual([
      { channel: SPACE_RPC_CHANNEL, endpoint: SPACE_RPC_ENDPOINT },
    ]);
  });

  it('serializes calls so a save resolves before the refresh reads', async () => {
    const events: string[] = [];
    let releaseSave: (() => void) | undefined;
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const rpc: SpaceRpcCaller = {
      async call(_channel, _endpoint, payload) {
        const { op } = payload as { op: string };
        events.push(`start:${op}`);
        if (op === 'space.saveNode') {
          notifyStarted?.();
          await saveGate;
          events.push('finish:space.saveNode');
        }
        return { ok: true, value: { value: null } };
      },
    };
    const service = createSpaceClient(rpc);
    const save = service.saveNode('node-1', { content: 'x' });
    const read = service.listNodes('sp-1');
    await started;
    expect(events).toEqual(['start:space.saveNode']);
    releaseSave?.();
    await Promise.all([save, read]);
    expect(events).toEqual([
      'start:space.saveNode',
      'finish:space.saveNode',
      'start:space.listNodes',
    ]);
  });

  it('maps arguments, trims trailing undefined and unwraps errors', async () => {
    const calls: Array<{ endpoint: string; args: unknown[] }> = [];
    const rpc: SpaceRpcCaller = {
      async call(_channel, _endpoint, payload) {
        const { op, args } = payload as { op: string; args: unknown[] };
        calls.push({ endpoint: op, args });
        if (op === 'space.getSpace')
          return { ok: true, value: { value: null } };
        if (op === 'space.saveNode')
          return { ok: false, error: { code: 'space/failed', message: '保存失败' } };
        return { ok: true, value: { value: null } };
      },
    };
    const service = createSpaceClient(rpc);
    await expect(service.getSpace('sp-1')).resolves.toBeUndefined();
    expect(calls[1 - 1]).toEqual({ endpoint: 'space.getSpace', args: ['sp-1'] });
    await service.listThoughts('sp-1', undefined);
    expect(calls[1]).toEqual({ endpoint: 'space.listThoughts', args: ['sp-1'] });
    await expect(service.saveNode('node-1', { content: 'x' })).rejects.toMatchObject({
      code: 'space/failed',
      message: '保存失败',
    });
    await expect(service.listDirectories(undefined)).resolves.toBeUndefined();
    expect(calls.at(-1)).toEqual({
      endpoint: 'space.listDirectories',
      args: ['~'],
    });
  });

  it('forwards comment anchors through the space RPC endpoints', async () => {
    const calls: Array<{ op: string; args: unknown[] }> = [];
    const rpc: SpaceRpcCaller = {
      async call(_channel, _endpoint, payload) {
        const { op, args } = payload as { op: string; args: unknown[] };
        calls.push({ op, args });
        return { ok: true, value: { value: null } };
      },
    };
    const service = createSpaceClient(rpc);
    const anchor = { blockId: 'blk_p', offset: 2, length: 4 };
    await service.addComment({
      docId: 'doc-1',
      body: '定位评论',
      quote: '选中文字',
      anchor,
    });
    await service.updateComment('cm-1', { anchor });
    expect(calls).toEqual([
      {
        op: 'space.addComment',
        args: [
          {
            docId: 'doc-1',
            body: '定位评论',
            quote: '选中文字',
            anchor,
          },
        ],
      },
      { op: 'space.updateComment', args: ['cm-1', { anchor }] },
    ]);
  });
});

describe('createSpaceDocumentClient', () => {
  it('maps document and object reads to the Host doc/object endpoints', async () => {
    const calls: Array<{ op: string; args: unknown[] }> = [];
    const rpc: SpaceRpcCaller = {
      async call(_channel, _endpoint, payload) {
        const { op, args } = payload as { op: string; args: unknown[] };
        calls.push({ op, args });
        return { ok: true, value: { value: { ok: true } } };
      },
    };
    const document = createSpaceDocumentClient(rpc);
    await document.get('doc-1');
    await document.outline('doc-1');
    await document.read('doc-1', { maxChars: 2000 });
    await document.search({ query: 'x', docId: 'doc-1' });
    await document.applyOperations({
      docId: 'doc-1',
      baseRevision: 1,
      ops: [],
    });
    await document.undo({ docId: 'doc-1', baseRevision: 2 });
    await document.restoreVersion({
      docId: 'doc-1',
      versionId: 'ver_1',
      baseRevision: 3,
    });
    await document.generate({ spaceId: 'sp-1', markdown: '# x' });
    await document.importAsset({ mime: 'image/png', dataBase64: 'AA==' });
    await document.getObject('obj_1');
    expect(calls.map((call) => call.op)).toEqual([
      'doc.get',
      'doc.outline',
      'doc.read',
      'doc.search',
      'doc.applyOps',
      'doc.undo',
      'doc.restoreVersion',
      'doc.generate',
      'doc.importAsset',
      'object.get',
    ]);
    expect(calls[2]?.args).toEqual(['doc-1', { maxChars: 2000 }]);
    expect(calls[8]?.args).toEqual([
      { mime: 'image/png', dataBase64: 'AA==' },
    ]);
  });

  it('maps asset uploads to doc.importAsset and unwraps remote failures', async () => {
    const calls: Array<{ op: string; args: unknown[] }> = [];
    const rpc: SpaceRpcCaller = {
      async call(_channel, _endpoint, payload) {
        const { op, args } = payload as { op: string; args: unknown[] };
        calls.push({ op, args });
        const input = args[0] as { dataBase64?: string };
        if (input.dataBase64 === 'bad')
          return {
            ok: true,
            value: {
              error: { code: 'object/invalid', message: '资产内容不是合法的 base64' },
            },
          };
        return {
          ok: true,
          value: {
            value: {
              assetId: 'asset_1',
              mime: 'image/png',
              bytes: 3,
              width: 1,
              height: 2,
            },
          },
        };
      },
    };
    const document = createSpaceDocumentClient(rpc);
    await expect(
      document.importAsset({
        mime: 'image/png',
        dataBase64: 'AAAA',
        name: 'a.png',
      }),
    ).resolves.toEqual({
      assetId: 'asset_1',
      mime: 'image/png',
      bytes: 3,
      width: 1,
      height: 2,
    });
    expect(calls).toEqual([
      {
        op: 'doc.importAsset',
        args: [{ mime: 'image/png', dataBase64: 'AAAA', name: 'a.png' }],
      },
    ]);
    await expect(
      document.importAsset({ mime: 'image/png', dataBase64: 'bad' }),
    ).rejects.toMatchObject({
      code: 'object/invalid',
      message: '资产内容不是合法的 base64',
    });
  });

  it('does not expose the removed legacy migration endpoint', async () => {
    const calls: string[] = [];
    const rpc: SpaceRpcCaller = {
      async call(_channel, _endpoint, payload) {
        const { op } = payload as { op: string };
        calls.push(op);
        return { ok: true, value: { value: null } };
      },
    };
    const document = createSpaceDocumentClient(rpc);
    expect('migrate' in document).toBe(false);
    await document.get('doc-1');
    expect(calls).toEqual(['doc.get']);
  });
});
