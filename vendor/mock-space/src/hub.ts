import type { AgentEvent, Space, SpaceNode, Thought } from './types';
import type {
  HubSnapshot,
  Journey,
  Matter,
  MatterStatus,
  SpaceHubService,
  SpacePluginManifest,
} from './hub-types';

const KEY = 'alter.space.hub.v1';
const DAY = 86_400_000;
const builtinPlugins = [
  ['overview', '概览', '空间近况、活动与使用统计'],
  ['activity', 'Alter 的动态', '计划、回应和执行的来龙去脉'],
  ['journey', '愿景与旅程', '目标、路径和沿途积累的经验'],
  ['observations', 'Alter 的观察', '反复出现的行为与判断模式'],
  ['config', '配置', '空间信息、协作者与插件'],
];
export const SUMMARY_PROMPT =
  '你是这个空间的长期协作者。根据空间愿景、近期文档、随想和 Alter 的活动，总结最近在推进什么、发生了哪些变化、下一步值得关注什么。只依据提供的记录，不推测未发生的进度；用 80–120 字写成一段中文，不使用列表，区分已经发生的变化和仍待判断的部分。';

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
 * 设计阶段的本地总结替身：从最近文档、随想、Alter 活动和事项状态拼出一段
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
  const event = events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
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

function seed(
  space: Space,
  docs: SpaceNode[],
  thoughts: Thought[],
  events: AgentEvent[],
  now: Date,
): HubSnapshot {
  const at = now.toISOString();
  const sample = ['sp-inbox', 'sp-cognition', 'sp-writing'].includes(space.id);
  const day = (offset: number) =>
    new Date(now.getTime() - offset * DAY).toISOString();
  const titles = space.isDefault
    ? [
        '整理本周的零散记录',
        '确认周末的安排',
        '整理待办与材料',
        '归整已处理的收件',
        '暂停重复提醒',
      ]
    : [
        '从最近的记录里寻找下一步',
        '确定下一阶段的重点',
        '整理一次真实判断的复盘',
        '建立第一版经验清单',
        '暂缓一次范围过大的研究',
      ];
  const statuses: MatterStatus[] = [
    'planning',
    'waiting',
    'running',
    'completed',
    'abandoned',
  ];
  const matters: Matter[] = sample
    ? statuses.map((status, index) => ({
        id: `matter-${index + 1}`,
        title: titles[index]!,
        description:
          index === 1
            ? '已有材料足够开始，但下一步的范围和投入时间需要你的判断。'
            : '从已有记录出发，保留依据、判断和结果，让每一步都能回看。',
        status,
        source: 'agent',
        agent: 'Alter',
        type: index === 1 ? '方向确认' : '资料整理',
        createdAt: day(index + 1),
        updatedAt: day(index),
        unread: index === 1 || index === 3,
        plan: '先核对原始记录，再整理关键线索，最后形成可以讨论的结论。',
        reason:
          status === 'abandoned'
            ? '范围过大，先集中处理眼前最重要的问题。'
            : '',
        docIds: docs
          .filter((doc) => doc.kind === 'note' && !doc.deletedAt)
          .slice(0, 2)
          .map((doc) => doc.id),
        questions:
          status === 'waiting'
            ? [
                {
                  id: 'focus',
                  title: '这次先聚焦什么？',
                  description: '选择一个方向，避免同时展开过多事情。',
                  options: ['回看已有实践', '补充外部资料', '先做一次小尝试'],
                  required: true,
                },
                {
                  id: 'constraints',
                  title: '有哪些需要尊重的限制？',
                  description: '例如时间、投入或不希望改变的安排。',
                  required: true,
                },
              ]
            : [],
        answers: {},
        execution:
          status === 'running'
            ? 'active'
            : status === 'completed'
              ? 'finished'
              : status === 'abandoned'
                ? 'stopped'
                : 'idle',
        timeline: [
          {
            id: 'origin',
            title: '动机',
            detail: '最近的记录出现了值得进一步梳理的线索。',
            at: day(index + 1),
          },
          {
            id: 'plan',
            title:
              status === 'completed'
                ? '结果'
                : status === 'abandoned'
                  ? '暂停'
                  : '计划',
            detail:
              status === 'completed'
                ? '已整理原始材料，留下可以复用的经验与待核对的问题。'
                : '先核对依据，再决定下一步。',
            at: day(index),
          },
        ],
      }))
    : [];
  const snapshot: HubSnapshot = {
    matters,
    journey: {
      vision: space.goal,
      shortTerm:
        sample && !space.isDefault
          ? '回看最近一次实践，补全当时的依据与判断。'
          : '',
      longTerm:
        sample && !space.isDefault
          ? '让经验经得起真实情境的检验，逐步形成自己的方法。'
          : '',
      principles:
        sample && !space.isDefault
          ? '先记录事实，再作解释。\n保留改变主意的条件。'
          : '',
      background: '',
      updatedAt: at,
      nodes:
        sample && !space.isDefault
          ? [
              {
                id: 'start',
                title: '从一个真实问题出发',
                detail: '把最初的期待和困难记录下来。',
                state: 'past',
                date: day(25),
              },
              {
                id: 'detour',
                title: '一次过早的解释',
                detail:
                  '结论先于事实，回看时发现遗漏了关键条件。由此留下原则：先观察，再解释。',
                state: 'failed',
                date: day(12),
              },
              {
                id: 'present',
                title: '回到实践中核对',
                detail: '用一次具体经历检验当前方法。',
                state: 'current',
                date: at,
                matterId: 'matter-3',
              },
              {
                id: 'next',
                title: '形成可复用的经验',
                detail: '整理经过验证的方法，保留适用范围。',
                state: 'future',
                date: '',
              },
            ]
          : [],
    },
    observations: sample
      ? [
          {
            id: 'behavior-review',
            kind: 'behavior',
            title: '在行动前整理一份简短清单',
            detail: '你多次把目标、已有材料和下一步写在一起，再开始推进。',
            count: 4,
            accepted: false,
            evidence: Array.from({ length: 4 }, (_, i) => ({
              title: ['行动前梳理', '周末回看', '开始前的记录', '新任务准备'][
                i
              ]!,
              date: day(i * 3),
              docId: docs.find((doc) => doc.kind === 'note')?.id,
            })),
          },
          {
            id: 'judgment-evidence',
            kind: 'judgment',
            title: '先核对依据，再扩大投入',
            detail:
              '当信息不足时，你倾向于先完成一次小范围验证，再决定是否扩大投入。',
            count: 5,
            accepted: false,
            evidence: [
              {
                title: '一次判断的依据',
                date: day(2),
                docId: docs.find((doc) => doc.kind === 'note')?.id,
              },
              { title: '复盘中的修正', date: day(7) },
              { title: '新方向的选择', date: day(13) },
            ],
          },
        ]
      : [],
    plugins: builtinPlugins.map(([id, label, description]) => ({
      id: id!,
      label: label!,
      description: description!,
      builtin: true,
      required: id === 'overview' || id === 'config',
      enabled: !(space.isDefault && id === 'journey'),
    })),
    policy: 'ask',
    onboarding: sample ? 'complete' : 'pending',
    summary: {
      content: '',
      updatedAt: at,
    },
    usage: sample
      ? Array.from({ length: 28 }, (_, i) => ({
          date: day(27 - i).slice(0, 10),
          actions: (i * 7 + 3) % 9,
          inputTokens: 2100 + i * 151,
          outputTokens: 550 + i * 23,
          cachedTokens: 700 + i * 67,
          model: i % 3 ? 'DeepSeek V3' : 'DeepSeek R1',
        }))
      : [],
  };
  if (sample) {
    snapshot.summary.content = composeSummary(
      space,
      docs,
      snapshot.matters,
      snapshot.journey,
      thoughts,
      events,
    );
  }
  return snapshot;
}

/** Local design data. Mutations model user-visible signals; no Agent or code execution. */
export function createSpaceHubService(options: {
  space: (id: string) => Space;
  nodes: (id: string) => SpaceNode[];
  thoughts?: (id: string) => Thought[];
  events?: (id: string) => AgentEvent[];
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  now: () => Date;
}): SpaceHubService {
  let database: Record<string, HubSnapshot> = {};
  try {
    const raw = options.storage?.getItem(KEY);
    if (raw) database = JSON.parse(raw) as Record<string, HubSnapshot>;
  } catch {
    /* Start with design data if the saved snapshot cannot be read. */
  }
  const clone = <T>(value: T): T => structuredClone(value);
  const at = () => options.now().toISOString();
  function persist() {
    options.storage?.setItem(KEY, JSON.stringify(database));
  }
  function get(id: string) {
    const space = options.space(id);
    return (database[id] ??= seed(
      space,
      options.nodes(id),
      options.thoughts?.(id) ?? [],
      options.events?.(id) ?? [],
      options.now(),
    ));
  }
  function change(id: string, update: (state: HubSnapshot) => void) {
    const previous = clone(get(id));
    try {
      update(get(id));
      persist();
    } catch (error) {
      database[id] = previous;
      throw error;
    }
  }
  function matter(state: HubSnapshot, id: string) {
    const value = state.matters.find((item) => item.id === id);
    if (!value) throw new Error('事项已不可用，请刷新后重试');
    return value;
  }
  function observation(state: HubSnapshot, id: string) {
    const value = state.observations.find((item) => item.id === id);
    if (!value) throw new Error('这条观察已不可用，请刷新后重试');
    return value;
  }
  function plugin(state: HubSnapshot, id: string) {
    const value = state.plugins.find((item) => item.id === id);
    if (!value) throw new Error('插件已不可用，请刷新后重试');
    return value;
  }
  function log(item: Matter, title: string, detail: string) {
    item.updatedAt = at();
    item.timeline.push({ id: crypto.randomUUID(), title, detail, at: at() });
  }
  return {
    async get(id) {
      return clone(get(id));
    },
    async createMatter(id, title, description, source = 'user') {
      if (!title.trim()) throw new Error('填写事项标题');
      const state = get(id);
      const requiresDecision =
        source === 'agent' && state.policy !== 'autonomous';
      const item: Matter = {
        id: crypto.randomUUID(),
        title: title.trim(),
        description: description.trim(),
        status: requiresDecision ? 'waiting' : 'planning',
        source,
        agent: 'Alter',
        type: requiresDecision ? '行动许可' : '新计划',
        createdAt: at(),
        updatedAt: at(),
        unread: source === 'agent',
        plan: '梳理相关记录，明确目标与下一步。',
        reason: '',
        docIds: [],
        questions: requiresDecision
          ? [
              {
                id: 'permission',
                title: '是否继续推进这个计划？',
                description: description.trim(),
                options: ['同意推进', '暂不推进'],
                required: true,
              },
            ]
          : [],
        answers: {},
        timeline: [],
        execution: 'idle',
      };
      log(
        item,
        source === 'user' ? '用户发起' : 'Alter 提出',
        item.description,
      );
      change(id, (value) => value.matters.unshift(item));
      return clone(item);
    },
    async setMatterStatus(id, itemId, status, reason = '') {
      change(id, (state) => {
        const item = matter(state, itemId);
        if (item.status === status) return;
        if (
          status === 'running' &&
          item.questions.some((q) => q.required && !item.answers[q.id]?.trim())
        )
          throw new Error('请先提交待回应的问题');
        if (status === 'running' && item.answers.permission === '暂不推进')
          throw new Error('该计划尚未获得许可，请先重新确认');
        item.status = status;
        item.reason = status === 'abandoned' ? reason.trim() : '';
        item.execution =
          status === 'running'
            ? 'active'
            : status === 'completed'
              ? 'finished'
              : status === 'abandoned'
                ? 'stopped'
                : 'idle';
        item.unread = false;
        if (
          state.plugins.some((p) => p.id === 'journey' && p.enabled) &&
          (status === 'completed' || status === 'abandoned')
        ) {
          const node = state.journey.nodes.find(
            (n) => n.matterId === item.id && n.state === 'current',
          );
          const result = {
            title: item.title,
            detail:
              status === 'abandoned'
                ? reason.trim() || '这条路径暂时停下，保留已经走过的记录。'
                : item.description,
            state:
              status === 'completed' ? ('past' as const) : ('failed' as const),
            date: at(),
            matterId: item.id,
          };
          if (node) Object.assign(node, result);
          else state.journey.nodes.push({ id: crypto.randomUUID(), ...result });
          state.journey.updatedAt = at();
        }
        log(
          item,
          '用户调整状态',
          (
            {
              planning: '重新规划',
              waiting: '等待回应',
              running: '开始推进',
              completed: '标记完成',
              abandoned: '停止推进',
            } as const
          )[status] + (reason.trim() ? `：${reason.trim()}` : ''),
        );
      });
    },
    async answerMatter(id, itemId, answers) {
      change(id, (state) => {
        const item = matter(state, itemId);
        if (item.status !== 'waiting')
          throw new Error('事项状态已变化，请刷新后查看');
        for (const q of item.questions) {
          if (q.required && !answers[q.id]?.trim())
            throw new Error(`请回答：${q.title}`);
          if (q.options && answers[q.id] && !q.options.includes(answers[q.id]!))
            throw new Error('请选择有效选项');
        }
        item.answers = Object.fromEntries(
          item.questions.map((q) => [q.id, answers[q.id]?.trim() ?? '']),
        );
        item.status =
          answers.permission === '暂不推进' ? 'abandoned' : 'planning';
        item.reason = item.status === 'abandoned' ? '用户暂不推进' : '';
        item.execution = item.status === 'abandoned' ? 'stopped' : 'idle';
        item.unread = false;
        log(
          item,
          '收到你的回应',
          item.questions
            .map((q) => `${q.title} ${item.answers[q.id]}`)
            .join('\n'),
        );
      });
    },
    async readMatter(id, itemId) {
      change(id, (state) => {
        matter(state, itemId).unread = false;
      });
    },
    async saveJourney(id, patch) {
      change(id, (state) => {
        state.journey = { ...state.journey, ...patch, updatedAt: at() };
      });
    },
    async introduce(id, background, vision, next) {
      if (!background.trim() || !vision.trim() || !next.trim())
        throw new Error('请补全背景、期待和下一步');
      change(id, (state) => {
        state.journey = {
          ...state.journey,
          background: background.trim(),
          vision: vision.trim(),
          shortTerm: next.trim(),
          longTerm: vision.trim(),
          updatedAt: at(),
          nodes: state.journey.nodes.length
            ? [
                ...state.journey.nodes.filter(
                  (node) => node.state !== 'future',
                ),
                {
                  id: crypto.randomUUID(),
                  title: '接下来的方向',
                  detail: next.trim(),
                  state: 'future',
                  date: '',
                },
              ]
            : [
                {
                  id: crypto.randomUUID(),
                  title: '从这里出发',
                  detail: background.trim(),
                  state: 'past',
                  date: at(),
                },
                {
                  id: crypto.randomUUID(),
                  title: '眼前的一步',
                  detail: next.trim(),
                  state: 'current',
                  date: at(),
                },
                {
                  id: crypto.randomUUID(),
                  title: '期待到达的地方',
                  detail: vision.trim(),
                  state: 'future',
                  date: '',
                },
              ],
        };
        state.onboarding = 'complete';
      });
    },
    async skipIntroduction(id) {
      change(id, (state) => {
        state.onboarding = 'skipped';
      });
    },
    async acceptObservation(id, itemId, accepted) {
      change(id, (state) => {
        observation(state, itemId).accepted = accepted;
      });
    },
    async extractSkill(id, itemId, instructions) {
      if (!instructions.trim()) throw new Error('补充技能的执行步骤');
      change(id, (state) => {
        const item = observation(state, itemId);
        item.skill = { name: item.title, instructions: instructions.trim() };
      });
    },
    async setPolicy(id, policy) {
      change(id, (state) => {
        state.policy = policy;
      });
    },
    async setPluginEnabled(id, pluginId, enabled) {
      change(id, (state) => {
        const value = plugin(state, pluginId);
        if (value.required && !enabled)
          throw new Error('概览与配置需要保持开启');
        value.enabled = enabled;
      });
    },
    async discoverPlugin(id, label, purpose) {
      if (!label.trim() || !purpose.trim())
        throw new Error('填写插件名称和用途');
      const value: SpacePluginManifest = {
        id: `custom-${crypto.randomUUID()}`,
        label: label.trim(),
        description: purpose.trim(),
        builtin: false,
        required: false,
        enabled: false,
        content: purpose.trim(),
      };
      change(id, (state) => {
        if (state.plugins.some((p) => p.label === value.label))
          throw new Error('已有同名插件，请换一个名称');
        state.plugins.push(value);
      });
      return clone(value);
    },
    async savePluginContent(id, pluginId, content) {
      change(id, (state) => {
        const item = plugin(state, pluginId);
        if (item.builtin) throw new Error('内置插件不能在此编辑');
        item.content = content;
      });
    },
    async summarize(id) {
      change(id, (state) => {
        state.summary = {
          content: composeSummary(
            options.space(id),
            options.nodes(id),
            state.matters,
            state.journey,
            options.thoughts?.(id) ?? [],
            options.events?.(id) ?? [],
          ),
          updatedAt: at(),
        };
      });
    },
    remove(id) {
      delete database[id];
      persist();
    },
  };
}
