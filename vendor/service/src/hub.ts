import type {
  AgentEvent,
  DecisionPolicy,
  HubSnapshot,
  Journey,
  Matter,
  Space,
  SpaceHubService,
  SpaceNode,
  Thought,
} from '@alter/protocol';
import type { SpaceHubServiceOptions } from './contracts.js';

/**
 * 概览总结的提示词。本批尚未接入模型，`composeSummary` 按同样的结构在本地组合
 * 真实记录；接入生成器后以这里为输入替换本地组合实现（DEP-001）。
 */
export const SUMMARY_PROMPT =
  '你是这个空间的长期协作者。根据空间愿景、近期文档、随想和 Alter 的活动，总结最近在推进什么、发生了哪些变化、下一步值得关注什么。只依据提供的记录，不推测未发生的进度；用 80–120 字写成一段中文，不使用列表，区分已经发生的变化和仍待判断的部分。';

/**
 * 本批只提供「概览」「配置」两个详情插件；动态、旅程与观察的插件注册与数据
 * 依赖 Agent 执行，登记为 DEP-002，待数据源就绪后再恢复。
 */
const BUILTIN_PLUGINS = [
  ['overview', '概览', '空间近况、活动与使用统计'],
  ['config', '配置', '空间信息、协作者与插件'],
] as const;

function plainText(html: string) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(text: string, max = 24) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 真实记录的本地总结替身：从最近文档、随想、Alter 活动和事项状态拼出一段
 * 近似提示词输出的中文摘要，不调用模型。
 */
function composeSummary(
  space: Space,
  docs: SpaceNode[],
  matters: Matter[],
  journey: Journey,
  thoughts: Thought[],
  events: AgentEvent[],
) {
  const notes = docs
    .filter((doc) => doc.kind === 'note' && !doc.deletedAt)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 2);
  const parts: string[] = [];
  if (notes.length) {
    parts.push(
      `最近主要在整理${notes
        .map((doc) => `《${doc.title || '未命名文档'}》`)
        .join('、')}`,
    );
  }
  const thought = thoughts
    .filter((item) => !item.deletedAt)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (thought) {
    const text = clip(plainText(thought.content));
    if (text) parts.push(`新增了随想「${text}」`);
  }
  const event = [...events].sort(
    (a, b) => Date.parse(b.at) - Date.parse(a.at),
  )[0];
  if (event) parts.push(`Alter ${event.title}`);
  const running = matters.filter((item) => item.status === 'running').length;
  const waiting = matters.filter((item) => item.status === 'waiting').length;
  if (running || waiting) {
    parts.push(`目前 ${running} 项正在推进，${waiting} 项等你回应`);
  }
  if (!parts.length) return `「${space.name}」还没有可总结的记录。`;
  const next = journey.shortTerm
    ? `下一步的重点是${journey.shortTerm.replace(/[。！？]$/, '')}`
    : '下一步可以从最近更新的文档继续';
  return `${parts.join('，')}。${next}。`;
}

/** 新空间的初始快照：事项、观察、用量为空，引导视为已完成，总结尚未生成。 */
function emptySnapshot(at: string): HubSnapshot {
  return {
    matters: [],
    journey: {
      vision: '',
      shortTerm: '',
      longTerm: '',
      principles: '',
      background: '',
      updatedAt: at,
      nodes: [],
    },
    observations: [],
    plugins: BUILTIN_PLUGINS.map(([id, label, description]) => ({
      id,
      label,
      description,
      builtin: true,
      required: true,
      enabled: true,
    })),
    policy: 'ask',
    onboarding: 'complete',
    summary: { content: '', updatedAt: '' },
    usage: [],
  };
}

function notImplemented(...values: unknown[]): never {
  void values;
  throw new Error('该功能暂未实现');
}

/** 真实业务 hub：快照与配置持久化在宿主数据文件，内容从真实记录聚合。 */
export function createHubService({
  store,
  reader,
  now,
  actor,
}: SpaceHubServiceOptions): SpaceHubService {
  const at = () => now().toISOString();
  const clone = <T>(value: T): T => structuredClone(value);
  // 事项/旅程/观察尚未实现（DEP-002）；实现后其创建路径必须从 actor 派生
  // source/owner，与内容服务同一词表（creatorOf/archiveSourceOf）。
  void actor;

  function requireSpace(spaceId: string) {
    reader.space(spaceId);
  }

  async function get(spaceId: string): Promise<HubSnapshot> {
    requireSpace(spaceId);
    const existing: HubSnapshot | undefined = store.read().hub[spaceId];
    if (existing) return clone(existing);
    return store.update((data) => {
      const stored: HubSnapshot | undefined = data.hub[spaceId];
      if (!stored) data.hub[spaceId] = emptySnapshot(at());
      return clone(data.hub[spaceId]);
    });
  }

  /**
   * 在 store 的串行写队列里修改快照；修改或持久化失败时把快照恢复成修改前的值。
   */
  async function change(spaceId: string, mutate: (state: HubSnapshot) => void) {
    requireSpace(spaceId);
    await store.update((data) => {
      const stored: HubSnapshot | undefined = data.hub[spaceId];
      const previous = stored ? clone(stored) : undefined;
      const state = stored ?? (data.hub[spaceId] = emptySnapshot(at()));
      try {
        mutate(state);
      } catch (error) {
        if (previous) data.hub[spaceId] = previous;
        else delete data.hub[spaceId];
        throw error;
      }
    });
  }

  function plugin(state: HubSnapshot, id: string) {
    const value = state.plugins.find((item) => item.id === id);
    if (!value) throw new Error('插件已不可用，请刷新后重试');
    return value;
  }

  return {
    get,
    async createMatter(spaceId, title, description, source) {
      notImplemented(spaceId, title, description, source);
    },
    async setMatterStatus(spaceId, id, status, reason) {
      notImplemented(spaceId, id, status, reason);
    },
    async answerMatter(spaceId, id, answers) {
      notImplemented(spaceId, id, answers);
    },
    async readMatter(spaceId, id) {
      notImplemented(spaceId, id);
    },
    async saveJourney(spaceId, patch) {
      notImplemented(spaceId, patch);
    },
    async introduce(spaceId, background, vision, next) {
      notImplemented(spaceId, background, vision, next);
    },
    async skipIntroduction(spaceId) {
      notImplemented(spaceId);
    },
    async acceptObservation(spaceId, id, accepted) {
      notImplemented(spaceId, id, accepted);
    },
    async extractSkill(spaceId, id, instructions) {
      notImplemented(spaceId, id, instructions);
    },
    async setPolicy(spaceId: string, policy: DecisionPolicy) {
      await change(spaceId, (state) => {
        state.policy = policy;
      });
    },
    async setPluginEnabled(spaceId: string, id: string, enabled: boolean) {
      await change(spaceId, (state) => {
        const value = plugin(state, id);
        if (value.required && !enabled)
          throw new Error('概览与配置需要保持开启');
        value.enabled = enabled;
      });
    },
    async discoverPlugin(spaceId, label, purpose) {
      notImplemented(spaceId, label, purpose);
    },
    async savePluginContent(spaceId, id, content) {
      notImplemented(spaceId, id, content);
    },
    async summarize(spaceId: string) {
      await change(spaceId, (state) => {
        state.summary = {
          content: composeSummary(
            reader.space(spaceId),
            reader.nodes(spaceId),
            state.matters,
            state.journey,
            reader.thoughts(spaceId),
            reader.events(spaceId),
          ),
          updatedAt: at(),
        };
      });
    },
    remove(spaceId: string) {
      // 契约返回 void：删除尽力持久化；失败时快照保留，下次读取会重新初始化。
      void store
        .update((data) => {
          delete data.hub[spaceId];
        })
        .catch(() => {});
    },
  };
}
