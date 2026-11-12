/**
 * Model-facing Agent tool for the Space hub overview and configuration.
 *
 * Only the four implemented hub actions are exposed: `get` projects a bounded
 * snapshot (long text is clipped), `summarize` refreshes the overview summary,
 * `set_policy` picks how Alter asks for decisions and `set_plugin_enabled`
 * toggles one plugin. The matter / journey / observation / plugin-discovery
 * endpoints still throw "该功能暂未实现" (DEP-002) and must never become
 * model-callable by accident.
 *
 * @module @alter-dsh/space/authority/hub-tools
 */
import type { HubSnapshot } from '@alter/protocol';
import type {
  JsonSchemaLike,
  ToolTextBlock,
  ToolsLike,
} from '../document/editors/legacy/tools.js';
import {
  asRecord,
  clip,
  invalid,
  requireAction,
  requireBoolean,
  requireString,
  text,
  toToolError,
} from './tool-support.js';
import type { RpcToolDeps } from './tool-support.js';

const HUB_ACTIONS = [
  'get',
  'summarize',
  'set_policy',
  'set_plugin_enabled',
] as const;

const POLICIES = ['ask', 'judge', 'autonomous'] as const;

type Policy = (typeof POLICIES)[number];

/** Long prose fields are previews, never the whole stored text. */
const SUMMARY_MAX = 400;
const JOURNEY_MAX = 200;

/** Plugin fields worth returning; the manifest also carries content/description. */
interface PluginProjection {
  id: string;
  label: string;
  enabled: boolean;
  builtin: boolean;
  required: boolean;
}

/** Bounded hub projection returned by `get` and after `summarize`. */
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

function projectPlugin(plugin: HubSnapshot['plugins'][number]): PluginProjection {
  return {
    id: plugin.id,
    label: plugin.label,
    enabled: plugin.enabled,
    builtin: plugin.builtin,
    required: plugin.required,
  };
}

function projectSummary(
  snapshot: HubSnapshot,
): HubProjection['summary'] {
  return {
    content: clip(snapshot.summary.content, SUMMARY_MAX),
    updated_at: snapshot.summary.updatedAt,
  };
}

/**
 * Bound the snapshot: counts only for matters/observations, clipped prose for
 * the summary and journey, and a fixed field set per plugin.
 */
function projectHub(spaceId: string, snapshot: HubSnapshot): HubProjection {
  return {
    space_id: spaceId,
    policy: snapshot.policy,
    onboarding: snapshot.onboarding,
    summary: projectSummary(snapshot),
    plugins: snapshot.plugins.map(projectPlugin),
    matters: { total: snapshot.matters.length },
    observations: { total: snapshot.observations.length },
    journey: {
      vision: clip(snapshot.journey.vision, JOURNEY_MAX),
      short_term: clip(snapshot.journey.shortTerm, JOURNEY_MAX),
      long_term: clip(snapshot.journey.longTerm, JOURNEY_MAX),
    },
  };
}

/** Read the required `policy` argument of `set_policy`. */
function requirePolicy(args: Record<string, unknown>): Policy {
  const value = args.policy;
  if (
    typeof value !== 'string' ||
    !(POLICIES as readonly string[]).includes(value)
  )
    invalid('policy 必须是 ask | judge | autonomous 之一');
  return value as Policy;
}

/** Dispatch one hub action over the alter-bound endpoint seam. */
async function hub(
  deps: RpcToolDeps,
  input: Record<string, unknown>,
): Promise<unknown> {
  const action = requireAction(input, HUB_ACTIONS);
  const spaceId = requireString(input, 'space_id');

  switch (action) {
    case 'get':
      return projectHub(
        spaceId,
        (await deps.rpc('hub.get', [spaceId])) as HubSnapshot,
      );
    case 'summarize': {
      await deps.rpc('hub.summarize', [spaceId]);
      const snapshot = (await deps.rpc('hub.get', [spaceId])) as HubSnapshot;
      return { space_id: spaceId, summary: projectSummary(snapshot) };
    }
    case 'set_policy': {
      const policy = requirePolicy(input);
      await deps.rpc('hub.setPolicy', [spaceId, policy]);
      return { space_id: spaceId, policy };
    }
    case 'set_plugin_enabled': {
      const pluginId = requireString(input, 'plugin_id');
      const enabled = requireBoolean(input, 'enabled');
      await deps.rpc('hub.setPluginEnabled', [spaceId, pluginId, enabled]);
      return { space_id: spaceId, plugin_id: pluginId, enabled };
    }
  }
}

function renderHub(args: unknown, value: unknown): ToolTextBlock[] {
  const input =
    typeof args === 'object' && args !== null
      ? (args as { action?: unknown })
      : {};
  const result = value as Record<string, unknown>;

  if (input.action === 'set_policy') {
    return [text(`已把决策策略设为 ${String(result.policy ?? '')}。`)];
  }
  if (input.action === 'set_plugin_enabled') {
    const verb = result.enabled === true ? '启用' : '禁用';
    return [text(`已${verb}插件 ${String(result.plugin_id ?? '')}。`)];
  }

  const summary = result.summary as HubProjection['summary'] | undefined;
  const content = summary?.content ?? '';
  if (input.action === 'summarize') {
    return [text(`已更新概览总结：${content || '（内容为空）'}`)];
  }

  const plugins = Array.isArray(result.plugins)
    ? (result.plugins as PluginProjection[])
    : [];
  const journey = result.journey as HubProjection['journey'] | undefined;
  const matters = result.matters as HubProjection['matters'] | undefined;
  const observations = result.observations as
    | HubProjection['observations']
    | undefined;
  const journeyLine =
    [
      ['愿景', journey?.vision],
      ['短期', journey?.short_term],
      ['长期', journey?.long_term],
    ]
      .filter(([, entry]) => typeof entry === 'string' && entry !== '')
      .map(([label, entry]) => `${label}：${String(entry)}`)
      .join('；') || '（未填写）';
  const pluginLine =
    plugins
      .map(
        (plugin) =>
          `${plugin.id}（${plugin.label}，${plugin.enabled ? '已启用' : '已禁用'}${
            plugin.builtin ? '，内置' : ''
          }${plugin.required ? '，必需' : ''}）`,
      )
      .join('、') || '（无）';
  return [
    text(
      [
        `空间 ${String(result.space_id ?? '')}：决策策略 ${String(result.policy ?? '')}，引导 ${String(result.onboarding ?? '')}`,
        `概览：${content === '' ? '（尚未生成，可用 action=summarize 生成）' : content}`,
        `旅程：${journeyLine}`,
        `插件：${pluginLine}`,
        `事项 ${matters?.total ?? 0} · 观察 ${observations?.total ?? 0}`,
      ].join('\n'),
    ),
  ];
}

/** Permissive multi-action output shape, same convention as the other tools. */
const outputSchema: JsonSchemaLike = {
  type: 'object',
  additionalProperties: true,
  properties: {},
};

/** Whether one call only reads hub state (safe to run concurrently). */
function isReadCall(args: unknown): boolean {
  return (
    typeof args === 'object' &&
    args !== null &&
    (args as { action?: unknown }).action === 'get'
  );
}

/** Human title for the presentation card of one hub call. */
function titleOf(args: unknown): string {
  const action =
    typeof args === 'object' && args !== null
      ? (args as { action?: unknown }).action
      : undefined;
  switch (action) {
    case 'summarize':
      return 'Summarize Space hub';
    case 'set_policy':
      return 'Set Space hub policy';
    case 'set_plugin_enabled':
      return 'Toggle Space hub plugin';
    default:
      return 'Read Space hub';
  }
}

/**
 * Register `space_hub` on one Host tools service.
 * @param tools - Host tools service.
 * @param deps - alter-bound endpoint caller plus the approval resolver.
 * @returns disposer that removes the registration.
 */
export function registerHubTools(
  tools: ToolsLike,
  deps: RpcToolDeps,
): () => void {
  const disposers: Array<() => void> = [];

  disposers.push(
    tools.register({
      name: 'space_hub',
      description:
        "Read or update the Space hub. action=get returns a bounded overview: decision policy, onboarding state, the generated summary, plugin switches, journey vision/short-term/long-term (clipped) and counts of matters/observations. action=summarize refreshes the overview summary from current records. action=set_policy chooses how Alter handles decisions (ask|judge|autonomous). action=set_plugin_enabled toggles one hub plugin; required plugins cannot be disabled.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: [...HUB_ACTIONS],
            description: 'Hub operation to run.',
          },
          space_id: {
            type: 'string',
            description: 'Target space; required for every action.',
          },
          policy: {
            type: 'string',
            enum: [...POLICIES],
            description: 'set_policy: how Alter asks for decisions (required).',
          },
          plugin_id: {
            type: 'string',
            description:
              'set_plugin_enabled: plugin id from action=get (required).',
          },
          enabled: {
            type: 'boolean',
            description:
              'set_plugin_enabled: target state (required); required plugins cannot be disabled.',
          },
        },
      },
      output: {
        schema: outputSchema,
        render: (args, value) => renderHub(args, value),
      },
      isConcurrencySafe: (args) => isReadCall(args),
      async execute(args) {
        try {
          return await hub(deps, asRecord(args));
        } catch (error) {
          throw toToolError(error);
        }
      },
      presentCall: (args) => ({
        card: 'generic',
        title: titleOf(args),
        kind: isReadCall(args) ? 'read' : 'edit',
      }),
    }),
  );

  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}