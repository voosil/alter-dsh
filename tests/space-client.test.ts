import { describe, expect, it } from 'vitest';
import {
  SPACE_RPC_CHANNEL,
  SPACE_RPC_ENDPOINT,
  createSpaceClient,
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
});
