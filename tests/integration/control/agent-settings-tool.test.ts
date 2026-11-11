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
    const h = await harness();
    const initial = (await h.execute({ action: 'get' })) as Record<string, unknown>;
    expect(initial.storage).toMatchObject({ historyLimit: expect.any(Number) });
    const updated = (await h.execute({
      action: 'set',
      history_limit: 5,
      snapshot_keep: 2,
    })) as Record<string, unknown>;
    expect(updated.storage).toMatchObject({ historyLimit: 5, snapshotKeep: 2 });
  });

  it('switches to server mode only after approval and writes an audit line', async () => {
    const h = await harness({ approval: approving() });
    const state = (await h.execute({
      action: 'set',
      mode: 'server',
      server_url: 'http://127.0.0.1:1',
      token: TOKEN,
    })) as Record<string, unknown>;
    expect(state.mode).toBe('server');
    expect(h.mode.current().kind).toBe('server');
    const lines = (await readFile(
      join(h.directory, 'connection-audit.jsonl'),
      'utf8',
    ))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.at(-1)).toMatchObject({
      actor: 'agent',
      action: 'server',
      result: 'ok',
    });
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
});
