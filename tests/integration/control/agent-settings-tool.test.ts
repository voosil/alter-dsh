/**
 * Agent `space_settings` tool: read, approved writes, fail-closed without an
 * approval service, audit trail and connection probes.
 */
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createConnectionAudit } from '../../../host/control/connection-audit.js';
import {
  createConnectionSettingsStore,
  type ConnectionSettingsStore,
} from '../../../host/control/connection-settings.js';
import { SpaceModeController } from '../../../host/core/mode.js';
import { openRemoteCache } from '../../../host/remote/cache.js';
import {
  registerAgentSettingsTool,
  type ApprovalLike,
} from '../../../host/control/agent-settings-tool.js';
import type {
  ToolDefinitionLike,
  ToolRunContextLike,
  ToolsLike,
} from '../../../host/document/editors/legacy/tools.js';

const TOKEN = '0123456789abcdef0123456789abcdef';
const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'space-agent-settings-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

function quiet(): { info: (message: string) => void; warn: (message: string) => void } {
  return { info: () => undefined, warn: () => undefined };
}

interface Harness {
  directory: string;
  settings: ConnectionSettingsStore;
  mode: SpaceModeController;
  execute: (args: unknown) => Promise<unknown>;
  calls: Array<Record<string, unknown>>;
}

async function harness(options: {
  approval?: ApprovalLike;
} = {}): Promise<Harness> {
  const directory = await tempDir();
  const settings = createConnectionSettingsStore({ directory, logger: quiet() });
  const mode = new SpaceModeController({ directory, settings, logger: quiet() });
  await mode.open();
  cleanups.push(() => mode.close());
  const calls: Array<Record<string, unknown>> = [];
  let definition: ToolDefinitionLike | undefined;
  const tools: ToolsLike = {
    register(candidate) {
      definition = candidate;
      return () => undefined;
    },
  };
  const dispose = registerAgentSettingsTool(tools, {
    settings,
    mode,
    directory,
    audit: createConnectionAudit(directory),
    ...(options.approval === undefined
      ? {}
      : { approval: () => options.approval }),
  });
  cleanups.push(async () => dispose());
  void calls;
  return {
    directory,
    settings,
    mode,
    calls,
    async execute(args) {
      if (definition === undefined) throw new Error('tool not registered');
      const exec: ToolRunContextLike = {
        callId: 'call-1',
        name: 'space_settings',
        arguments: args,
        signal: new AbortController().signal,
        agent: { id: 'agent-test' },
      };
      return definition.execute(args, exec);
    },
  };
}

/** Audit writes are async appends; wait until the expected line lands. */
async function waitForAudit(
  directory: string,
  ready: (lines: Array<Record<string, unknown>>) => boolean,
): Promise<Array<Record<string, unknown>>> {
  const file = join(directory, 'connection-audit.jsonl');
  const deadline = Date.now() + 4_000;
  for (;;) {
    try {
      const lines = (await readFile(file, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      if (ready(lines)) return lines;
    } catch {
      // Not created yet.
    }
    if (Date.now() > deadline) throw new Error('audit trail was not flushed');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function approving(): ApprovalLike {
  return {
    async request() {
      return 'allowed-once';
    },
  };
}

describe('Agent space_settings tool', () => {
  it('reports the current local state', async () => {
    const h = await harness();
    const state = (await h.execute({ action: 'get' })) as Record<string, unknown>;
    expect(state.mode).toBe('local');
    expect(state.tokenConfigured).toBe(false);
    expect(
      (state.capabilities as Record<string, unknown>).workspaceMapping,
    ).toBe(true);
  });

  it('reads and updates the storage policy through the same tool', async () => {
    const h = await harness({ approval: approving() });
    const initial = (await h.execute({ action: 'get' })) as Record<string, unknown>;
    expect(initial.storage).toMatchObject({ historyLimit: expect.any(Number) });
    const updated = (await h.execute({
      action: 'set',
      history_limit: 5,
      snapshot_keep: 2,
    })) as Record<string, unknown>;
    expect(updated.storage).toMatchObject({ historyLimit: 5, snapshotKeep: 2 });
  });

  it('requires approval before it deletes recovery points', async () => {
    // Lowering either limit drops versions/snapshots on the next write, so the
    // tool must not do it silently; raising a limit only adds recovery points.
    const noApproval = await harness();
    await expect(
      noApproval.execute({ action: 'set', snapshot_keep: 2 }),
    ).rejects.toThrow('审批服务');

    const rejecting = await harness({
      approval: { request: async () => 'rejected' },
    });
    await expect(
      rejecting.execute({ action: 'set', history_limit: 3 }),
    ).rejects.toThrow('用户未批准');

    // Out-of-range values fail the tool's own bounds check, not the Host's.
    const bounded = await harness({ approval: approving() });
    await expect(
      bounded.execute({ action: 'set', history_limit: 0 }),
    ).rejects.toThrow('history_limit 必须在');
  });

  it('switches to server mode only after approval and writes an audit line', async () => {
    const h = await harness({ approval: approving() });
    const state = (await h.execute({
      action: 'set',
      mode: 'server',
      server_url: 'http://127.0.0.1:1',
      token: TOKEN,
      discard: true,
    })) as Record<string, unknown>;
    expect(state.mode).toBe('server');
    expect(h.mode.current().kind).toBe('server');
    const lines = await waitForAudit(h.directory, (all) =>
      all.some((line) => line.action === 'mode' && line.result === 'ok'),
    );
    expect(
      lines.some(
        (line) => line.actor === 'agent' && line.action === 'mode' && line.result === 'ok',
      ),
    ).toBe(true);
    expect(lines.some((line) => line.tokenChanged === true)).toBe(true);
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
  });

  it('fails closed without an approval service', async () => {
    const h = await harness();
    await expect(
      h.execute({
        action: 'set',
        mode: 'server',
        server_url: 'http://127.0.0.1:1',
        token: TOKEN,
        discard: true,
      }),
    ).rejects.toThrow(/审批服务/);
    expect((await h.settings.view()).mode).toBe('local');
  });

  it('keeps settings unchanged when the user rejects', async () => {
    const h = await harness({
      approval: { async request() { return 'rejected'; } },
    });
    await expect(
      h.execute({
        action: 'set',
        mode: 'server',
        server_url: 'http://127.0.0.1:1',
        token: TOKEN,
        discard: true,
      }),
    ).rejects.toThrow(/用户未批准/);
    expect((await h.settings.view()).mode).toBe('local');
  });

  it('requires approval before probing a model supplied server', async () => {
    const h = await harness();
    await expect(
      h.execute({ action: 'test', server_url: 'http://127.0.0.1:1' }),
    ).rejects.toThrow(/审批服务/);
    expect((await h.settings.view()).mode).toBe('local');
  });

  it('probes a server without persisting once approved', async () => {
    const h = await harness({ approval: approving() });
    const result = (await h.execute({
      action: 'test',
      server_url: 'http://127.0.0.1:1',
    })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(typeof result.message).toBe('string');
    expect((await h.settings.view()).mode).toBe('local');
  });

  it('never sends the resident token to an unconfigured URL', async () => {
    const seen: Array<string | undefined> = [];
    const server: Server = createServer((request, response) => {
      seen.push(request.headers.authorization);
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          product: '@alter-dsh/space',
          version: '0.0.0-test',
          protocolVersion: 1,
          databaseSchemaVersion: 3,
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const h = await harness({ approval: approving() });
      await h.settings.save({
        serverUrl: 'http://configured.invalid:8787',
        token: TOKEN,
      });
      const result = (await h.execute({
        action: 'test',
        server_url: `http://127.0.0.1:${String(port)}`,
      })) as Record<string, unknown>;
      expect(result.ok).toBe(true);
      expect(seen).toEqual([undefined]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('never flips the authority mode without an explicit discard', async () => {
    const h = await harness({ approval: approving() });
    await expect(
      h.execute({
        action: 'set',
        mode: 'server',
        server_url: 'http://127.0.0.1:1',
        token: TOKEN,
      }),
    ).rejects.toThrow(/显式确认放弃/);
    expect((await h.settings.view()).mode).toBe('local');
    expect(h.mode.current().kind).toBe('local');
  });

  it('requires approval to switch back to local mode', async () => {
    const h = await harness({
      approval: {
        async request() {
          return 'rejected';
        },
      },
    });
    // The persisted choice is server mode even though this test never ran a
    // real backend switch; the guard reads settings, not the open backend.
    await h.settings.save({
      mode: 'server',
      serverUrl: 'http://127.0.0.1:1',
      token: TOKEN,
    });
    await expect(
      h.execute({ action: 'set', mode: 'local', discard: true }),
    ).rejects.toThrow(/用户未批准/);
    expect((await h.settings.view()).mode).toBe('server');
  });

  it('refuses settings and queue flushes while a migration owns the authority', async () => {
    const h = await harness({ approval: approving() });
    h.mode.setMigrationLock(true);
    await expect(h.execute({ action: 'flush' })).rejects.toThrow(/迁移进行中/);
    await expect(
      h.execute({
        action: 'set',
        mode: 'server',
        server_url: 'http://127.0.0.1:1',
        token: TOKEN,
        discard: true,
      }),
    ).rejects.toThrow(/迁移进行中/);
    expect((await h.settings.view()).mode).toBe('local');
    h.mode.setMigrationLock(false);
  });

  it('cannot bypass the unsettled-queue guard on a server URL change', async () => {
    const h = await harness({ approval: approving() });
    const oldUrl = 'http://127.0.0.1:9';
    const newUrl = 'http://127.0.0.1:10';
    await h.settings.save({ mode: 'server', serverUrl: oldUrl, token: TOKEN });
    const cache = openRemoteCache(h.directory, oldUrl);
    cache.enqueue({
      docId: 'doc-queued',
      endpoint: 'doc.applyOps',
      payload: { docId: 'doc-queued', baseRevision: 1, ops: [] },
      idempotencyKey: 'idem-queued',
      baseRevision: 1,
      now: Date.now(),
    });
    cache.close();
    await expect(
      h.execute({ action: 'set', server_url: newUrl }),
    ).rejects.toThrow(/尚未同步到服务端|显式确认放弃/);
    expect((await h.settings.view()).serverUrl).toBe(oldUrl);
    const applied = (await h.execute({
      action: 'set',
      server_url: newUrl,
      discard: true,
    })) as Record<string, unknown>;
    expect(applied.serverUrl).toBe(newUrl);
    expect((await h.settings.view()).serverUrl).toBe(newUrl);
  });

  it('estimates the storage footprint without approval or writes', async () => {
    // Harness has no approval service: estimate is a read and must still work.
    const h = await harness();
    const current = (await h.execute({ action: 'estimate' })) as {
      settings: Record<string, unknown>;
      estimate: Record<string, unknown>;
    };
    expect(current.settings).toMatchObject({
      historyLimit: expect.any(Number),
      snapshotKeep: expect.any(Number),
    });
    for (const key of [
      'documentCount',
      'currentBytes',
      'projectedBytes',
      'deltaBytes',
    ])
      expect(typeof current.estimate[key], key).toBe('number');

    const candidate = (await h.execute({
      action: 'estimate',
      history_limit: 7,
      snapshot_keep: 3,
    })) as { settings: Record<string, unknown>; estimate: Record<string, unknown> };
    expect(typeof candidate.estimate.projectedBytes).toBe('number');
    // The projection never persists the candidate policy.
    expect(candidate.settings).toEqual(current.settings);
    expect((await h.settings.view()).mode).toBe('local');

    await expect(
      h.execute({ action: 'estimate', history_limit: 0 }),
    ).rejects.toThrow('history_limit 必须在');
  });

  it('lists an empty sync queue in local mode', async () => {
    const h = await harness();
    const result = (await h.execute({ action: 'queue' })) as {
      entries: unknown[];
    };
    expect(result.entries).toEqual([]);
  });

  it('refuses to resolve queued writes in local mode', async () => {
    const h = await harness({ approval: approving() });
    h.mode.setMigrationLock(true);
    await expect(
      h.execute({ action: 'resolve', doc_id: 'doc-1', resolution: 'retry' }),
    ).rejects.toThrow(/迁移进行中/);
    h.mode.setMigrationLock(false);

    await expect(
      h.execute({ action: 'resolve', doc_id: 'doc-1', resolution: 'retry' }),
    ).rejects.toThrow(/本地模式没有待处理的同步队列/);
    await expect(
      h.execute({ action: 'resolve', resolution: 'retry' }),
    ).rejects.toThrow(/resolve 需要 doc_id/);
    await expect(
      h.execute({ action: 'resolve', doc_id: 'doc-1', resolution: 'merge' }),
    ).rejects.toThrow(/resolution 必须是 retry 或 discard/);
  });
});
