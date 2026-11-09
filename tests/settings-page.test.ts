/**
 * The Space settings page is owned by the plugin (`src/settings-page.tsx`):
 * it puts the DSH-only storage policy, archived space recovery, the
 * collaborator roster, shortcuts and about on one surface. These tests render
 * it server-side to keep the wiring and the copy contract honest; the data
 * effects (list reads, storage read) only run in a browser.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SpaceService } from '../vendor/protocol/src/index';
import type { SpaceStorageClient } from '../src/storage-client';
import { SpaceSettingsPage } from '../src/settings-page';

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

function render(storage?: SpaceStorageClient) {
  return renderToStaticMarkup(
    createElement(SpaceSettingsPage, {
      service: fakeService,
      storage,
      onBack: () => {},
    }),
  );
}

describe('Space settings page', () => {
  it('puts every settings section on one surface', () => {
    const html = render();
    expect(html).toContain('返回空间');
    expect(html).toContain('>设置<');
    for (const title of [
      '已归档空间',
      '协作者',
      '快捷键',
      '关于',
    ]) {
      expect(html).toContain(title);
    }
    expect(html).toContain('记录随想');
    expect(html).toContain('搜索当前空间');
    expect(html).toContain('⌘');
    expect(html).toContain('Alter 0.1.0');
    expect(html).toContain('保存在本机');
  });

  it('dropped the explanatory copy and the chip-nav of the reused page', () => {
    const html = render();
    expect(html).not.toContain('创建与设置已移到空间详情');
    expect(html).not.toContain('已归档空间不会出现在空间选择器中');
    expect(html).not.toContain('设置项');
    expect(html).not.toContain('归档管理');
    expect(html).not.toContain('WAL');
    expect(html).not.toContain('当前设置：');
  });

  it('renders the storage policy as bounded steppers', () => {
    const html = render(fakeStorage);
    expect(html).toContain('存储与备份');
    expect(html).toContain('版本历史');
    expect(html).toContain('每日快照');
    expect(html).toContain('版/篇');
    expect(html).toContain('aria-label="减少版本历史"');
    expect(html).toContain('aria-label="增加每日快照"');
    expect(html).not.toContain('保存中');
  });

  it('omits the storage section without a storage client', () => {
    expect(render()).not.toContain('存储与备份');
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
    expect(html).toContain('设置');
    expect(html).toContain('快捷键');
    expect(html).not.toContain('设置项');
    expect(html).not.toContain('正在打开空间');
  });
});
