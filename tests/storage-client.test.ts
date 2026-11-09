import { describe, expect, it } from 'vitest';
import type { SpaceRpcCaller } from '../src/space-client.js';
import {
  SPACE_RPC_CHANNEL,
  SPACE_RPC_ENDPOINT,
} from '../src/space-client.js';
import { createSpaceStorageClient } from '../src/storage-client.js';

const estimate = {
  documentCount: 2,
  averageDocumentBytes: 1024,
  currentBytes: 4096,
  currentMainBytes: 4096,
  currentSnapshotBytes: 0,
  currentWalBytes: 0,
  projectedBytes: 8192,
  projectedMainBytes: 8192,
  projectedSnapshotBytes: 0,
  deltaBytes: 4096,
};

describe('createSpaceStorageClient', () => {
  it('maps storage operations onto the alter-space RPC channel', async () => {
    const calls: Array<{ channel: string; endpoint: string; payload: unknown }> = [];
    const rpc: SpaceRpcCaller = {
      async call(channel, endpoint, payload) {
        calls.push({ channel, endpoint, payload });
        const { op } = payload as { op: string };
        if (op === 'storage.get' || op === 'storage.set')
          return {
            ok: true,
            value: {
              value: {
                settings: { historyLimit: 10, snapshotKeep: 3 },
                estimate,
              },
            },
          };
        return { ok: true, value: { value: estimate } };
      },
    };
    const storage = createSpaceStorageClient(rpc);

    const state = await storage.get();
    expect(state.settings).toEqual({ historyLimit: 10, snapshotKeep: 3 });
    expect(state.estimate).toEqual(estimate);
    await storage.estimate({ historyLimit: 5 });
    await storage.set({ historyLimit: 5, snapshotKeep: 2 });

    expect(calls.map((call) => call.channel)).toEqual([
      SPACE_RPC_CHANNEL,
      SPACE_RPC_CHANNEL,
      SPACE_RPC_CHANNEL,
    ]);
    expect(calls.map((call) => call.endpoint)).toEqual([
      SPACE_RPC_ENDPOINT,
      SPACE_RPC_ENDPOINT,
      SPACE_RPC_ENDPOINT,
    ]);
    expect(calls.map((call) => (call.payload as { op: string }).op)).toEqual([
      'storage.get',
      'storage.estimate',
      'storage.set',
    ]);
    expect((calls[1]!.payload as { args: unknown[] }).args).toEqual([
      { historyLimit: 5 },
    ]);
  });

  it('unwraps Host error envelopes', async () => {
    const rpc: SpaceRpcCaller = {
      async call() {
        return {
          ok: true,
          value: {
            error: {
              code: 'space/invalid-input',
              message: 'historyLimit 必须是整数',
            },
          },
        };
      },
    };
    const storage = createSpaceStorageClient(rpc);
    await expect(storage.set({ historyLimit: 0 })).rejects.toMatchObject({
      code: 'space/invalid-input',
      message: 'historyLimit 必须是整数',
    });
  });
});
