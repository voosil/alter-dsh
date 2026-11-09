/**
 * Space detail → 配置 is a vendored view the DSH port redesigned in place
 * (recorded in `vendor/VENDOR.md`). This server-rendered test keeps the
 * information architecture and the copy contract from drifting back: one
 * border-free section stack, no explanatory section notes, one-line policy
 * choice, and built-in plugins that are labelled instead of offered a disabled
 * switch.
 */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  Agent,
  HubSnapshot,
  Space,
  SpaceService,
} from '../vendor/protocol/src/index';
import { SpaceContext } from '../vendor/ui-space/src/runtime';
import type { SpaceContextValue } from '../vendor/ui-space/src/runtime';
import { HubContext } from '../vendor/ui-space/src/hub/context';
import { ConfigView } from '../vendor/ui-space/src/views/ConfigView';

const now = new Date().toISOString();

const space: Space = {
  id: 's1',
  name: '产品研究',
  goal: '把访谈整理成判断。',
  directories: [],
  collaboratorIds: ['a1'],
  isDefault: false,
  order: 1,
  createdAt: now,
  archivedAt: null,
};

const agents: Agent[] = [
  { id: 'a1', name: '研究助手', role: '梳理资料', createdAt: now },
];

const hub: HubSnapshot = {
  matters: [],
  journey: {
    vision: '',
    shortTerm: '',
    longTerm: '',
    principles: '',
    background: '',
    updatedAt: now,
    nodes: [],
  },
  observations: [],
  plugins: [
    {
      id: 'overview',
      label: '概览',
      description: '空间近况、活动与使用统计',
      builtin: true,
      required: true,
      enabled: true,
    },
    {
      id: 'config',
      label: '配置',
      description: '空间信息、协作者与插件',
      builtin: true,
      required: true,
      enabled: true,
    },
  ],
  policy: 'judge',
  onboarding: 'complete',
  summary: { content: '', updatedAt: now },
  usage: [],
};

function context(): SpaceContextValue {
  return {
    service: {} as unknown as SpaceService,
    router: {
      getPath: () => '#/space/s1/config',
      subscribe: () => () => {},
      navigate: () => {},
    },
    spaces: [space],
    agents,
    space,
    spaceId: space.id,
    nodes: [],
    thoughts: [],
    version: 0,
    refresh: () => {},
    toast: () => {},
    openSearch: () => {},
    openThoughtComposer: () => {},
    openDirectory: () => {},
    closeDirectory: () => {},
    removeSpaceFromState: () => {},
    addSpaceToState: () => {},
    addNodeToState: () => {},
    updateNodeInState: () => {},
  };
}

function render(): string {
  return renderToStaticMarkup(
    createElement(
      SpaceContext.Provider,
      { value: context() },
      createElement(
        HubContext.Provider,
        { value: hub },
        createElement(ConfigView) as ReactNode,
      ) as ReactNode,
    ),
  );
}

describe('Space config page', () => {
  it('orders the sections from space content to the danger zone', () => {
    const html = render();
    const titles = [
      '基本信息',
      '工作目录',
      '协作者',
      'Agent 的决定权限',
      '空间插件',
      '空间管理',
    ];
    const positions = titles.map((title) => html.indexOf(title));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('dropped the explanatory section notes of the reused page', () => {
    const html = render();
    expect(html).not.toContain('主动提出计划时');
    expect(html).not.toContain('当前版本内置');
    expect(html).not.toContain('这个空间关联的工作目录');
    expect(html).not.toContain('选择可以一起研究');
    expect(html).not.toContain('归档后可从设置中的');
    expect(html).not.toContain('保持开启');
  });

  it('renders the policy as one segmented choice plus the selected explanation', () => {
    const html = render();
    for (const label of ['始终询问', 'Agent 判断', '完全自主']) {
      expect(html).toContain(label);
    }
    // Only the active policy's sentence is rendered.
    expect(html).toContain('按上下文判断是否需要询问。');
    expect(html).not.toContain('行动前先征得你的同意。');
  });

  it('labels built-in plugins instead of showing a disabled switch', () => {
    const html = render();
    expect(html.match(/内置/g)?.length).toBe(2);
    expect(html).toContain('空间近况、活动与使用统计');
    expect(html).not.toContain('已开启');
  });

  it('keeps the collaborator picker and the save bar', () => {
    const html = render();
    expect(html).toContain('研究助手');
    expect(html).toContain('新建协作者');
    expect(html).toContain('已保存');
    expect(html).toContain('保存');
  });
});
