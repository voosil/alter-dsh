/**
 * Agent `space_hub` tool over the real local authority.
 *
 * The four exposed actions only cover the implemented hub endpoints; the
 * projection stays bounded (clipped prose, counts for matters/observations,
 * fixed plugin fields) and never reaches the DEP-002 placeholder endpoints.
 */
import { describe, expect, it } from 'vitest';
import { registerHubTools } from '../../../host/authority/hub-tools.js';
import type { RpcCall } from '../../../host/authority/tool-support.js';
import type {
  ToolDefinitionLike,
  ToolsLike,
} from '../../../host/document/editors/legacy/tools.js';
import { runtimeAgentRpc } from '../../support/agent-rpc.js';
import { startRuntime, type TestRuntime } from '../../support/harness.js';

const INBOX = 'sp-inbox';
const signal = new AbortController().signal;

interface PluginProjection {
  id: string;
  label: string;
  enabled: boolean;
  builtin: boolean;
  required: boolean;
}

interface HubProjection {
  space_id: string;
  policy: string;
  onboarding: string;
  summary: { content: string; updated_at: string };
  plugins: PluginProjection[];
  matters: { total: number };
  observations: { total: number };
  journey: { vision: string; short_term: string; long_term: string };
}

interface ToolHarness {
  definitions: Map<string, ToolDefinitionLike>;
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/** Capture `space_hub` over one alter-bound endpoint caller. */
function captureTools(rpc: RpcCall): ToolHarness {
  const definitions = new Map<string, ToolDefinitionLike>();
  const tools: ToolsLike = {
    register(definition) {
      definitions.set(definition.name, definition);
      return () => {
        definitions.delete(definition.name);
      };
    },
  };
  registerHubTools(tools, { rpc });
  return {
    definitions,
    async call(name, args) {
      const definition = definitions.get(name);
      if (definition === undefined)
        throw new Error(`tool ${name} is not registered`);
      return definition.execute(args, {
        callId: `${name}-call`,
        name,
        arguments: args,
        signal,
      });
    },
  };
}

async function localHarness(): Promise<{
  runtime: TestRuntime['runtime'];
  tools: ToolHarness;
}> {
  const { runtime } = await startRuntime();
  return { runtime, tools: captureTools(runtimeAgentRpc(runtime)) };
}

/** The rejected error of a call that must fail. */
async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the tool call to fail');
}

async function getHub(tools: ToolHarness): Promise<HubProjection> {
  return (await tools.call('space_hub', {
    action: 'get',
    space_id: INBOX,
  })) as HubProjection;
}

describe('space_hub in local mode', () => {
  it('projects the initial snapshot: ask policy, two built-in plugins, zero counts', async () => {
    const { tools } = await localHarness();
    const hub = await getHub(tools);

    expect(hub.space_id).toBe(INBOX);
    expect(hub.policy).toBe('ask');
    expect(hub.onboarding).toBe('complete');
    expect(hub.summary).toEqual({ content: '', updated_at: '' });
    expect(hub.matters).toEqual({ total: 0 });
    expect(hub.observations).toEqual({ total: 0 });
    expect(hub.journey).toEqual({
      vision: '',
      short_term: '',
      long_term: '',
    });

    expect(hub.plugins.map((plugin) => plugin.id).sort()).toEqual([
      'config',
      'overview',
    ]);
    for (const plugin of hub.plugins) {
      // Every built-in plugin is required and enabled by default.
      expect(plugin.builtin).toBe(true);
      expect(plugin.required).toBe(true);
      expect(plugin.enabled).toBe(true);
      expect(Object.keys(plugin).sort()).toEqual([
        'builtin',
        'enabled',
        'id',
        'label',
        'required',
      ]);
    }
  });

  it('set_policy writes through and a following get reflects the new value', async () => {
    const { tools } = await localHarness();
    const updated = (await tools.call('space_hub', {
      action: 'set_policy',
      space_id: INBOX,
      policy: 'autonomous',
    })) as Record<string, unknown>;
    expect(updated).toEqual({ space_id: INBOX, policy: 'autonomous' });

    expect((await getHub(tools)).policy).toBe('autonomous');

    const invalid = await failure(
      tools.call('space_hub', {
        action: 'set_policy',
        space_id: INBOX,
        policy: 'always',
      }),
    );
    expect(invalid.message).toContain('space/invalid-input');
    expect(invalid.message).toContain('policy 必须是 ask | judge | autonomous');
    // A rejected write leaves the previous policy untouched.
    expect((await getHub(tools)).policy).toBe('autonomous');
  });

  it('set_plugin_enabled refuses to disable a required plugin', async () => {
    const { tools } = await localHarness();
    for (const pluginId of ['overview', 'config']) {
      const error = await failure(
        tools.call('space_hub', {
          action: 'set_plugin_enabled',
          space_id: INBOX,
          plugin_id: pluginId,
          enabled: false,
        }),
      );
      expect(error.message).toContain('概览与配置需要保持开启');
    }
    const missing = await failure(
      tools.call('space_hub', {
        action: 'set_plugin_enabled',
        space_id: INBOX,
        plugin_id: 'not-a-plugin',
        enabled: true,
      }),
    );
    expect(missing.message).toContain('插件已不可用');
  });

  it('summarize refreshes the summary from current records and get returns it', async () => {
    const { runtime, tools } = await localHarness();
    await runtime.agentDocument.generate({
      spaceId: INBOX,
      title: '项目进展',
      markdown: '# 项目进展\n\n本周记录正文。',
    });

    const summarized = (await tools.call('space_hub', {
      action: 'summarize',
      space_id: INBOX,
    })) as { space_id: string; summary: { content: string; updated_at: string } };
    expect(summarized.space_id).toBe(INBOX);
    expect(summarized.summary.content.length).toBeGreaterThan(0);
    expect(summarized.summary.content).toContain('项目进展');
    expect(summarized.summary.updated_at).not.toBe('');

    const hub = await getHub(tools);
    expect(hub.summary).toEqual(summarized.summary);
  });

  it('rejects missing space_id, unknown actions and unknown spaces', async () => {
    const { tools } = await localHarness();
    const missing = await failure(tools.call('space_hub', { action: 'get' }));
    expect(missing.message).toContain('space_id');

    const unknownAction = await failure(
      tools.call('space_hub', { action: 'create_matter', space_id: INBOX }),
    );
    expect(unknownAction.message).toContain('space/invalid-input');
    expect(unknownAction.message).toContain(
      'action 必须是 get | summarize | set_policy | set_plugin_enabled',
    );
    const parameters = tools.definitions.get('space_hub')!.parameters as {
      properties: Record<string, { enum?: string[] }>;
    };
    expect(parameters.properties.action?.enum).toEqual([
      'get',
      'summarize',
      'set_policy',
      'set_plugin_enabled',
    ]);

    const unknownSpace = await failure(
      tools.call('space_hub', { action: 'get', space_id: 'sp-missing' }),
    );
    expect(unknownSpace.message).toContain('space/not-found');
  });
});