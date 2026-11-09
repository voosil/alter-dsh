/**
 * The Settings page is reused from the upstream Alter client package; this
 * test keeps the DSH port wired to it without a browser: the page must
 * server-render the collaborator section and its creation form from a
 * `SpaceService`, and must not depend on the optional Workbench capability.
 *
 * `useEffect` data fetching does not run during server rendering, so the fake
 * service only needs to satisfy the type surface.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SpaceService } from '../vendor/protocol/src/index';
import type { SpaceStorageClient } from '../src/storage-client';
import { SettingsPage } from '../vendor/ui-settings/src/SettingsPage';

const fakeEstimate = {
  documentCount: 3,
  averageDocumentBytes: 2048,
  currentBytes: 1024,
  currentMainBytes: 1024,
  currentSnapshotBytes: 0,
  currentWalBytes: 0,
  projectedBytes: 4096,
  projectedMainBytes: 4096,
  projectedSnapshotBytes: 0,
  deltaBytes: 3072,
};

const fakeStorage = {
  get: async () => ({
    settings: { historyLimit: 10, snapshotKeep: 3 },
    estimate: fakeEstimate,
  }),
  estimate: async () => fakeEstimate,
  set: async () => ({
    settings: { historyLimit: 10, snapshotKeep: 3 },
    estimate: fakeEstimate,
  }),
} as unknown as SpaceStorageClient;

const fakeService = {
  listAgents: async () => [],
  listArchivedSpaces: async () => [],
  unarchiveSpace: async () => {
    throw new Error('not called during server rendering');
  },
} as unknown as SpaceService;

describe('Space settings page', () => {
  it('lists collaborators and points creation to the space config page', () => {
    const html = renderToStaticMarkup(
      createElement(SettingsPage, { service: fakeService }),
    );
    expect(html).toContain('AI 协作者');
    expect(html).toContain('创建与设置已移到空间详情');
    expect(html).toContain('还没有 AI 协作者');
    expect(html).not.toContain('placeholder="例如：研究助手"');
    expect(html).not.toContain('创建协作者');
    expect(html).toContain('归档管理');
    expect(html).toContain('快捷键');
    expect(html).toContain('关于');
  });

  it('omits the Workbench-only link preference without a controller', () => {
    const html = renderToStaticMarkup(
      createElement(SettingsPage, { service: fakeService }),
    );
    expect(html).not.toContain('网页链接');
  });
});

describe('Space panel shell', () => {
  const router = {
    getPath: () => '#/settings',
    subscribe: () => () => {},
    navigate: () => {},
  };

  it('routes #/settings to the settings page with a way back', async () => {
    const { SpaceShell } = await import('../src/space-shell');
    const html = renderToStaticMarkup(
      createElement(SpaceShell, { service: fakeService, router }),
    );
    expect(html).toContain('返回空间');
    expect(html).toContain('AI 协作者');
    expect(html).not.toContain('placeholder="例如：研究助手"');
    expect(html).not.toContain('正在打开空间');
  });

  it('renders the storage policy section under the settings page', async () => {
    const { SpaceShell } = await import('../src/space-shell');
    const html = renderToStaticMarkup(
      createElement(SpaceShell, {
        service: fakeService,
        router,
        storage: fakeStorage,
      }),
    );
    expect(html).toContain('存储与备份');
    expect(html).toContain('版本历史上限（每篇文档）');
    expect(html).toContain('每日快照保留');
    expect(html).toContain('保存设置');
    expect(html).not.toContain('保存中');
  });
});
