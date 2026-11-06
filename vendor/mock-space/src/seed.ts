import type {
  Agent,
  AgentEvent,
  Comment,
  DocVersion,
  Milestone,
  Space,
  SpaceNode,
  SpaceTask,
  Thought,
} from './types';

export interface SpaceDatabase {
  version: 1;
  spaces: Space[];
  nodes: SpaceNode[];
  thoughts: Thought[];
  comments: Comment[];
  versions: DocVersion[];
  agents: Agent[];
  tasks: SpaceTask[];
  events: AgentEvent[];
  milestones: Milestone[];
}

/** 默认空间：收录尚未分类的内容，不可归档或删除。 */
export const DEFAULT_SPACE_ID = 'sp-inbox';
export const DEFAULT_SPACE_NAME = '日常';

type NodeSeed = Pick<
  SpaceNode,
  | 'id'
  | 'spaceId'
  | 'kind'
  | 'title'
  | 'creator'
  | 'parentId'
  | 'createdAt'
  | 'updatedAt'
  | 'content'
> &
  Partial<SpaceNode>;

function node(seed: NodeSeed): SpaceNode {
  return {
    pinned: false,
    archived: false,
    archivedBy: null,
    archivedAt: null,
    deletedAt: null,
    deletedRoot: false,
    originalParentId: null,
    unread: false,
    activity: 100,
    activityAt: seed.updatedAt,
    lastOpenCreditAt: seed.updatedAt,
    lastEditCreditAt: seed.updatedAt,
    order: 0,
    ...seed,
  };
}

function folder(
  seed: Omit<NodeSeed, 'kind' | 'content'> & { content?: string },
): SpaceNode {
  return node({ ...seed, kind: 'folder', content: '' });
}

const startDoc = `
<p>上周做决定时，我发现自己又在等更多信息。可真正卡住我的不是信息，而是承认这件事没有标准答案。</p>
<h2>这次想弄清楚的事</h2>
<p>判断和结论不是一回事。结论可以事后修改，判断则要求人在当时为它承担后果。</p>
<blockquote>判断不是结论，而是愿意为之后的后果负责。</blockquote>
<p>如果这句话成立，那么判断的质量就不只看结果，还要看当时掌握了什么、忽略了什么，以及是否留下了修正的余地。</p>
<h2>先试三件事</h2>
<ul>
<li>把判断写下来，连同当时的依据</li>
<li>给每个判断留一个可能被推翻的条件</li>
<li>一个月后回看，而不是当天争论对错</li>
</ul>
<div data-todo data-checked="false"><span data-todo-box="" role="checkbox" aria-checked="false" aria-label="待办事项" tabindex="0"></span><span data-todo-text="">找出上周那个决定的原始记录</span></div>
<div data-todo data-checked="true"><span data-todo-box="" role="checkbox" aria-checked="true" aria-label="待办事项" tabindex="0"></span><span data-todo-text="">区分「信息不足」和「不敢承担」</span></div>
<h2>还没想清楚</h2>
<p>复盘时很容易用结果倒推判断质量。有没有办法把「运气好」和「判断对」分开？</p>
<p>先从这里继续：<a data-doc-link="doc-explain" href="#/space/sp-cognition/doc/doc-explain"><span data-doc-icon aria-hidden="true"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h9l5 5v13H5z"/><path d="M14 3v6h5"/></svg></span>不要急着解释</a>。</p>
<a data-link-card="https://www.edge.org/conversation/thinking-fast-and-slow" href="https://www.edge.org/conversation/thinking-fast-and-slow" contenteditable="false" data-card-title="Thinking, Fast and Slow" data-card-description="关于直觉与审慎思考的对话记录。先把「系统一」和「系统二」的区别放回具体情境里。"><strong>Thinking, Fast and Slow</strong><span>edge.org · 关于直觉与审慎思考的对话记录</span></a>
`.trim();

const explainDoc = `
<p>遇到和自己预期不一样的结果，第一反应往往是解释它。解释让人重新获得掌控感，但也可能把还没看清的东西过早定型。</p>
<p>这次想把「解释」往后放一放：先把发生了什么写清楚，再谈为什么。</p>
<h2>观察和解释分开</h2>
<table><thead><tr><th>只写观察</th><th>容易混进来的解释</th></tr></thead><tbody><tr><td>会议里我三次没有说完一句话</td><td>他们不重视我的意见</td></tr><tr><td>文档写到第二节就停住了</td><td>我没有写作能力</td></tr><tr><td>决定之后我反复打开邮件</td><td>我做错了选择</td></tr></tbody></table>
<p>表格右边不一定错，但它需要证据，而不是当下最顺手的那个故事。</p>
<h2>留一个未解释的版本</h2>
<ul><li>当天只记录事实和身体反应</li><li>第二天再写可能的解释</li><li>一周后回看哪些解释经得起时间</li></ul>
`.trim();

const modelDoc = `
<p>过去我把判断理解为「在几个选项里选一个」。现在更愿意把它看成三层：看见什么、相信什么、愿意承担什么。</p>
<h2>三层结构</h2>
<h3>看见</h3>
<p>注意力的范围决定了判断的材料。多数失误不是推理错误，而是从一开始就没有看见关键部分。</p>
<h3>相信</h3>
<p>相信什么，往往来自过去的经验。经验越成功，越容易变成不需要检验的前提。</p>
<h3>承担</h3>
<p>判断最终是一个承诺：在信息不完整时，仍然愿意为选择负责，并保留修正的入口。</p>
<blockquote>好的判断不是从不犯错，而是错误发生时，仍然知道自己在哪一步走偏了。</blockquote>
<h2>先记录什么</h2>
<ol><li>当时看到的事实</li><li>自己依赖的经验</li><li>最担心的后果</li><li>什么情况下会改变主意</li></ol>
<p>这四栏足够开始，也能在复盘时对上号。更早的版本见 <a data-doc-link="doc-archived-clist" href="#/space/sp-cognition/doc/doc-archived-clist"><span data-doc-icon aria-hidden="true"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h9l5 5v13H5z"/><path d="M14 3v6h5"/></svg></span>旧版：决策清单</a>，其中一部分已经并进来了。</p>
`.trim();

const boundaryDoc = `
<p>经验帮我省掉了很多重复判断，但它也会悄悄划出一条边界：这件事我以前见过，所以不必重新看。</p>
<p>最近的两次误判都发生在这条边界上。不是经验错了，而是情境已经换了。</p>
<h2>可以检查的信号</h2>
<ul><li>我是否因为「以前就是这样」而停止了观察</li><li>这次的成功条件，和上次真的相同吗</li><li>如果换一个人，会看到什么我没看到的东西</li></ul>
`.trim();

const slowDoc = `
<p>「慢思考」不是把同一个问题想得更久，而是让判断在不同的状态下多经过几次。</p>
<ul><li>刚听到时写下一版，不急着说服自己</li><li>做别的事之后再看，注意哪里仍然成立</li><li>向 Alter 说明时，看它能否指出我漏掉的假设</li></ul>
<p>不是每个判断都值得这样对待。只有当后果足够重要，或者我明显感到自己在急着下结论时，才需要把它放慢。</p>
`.trim();

const readingDoc = `
<p>读这本书时，最有用的是它把「直觉很擅长什么」说清楚了，而不是简单地劝人少相信直觉。</p>
<blockquote>我们对自己知道什么、不知道什么，往往并不如想象中清楚。</blockquote>
<p>和最近的判断记录放在一起看，有一个共同点：失误通常不是因为想得不够复杂，而是因为遗漏了一个简单的事实。</p>
<h2>想继续找的材料</h2>
<ul><li>关于过度自信的实证研究</li><li>专家直觉在什么条件下可靠</li></ul>
`.trim();

const alterWeekDoc = `
<p>这一周空间里新增了 6 篇记录、3 条随想。我把反复出现的线索整理成三条，方便你回看。</p>
<h2>三条线索</h2>
<ol><li>你最近更在意「判断之后愿不愿意承担」，而不只是判断是否正确。</li><li>「解释」出现得越来越早，可能压住了观察。</li><li>你多次提到要把决定写下来，但目前只有一次形成了完整记录。</li></ol>
<h2>我做了什么</h2>
<ul><li>把「旧版：决策清单」中仍然有效的部分并入了「判断从哪里来」，原文已归档。</li><li>在「不要急着解释」里补了一张观察/解释对照表，保留了你的原始段落。</li></ul>
<p>如果这三条里有偏离你本意的地方，可以直接在评论里指出。</p>
`.trim();

const archivedChecklistDoc = `
<p>一份早期的决策清单，写于还没有开始记录判断依据的时候。</p>
<ol><li>列出所有选项</li><li>比较优缺点</li><li>选择最优解</li></ol>
<p>它的问题是把判断压缩成了一次比较，没有留下「当时为什么这样看」的线索。相关内容已经整理进「判断从哪里来」。</p>
`.trim();

const trashDraftDoc = `
<p>判断可能有三种来源：个人经验、他人经验、以及对情境的重新分析。</p>
<p>这个分法太粗糙，先放在这里。</p>
`.trim();

const aiPrinciplesDoc = `
<p>和 Alter 协作一段时间后，开始有一些稳定的原则。它们不是关于 AI 能做什么，而是关于我愿意把什么交出去。</p>
<h2>目前仍然成立的原则</h2>
<ol><li>先让它给草案，再决定要不要沿着草案走。</li><li>重要判断的依据必须回到材料里，而不是接受一个听起来合理的总结。</li><li>把「已经做了什么」和「为什么这样做」分开记录。</li></ol>
<blockquote>授权不是一次性的同意，而是对范围和后果的持续确认。</blockquote>
<h2>还没答案</h2>
<p>当 Alter 主动推进时，什么程度的提醒是帮助，什么程度会变成打断？</p>
`.trim();

const aiAsyncDoc = `
<p>异步协作最有价值的地方，不是更快，而是把「提出」和「决定」分开。</p>
<p>我可以先写下一个不成熟的问题，Alter 在后台整理材料、给出草案，等我回来时再判断。这个过程需要一条清楚的边界：什么可以自动做，什么必须等我确认。</p>
<h2>目前的分界</h2>
<ul><li>可以自动：整理、归档、起草、收集反例</li><li>需要确认：删除、对外发布、改变长期目标</li><li>暂不委托：涉及他人利益的判断</li></ul>
`.trim();

const aiDraftDoc = `
<p>让 AI 先给草案，最大的好处不是省时间，而是被迫看见一个不同于自己的起点。</p>
<p>但草案也容易带来锚定。现在我会先写下自己的三句话，再去看它给出的结构，避免一开始就被带走。</p>
`.trim();

const aiReviewDoc = `
<p>这周交给 Alter 的事：整理阅读摘记、起草两份文档骨架、归档过时材料。自己保留的事：所有需要承诺的判断。</p>
<h2>值得保留的做法</h2>
<ul><li>让它先说明准备怎么做，再开始执行</li><li>对整理结果抽查原文，而不是只看总结</li><li>把被拒绝的建议也留下来，之后可能有用</li></ul>
`.trim();

const aiArchiveDoc = `
<p>2025 年用过的工具清单。大部分已经不再使用，保留下来只作为路径记录。</p>
<ul><li>笔记：Obsidian</li><li>任务：Things</li><li>阅读：Readwise</li></ul>
`.trim();

const writeJudgmentDoc = `
<p>写作不是把想清楚的东西记录下来，而是让模糊的判断在句子里显形。</p>
<p>每次写到卡住的地方，通常不是缺词，而是前面某个判断还没有真正成立。</p>
<blockquote>先写那句最不愿意写的话，其余部分会重新排列。</blockquote>
<h2>最近在练的</h2>
<ul><li>一段只表达一个判断</li><li>删掉所有替判断铺垫的解释</li><li>把抽象词换成一个具体的场景</li></ul>
`.trim();

const writeFutureDoc = `
<p>写给半年后的自己：如果那时你正在读这段，先看看现在的三个目标还在不在。</p>
<ol><li>建立一套能长期使用的判断记录方式</li><li>让 Alter 承担更多整理和推进工作</li><li>每个月写一篇完整的文章，而不是只留片段</li></ol>
<p>如果目标变了，不必责怪当时的自己。把变化的原因写下来，就是下一轮判断的材料。</p>
`.trim();

const writeArchiveDoc = `
<p>2025 年度总结的旧提纲。</p>
<ol><li>这一年做了什么</li><li>有哪些遗憾</li><li>明年的计划</li></ol>
<p>写法太像汇报，已经不再适合现在的记录方式。新的总结会围绕「判断如何改变」来写。</p>
`.trim();

const inboxThoughtsDoc = `
<p>还没有归类的内容先放在这里。每周日清理一次，能归入空间的就移过去。</p>
<ul><li>为什么我在下午更容易做出冒险的决定</li><li>想重读《反对完美》</li><li>把会议记录里的判断单独抽出来</li></ul>
`.trim();

const inboxLinesDoc = `
<p>从昨天的对话里整理出三条线索：</p>
<ol><li>你更想减少「解释」，增加「观察」。</li><li>你在寻找一种能留下判断依据的记录方式。</li><li>你对「自动归档」的兴趣来自希望目录保持干净，而不是节省空间。</li></ol>
<p>如果需要，我可以把第二条展开成一篇正式笔记。</p>
`.trim();

export function createSeedDatabase(): SpaceDatabase {
  const spaces: Space[] = [
    {
      id: DEFAULT_SPACE_ID,
      name: DEFAULT_SPACE_NAME,
      goal: '先接住，再分类。',
      directories: ['~/Documents/Alter'],
      collaboratorIds: ['ag-alter'],
      isDefault: true,
      order: 0,
      createdAt: '2026-08-02T10:00:00+08:00',
      archivedAt: null,
    },
    {
      id: 'sp-cognition',
      name: '认知与判断',
      goal: '建立一套经得起现实检验的判断方法，并在真实决策中持续修正它。',
      directories: ['~/Documents/Alter/认知与判断', '~/Notes/判断'],
      collaboratorIds: ['ag-alter', 'ag-researcher'],
      isDefault: false,
      order: 1,
      createdAt: '2026-09-03T09:20:00+08:00',
      archivedAt: null,
    },
    {
      id: 'sp-ai',
      name: 'AI 与工作方式',
      goal: '让 AI 成为可靠的协作者，同时保留人的判断与授权。',
      directories: ['~/Projects/Alter'],
      collaboratorIds: ['ag-alter'],
      isDefault: false,
      order: 2,
      createdAt: '2026-09-18T14:10:00+08:00',
      archivedAt: null,
    },
    {
      id: 'sp-writing',
      name: '写作与表达',
      goal: '把零散的判断写成可以回看的文章。',
      directories: ['~/Notes'],
      collaboratorIds: ['ag-alter'],
      isDefault: false,
      order: 3,
      createdAt: '2026-10-01T20:30:00+08:00',
      archivedAt: null,
    },
  ];

  const agents: Agent[] = [
    {
      id: 'ag-alter',
      name: 'Alter',
      role: '长期协作 · 研究、整理与推进',
      createdAt: '2026-08-02T10:00:00+08:00',
    },
    {
      id: 'ag-researcher',
      name: '研究助手',
      role: '资料检索与事实核对',
      createdAt: '2026-09-05T11:00:00+08:00',
    },
  ];

  const nodes: SpaceNode[] = [
    folder({
      id: 'fd-model',
      spaceId: 'sp-cognition',
      title: '判断模型',
      creator: 'me',
      parentId: null,
      createdAt: '2026-09-05T10:10:00+08:00',
      updatedAt: '2026-10-19T11:05:00+08:00',
      order: 0,
    }),
    folder({
      id: 'fd-reading',
      spaceId: 'sp-cognition',
      title: '阅读线索',
      creator: 'me',
      parentId: null,
      createdAt: '2026-09-08T21:00:00+08:00',
      updatedAt: '2026-10-16T20:40:00+08:00',
      order: 1,
    }),
    node({
      id: 'doc-start',
      spaceId: 'sp-cognition',
      kind: 'note',
      title: '从一次判断开始',
      creator: 'me',
      parentId: null,
      pinned: true,
      content: startDoc,
      createdAt: '2026-10-12T09:10:00+08:00',
      updatedAt: '2026-10-21T08:40:00+08:00',
      activity: 100,
      order: 0,
    }),
    node({
      id: 'doc-explain',
      spaceId: 'sp-cognition',
      kind: 'note',
      title: '不要急着解释',
      creator: 'me',
      parentId: 'doc-start',
      content: explainDoc,
      createdAt: '2026-10-15T16:00:00+08:00',
      updatedAt: '2026-10-20T16:20:00+08:00',
      activity: 92,
      order: 0,
    }),
    node({
      id: 'doc-model',
      spaceId: 'sp-cognition',
      kind: 'note',
      title: '判断从哪里来',
      creator: 'me',
      parentId: 'fd-model',
      content: modelDoc,
      createdAt: '2026-09-22T10:00:00+08:00',
      updatedAt: '2026-10-19T11:05:00+08:00',
      activity: 88,
      order: 0,
    }),
    node({
      id: 'doc-boundary',
      spaceId: 'sp-cognition',
      kind: 'note',
      title: '经验的边界',
      creator: 'me',
      parentId: 'doc-model',
      content: boundaryDoc,
      createdAt: '2026-10-10T19:20:00+08:00',
      updatedAt: '2026-10-18T09:30:00+08:00',
      activity: 70,
      order: 0,
    }),
    node({
      id: 'doc-slow',
      spaceId: 'sp-cognition',
      kind: 'note',
      title: '关于「慢思考」的三条线索',
      creator: 'me',
      parentId: 'fd-reading',
      content: slowDoc,
      createdAt: '2026-10-09T21:10:00+08:00',
      updatedAt: '2026-10-16T20:40:00+08:00',
      activity: 64,
      order: 0,
    }),
    node({
      id: 'doc-reading',
      spaceId: 'sp-cognition',
      kind: 'note',
      title: '阅读摘记：思考，快与慢',
      creator: 'me',
      parentId: 'fd-reading',
      content: readingDoc,
      createdAt: '2026-09-30T22:00:00+08:00',
      updatedAt: '2026-10-14T21:30:00+08:00',
      activity: 82,
      order: 1,
    }),
    node({
      id: 'doc-alter-week',
      spaceId: 'sp-cognition',
      kind: 'note',
      title: '整理：本周的判断线索',
      creator: 'alter',
      parentId: null,
      content: alterWeekDoc,
      unread: true,
      createdAt: '2026-10-21T07:55:00+08:00',
      updatedAt: '2026-10-21T07:55:00+08:00',
      activity: 100,
      order: 1,
    }),
    node({
      id: 'doc-archived-clist',
      spaceId: 'sp-cognition',
      kind: 'note',
      title: '旧版：决策清单',
      creator: 'me',
      parentId: 'fd-model',
      content: archivedChecklistDoc,
      archived: false,
      activity: 4,
      activityAt: '2026-09-01T10:00:00+08:00',
      lastOpenCreditAt: '2026-09-01T10:00:00+08:00',
      lastEditCreditAt: '2026-09-01T10:00:00+08:00',
      createdAt: '2026-09-01T10:00:00+08:00',
      updatedAt: '2026-09-01T10:00:00+08:00',
      order: 1,
    }),
    node({
      id: 'doc-trash-draft',
      spaceId: 'sp-cognition',
      kind: 'note',
      title: '临时草稿：判断的三种来源',
      creator: 'me',
      parentId: 'fd-model',
      content: trashDraftDoc,
      deletedAt: '2026-10-18T17:40:00+08:00',
      deletedRoot: true,
      originalParentId: 'fd-model',
      createdAt: '2026-10-18T17:10:00+08:00',
      updatedAt: '2026-10-18T17:10:00+08:00',
      activity: 36,
      order: 2,
    }),

    node({
      id: 'doc-ai-principles',
      spaceId: 'sp-ai',
      kind: 'note',
      title: '和 Alter 一起工作的原则',
      creator: 'me',
      parentId: null,
      pinned: true,
      content: aiPrinciplesDoc,
      createdAt: '2026-09-18T14:20:00+08:00',
      updatedAt: '2026-10-20T10:20:00+08:00',
      activity: 100,
      order: 0,
    }),
    node({
      id: 'doc-ai-async',
      spaceId: 'sp-ai',
      kind: 'note',
      title: '异步协作的边界',
      creator: 'me',
      parentId: null,
      content: aiAsyncDoc,
      createdAt: '2026-10-02T09:40:00+08:00',
      updatedAt: '2026-10-19T15:10:00+08:00',
      activity: 82,
      order: 1,
    }),
    node({
      id: 'doc-ai-draft',
      spaceId: 'sp-ai',
      kind: 'note',
      title: '让 AI 先给草案',
      creator: 'me',
      parentId: 'doc-ai-async',
      content: aiDraftDoc,
      createdAt: '2026-10-08T11:00:00+08:00',
      updatedAt: '2026-10-17T18:30:00+08:00',
      activity: 74,
      order: 0,
    }),
    node({
      id: 'doc-ai-review',
      spaceId: 'sp-ai',
      kind: 'note',
      title: '本周复盘：哪些事交给了 AI',
      creator: 'alter',
      parentId: null,
      content: aiReviewDoc,
      unread: true,
      createdAt: '2026-10-21T08:05:00+08:00',
      updatedAt: '2026-10-21T08:05:00+08:00',
      activity: 100,
      order: 2,
    }),
    node({
      id: 'doc-ai-archive',
      spaceId: 'sp-ai',
      kind: 'note',
      title: '工具清单 2025',
      creator: 'me',
      parentId: null,
      content: aiArchiveDoc,
      archived: true,
      archivedBy: 'agent',
      archivedAt: '2026-10-11T09:00:00+08:00',
      createdAt: '2025-12-30T10:00:00+08:00',
      updatedAt: '2025-12-30T10:00:00+08:00',
      activity: 0,
      activityAt: '2026-10-11T09:00:00+08:00',
      order: 3,
    }),

    node({
      id: 'doc-write-judgment',
      spaceId: 'sp-writing',
      kind: 'note',
      title: '写作是判断的显影',
      creator: 'me',
      parentId: null,
      pinned: true,
      content: writeJudgmentDoc,
      createdAt: '2026-10-04T20:10:00+08:00',
      updatedAt: '2026-10-20T22:10:00+08:00',
      activity: 100,
      order: 0,
    }),
    node({
      id: 'doc-write-future',
      spaceId: 'sp-writing',
      kind: 'note',
      title: '写给未来的自己',
      creator: 'me',
      parentId: 'doc-write-judgment',
      content: writeFutureDoc,
      createdAt: '2026-10-06T21:00:00+08:00',
      updatedAt: '2026-10-18T21:40:00+08:00',
      activity: 66,
      order: 0,
    }),
    node({
      id: 'doc-write-archive',
      spaceId: 'sp-writing',
      kind: 'note',
      title: '2025 年度总结提纲',
      creator: 'me',
      parentId: null,
      content: writeArchiveDoc,
      archived: true,
      archivedBy: 'user',
      archivedAt: '2026-10-13T15:00:00+08:00',
      createdAt: '2025-12-18T19:00:00+08:00',
      updatedAt: '2025-12-18T19:00:00+08:00',
      activity: 0,
      order: 1,
    }),

    node({
      id: 'doc-inbox-thoughts',
      spaceId: 'sp-inbox',
      kind: 'note',
      title: '未分类的想法',
      creator: 'me',
      parentId: null,
      content: inboxThoughtsDoc,
      createdAt: '2026-10-03T09:00:00+08:00',
      updatedAt: '2026-10-21T09:10:00+08:00',
      activity: 100,
      order: 0,
    }),
    node({
      id: 'doc-inbox-lines',
      spaceId: 'sp-inbox',
      kind: 'note',
      title: '从对话里整理出的三条线索',
      creator: 'alter',
      parentId: null,
      content: inboxLinesDoc,
      unread: true,
      createdAt: '2026-10-20T18:30:00+08:00',
      updatedAt: '2026-10-20T18:30:00+08:00',
      activity: 100,
      order: 1,
    }),
  ];

  const thoughts: Thought[] = [
    {
      id: 'th-inbox-long',
      spaceId: 'sp-inbox',
      content:
        '<p>今天重新看了一遍过去的判断记录。真正让我停下来的不是结论本身，而是当时没有写清楚的条件：我以为自己在等待更多信息，其实是在等一个不会出错的选择。</p><p>下次做决定之前，先把「什么情况下我会改变判断」写下来，再开始收集材料。也许这比继续寻找更多证据更有用。</p>',
      createdAt: '2026-10-21T10:20:00+08:00',
      updatedAt: '2026-10-21T10:20:00+08:00',
      archived: false,
      archivedAt: null,
      deletedAt: null,
      convertedDocId: null,
    },
    {
      id: 'th-1',
      spaceId: 'sp-cognition',
      content: '<p>判断不是结论，而是愿意为之后的后果负责的选择。</p>',
      createdAt: '2026-10-21T09:42:00+08:00',
      updatedAt: '2026-10-21T09:42:00+08:00',
      archived: false,
      archivedAt: null,
      deletedAt: null,
      convertedDocId: null,
    },
    {
      id: 'th-2',
      spaceId: 'sp-cognition',
      content: '<p>复盘时先问：当时我忽略了什么？而不是只问结果好不好。</p>',
      createdAt: '2026-10-21T08:15:00+08:00',
      updatedAt: '2026-10-21T08:15:00+08:00',
      archived: false,
      archivedAt: null,
      deletedAt: null,
      convertedDocId: null,
    },
    {
      id: 'th-3',
      spaceId: 'sp-cognition',
      content:
        '<p>写不出来的时候，先把这一段压缩成一句话。如果一句话也写不出来，说明判断还没成立。</p>',
      createdAt: '2026-10-20T21:10:00+08:00',
      updatedAt: '2026-10-20T21:10:00+08:00',
      archived: false,
      archivedAt: null,
      deletedAt: null,
      convertedDocId: 'doc-explain',
    },
    {
      id: 'th-4',
      spaceId: 'sp-cognition',
      content: '<p>「慢思考」不是想得久，而是愿意让一个判断多活几天。</p>',
      createdAt: '2026-10-19T22:05:00+08:00',
      updatedAt: '2026-10-19T22:05:00+08:00',
      archived: false,
      archivedAt: null,
      deletedAt: null,
      convertedDocId: null,
    },
    {
      id: 'th-archived',
      spaceId: 'sp-cognition',
      content: '<p>旧的想法：把所有决定都记录下来。</p>',
      createdAt: '2026-10-12T18:00:00+08:00',
      updatedAt: '2026-10-12T18:00:00+08:00',
      archived: true,
      archivedAt: '2026-10-16T09:00:00+08:00',
      deletedAt: null,
      convertedDocId: null,
    },
    {
      id: 'th-deleted',
      spaceId: 'sp-cognition',
      content: '<p>晚饭后想到：也许该把判断模型做成一个可以勾选的清单。</p>',
      createdAt: '2026-10-17T20:30:00+08:00',
      updatedAt: '2026-10-17T20:30:00+08:00',
      archived: false,
      archivedAt: null,
      deletedAt: '2026-10-18T10:00:00+08:00',
      convertedDocId: null,
    },
    {
      id: 'th-ai-1',
      spaceId: 'sp-ai',
      content:
        '<p>先让它说明准备怎么做，再决定是否开始执行。这个顺序比结果本身更重要。</p>',
      createdAt: '2026-10-21T10:05:00+08:00',
      updatedAt: '2026-10-21T10:05:00+08:00',
      archived: false,
      archivedAt: null,
      deletedAt: null,
      convertedDocId: null,
    },
    {
      id: 'th-ai-2',
      spaceId: 'sp-ai',
      content:
        '<p>自动归档的价值也许不是省空间，而是让目录只保留现在还有效的东西。</p>',
      createdAt: '2026-10-19T17:20:00+08:00',
      updatedAt: '2026-10-19T17:20:00+08:00',
      archived: false,
      archivedAt: null,
      deletedAt: null,
      convertedDocId: null,
    },
    {
      id: 'th-write-1',
      spaceId: 'sp-writing',
      content: '<p>今天只写了一句：「判断的显影」。先留着，明天再展开。</p>',
      createdAt: '2026-10-20T23:10:00+08:00',
      updatedAt: '2026-10-20T23:10:00+08:00',
      archived: false,
      archivedAt: null,
      deletedAt: null,
      convertedDocId: null,
    },
    {
      id: 'th-inbox-1',
      spaceId: 'sp-inbox',
      content:
        '<p>为什么我在下午更容易做出冒险的决定？也许和一天里累积的决策疲劳有关。</p>',
      createdAt: '2026-10-21T11:20:00+08:00',
      updatedAt: '2026-10-21T11:20:00+08:00',
      archived: false,
      archivedAt: null,
      deletedAt: null,
      convertedDocId: null,
    },
  ];

  const versions: DocVersion[] = [
    {
      id: 'ver-start-1',
      docId: 'doc-start',
      title: '从一次判断开始',
      content:
        '<p>上周做决定时，我发现自己又在等更多信息。</p><p>判断和结论有什么不同？先记下来。</p>',
      author: 'me',
      at: '2026-10-12T09:30:00+08:00',
    },
    {
      id: 'ver-start-2',
      docId: 'doc-start',
      title: '从一次判断开始',
      content:
        '<p>上周做决定时，我发现自己又在等更多信息。可真正卡住我的不是信息，而是承认这件事没有标准答案。</p><h2>这次想弄清楚的事</h2><p>判断和结论不是一回事。结论可以事后修改，判断则要求人在当时为它承担后果。</p><blockquote>判断不是结论，而是愿意为之后的后果负责。</blockquote>',
      author: 'me',
      at: '2026-10-18T20:10:00+08:00',
    },
    {
      id: 'ver-start-3',
      docId: 'doc-start',
      title: '从一次判断开始',
      content: startDoc,
      author: 'alter',
      at: '2026-10-20T07:40:00+08:00',
    },
    {
      id: 'ver-model-1',
      docId: 'doc-model',
      title: '判断从哪里来',
      content: '<p>过去我把判断理解为在几个选项里选一个。</p>',
      author: 'me',
      at: '2026-09-22T10:10:00+08:00',
    },
    {
      id: 'ver-model-2',
      docId: 'doc-model',
      title: '判断从哪里来',
      content: modelDoc,
      author: 'me',
      at: '2026-10-19T11:05:00+08:00',
    },
  ];

  const comments: Comment[] = [
    {
      id: 'cm-1',
      docId: 'doc-start',
      author: 'alter',
      body: '这条可以成为这一节的支点。要不要把上周那个决定也放进来作为例子？',
      quote: '判断不是结论，而是愿意为之后的后果负责。',
      status: 'open',
      createdAt: '2026-10-20T08:02:00+08:00',
      resolvedAt: null,
      editedAt: null,
      supplements: [],
    },
    {
      id: 'cm-2',
      docId: 'doc-start',
      author: 'me',
      body: '信息收集有时只是推迟判断。这点我承认，但还需要具体例子。',
      quote: '我发现自己又在等更多信息',
      status: 'open',
      createdAt: '2026-10-20T09:15:00+08:00',
      resolvedAt: null,
      editedAt: null,
      supplements: [],
    },
    {
      id: 'cm-3',
      docId: 'doc-start',
      author: 'alter',
      body: '已经按这个分法补了一张观察/解释对照表，放在「不要急着解释」里。',
      quote: null,
      status: 'resolved',
      createdAt: '2026-10-18T15:30:00+08:00',
      resolvedAt: '2026-10-19T10:00:00+08:00',
      editedAt: null,
      supplements: [],
    },
    {
      id: 'cm-4',
      docId: 'doc-explain',
      author: 'alter',
      body: '表格第三行可以再具体一点：反复打开邮件时，你在确认什么？',
      quote: '决定之后我反复打开邮件',
      status: 'open',
      createdAt: '2026-10-20T17:00:00+08:00',
      resolvedAt: null,
      editedAt: null,
      supplements: [],
    },
  ];

  const tasks: SpaceTask[] = [
    {
      id: 'task-1',
      spaceId: 'sp-cognition',
      title: '确认「判断模型」的大纲',
      detail:
        'Alter 根据最近的记录重新排了一版结构：看见、相信、承担，并补上了「经验的边界」。需要你确认这三层是否覆盖了你真正关心的部分。',
      status: 'pending',
      owner: 'alter',
      docId: 'doc-model',
      createdAt: '2026-10-21T07:50:00+08:00',
    },
    {
      id: 'task-2',
      spaceId: 'sp-cognition',
      title: '查看整理后的线索',
      detail:
        '本周的 6 篇记录和 3 条随想被归纳成三条线索。其中第二条提到「解释出现得越来越早」，需要你判断是否符合实际感受。',
      status: 'pending',
      owner: 'alter',
      docId: 'doc-alter-week',
      createdAt: '2026-10-21T07:56:00+08:00',
    },
    {
      id: 'task-3',
      spaceId: 'sp-cognition',
      title: '补充一个反例',
      detail:
        '「经验的边界」目前只有推论，没有具体反例。Alter 建议补一次「经验失效」的实际经历，让这一节可以被检验。',
      status: 'in_progress',
      owner: 'me',
      docId: 'doc-boundary',
      createdAt: '2026-10-19T12:00:00+08:00',
    },
    {
      id: 'task-4',
      spaceId: 'sp-ai',
      title: '确认异步协作的授权范围',
      detail:
        '目前的分界里，「收集反例」被列为可以自动执行。请确认它是否也需要在完成后回看材料原文。',
      status: 'pending',
      owner: 'alter',
      docId: 'doc-ai-async',
      createdAt: '2026-10-20T15:00:00+08:00',
    },
  ];

  const events: AgentEvent[] = [
    {
      id: 'ev-1',
      spaceId: 'sp-cognition',
      title: '归档了「旧版：决策清单」',
      detail:
        '其中的有效内容已经并入「判断从哪里来」，原文保留在已归档中，可以随时回看。',
      at: '2026-10-15T09:00:00+08:00',
      docId: 'doc-archived-clist',
      taskId: null,
    },
    {
      id: 'ev-2',
      spaceId: 'sp-cognition',
      title: '整理了本周的判断线索',
      detail:
        '合并了 6 篇文档与 3 条随想中反复出现的主题，形成三条线索，等待你确认。',
      at: '2026-10-21T07:55:00+08:00',
      docId: 'doc-alter-week',
      taskId: 'task-2',
    },
    {
      id: 'ev-3',
      spaceId: 'sp-cognition',
      title: '补了一张观察/解释对照表',
      detail:
        '在「不要急着解释」中新增表格，保留了原始段落，没有改动你的表述。',
      at: '2026-10-20T16:20:00+08:00',
      docId: 'doc-explain',
      taskId: null,
    },
    {
      id: 'ev-4',
      spaceId: 'sp-cognition',
      title: '重排了「判断模型」的结构',
      detail: '把原来的四个步骤收拢为三层，并新增「经验的边界」作为反例入口。',
      at: '2026-10-19T11:05:00+08:00',
      docId: 'doc-model',
      taskId: 'task-1',
    },
    {
      id: 'ev-5',
      spaceId: 'sp-ai',
      title: '起草了本周复盘',
      detail:
        '按「交给 AI / 自己保留 / 值得保留的做法」整理了这一周的协作记录。',
      at: '2026-10-21T08:05:00+08:00',
      docId: 'doc-ai-review',
      taskId: null,
    },
    {
      id: 'ev-6',
      spaceId: 'sp-ai',
      title: '重写了异步协作的边界',
      detail: '把授权范围拆成可以自动、需要确认、暂不委托三类，等待你确认。',
      at: '2026-10-20T15:00:00+08:00',
      docId: 'doc-ai-async',
      taskId: 'task-4',
    },
    {
      id: 'ev-7',
      spaceId: 'sp-writing',
      title: '收拢了两个写作片段',
      detail: '把「写作是判断的显影」里重复的段落合并，保留了原来的句子顺序。',
      at: '2026-10-20T22:10:00+08:00',
      docId: 'doc-write-judgment',
      taskId: null,
    },
    {
      id: 'ev-8',
      spaceId: 'sp-inbox',
      title: '整理出三条线索',
      detail:
        '从昨天的对话里整理了三条可能值得展开的线索，放在「从对话里整理出的三条线索」中。',
      at: '2026-10-20T18:30:00+08:00',
      docId: 'doc-inbox-lines',
      taskId: null,
    },
  ];

  const milestones: Milestone[] = [
    {
      id: 'ms-1',
      spaceId: 'sp-cognition',
      title: '建立第一版判断模型',
      detail: '从零散记录收拢出「看见、相信、承担」三层结构。',
      status: 'done',
      period: '2026 年 9 月',
    },
    {
      id: 'ms-2',
      spaceId: 'sp-cognition',
      title: '完成 10 次真实判断复盘',
      detail: '目前完成 4 次，重点是把结果和当时的依据分开记录。',
      status: 'current',
      period: '2026 年 10 月 — 12 月',
    },
    {
      id: 'ms-3',
      spaceId: 'sp-cognition',
      title: '写一篇关于判断的文章',
      detail: '用一次真实的判断过程作为主线，而不是整理概念。',
      status: 'next',
      period: '下一阶段',
    },
    {
      id: 'ms-4',
      spaceId: 'sp-ai',
      title: '明确异步协作的授权边界',
      detail: '把可以自动执行的工作与必须确认的工作分开。',
      status: 'current',
      period: '2026 年 10 月',
    },
    {
      id: 'ms-5',
      spaceId: 'sp-writing',
      title: '完成一篇完整的文章',
      detail: '从「写作是判断的显影」开始，先写 2000 字。',
      status: 'current',
      period: '2026 年 10 月',
    },
  ];

  return {
    version: 1,
    spaces,
    nodes,
    thoughts,
    comments,
    versions,
    agents,
    tasks,
    events,
    milestones,
  };
}
