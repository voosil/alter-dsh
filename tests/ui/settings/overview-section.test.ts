/**
 * Access overview: the priority ladder and its single next action.
 *
 * The overview is the settings page's answer to "what should I do next?"; its
 * states are ordered by urgency, so each case here pins the copy, the tone and
 * the control the main action moves focus to.
 */
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccessOverviewSection } from '../../../src/settings/overview-section';
import type { SpaceSettingsClient } from '../../../src/client/rpc.js';
import {
  migrationState,
  settingsClient,
  snapshot,
  type SettingsClientHarness,
} from './fixtures.js';

const SERVER = 'https://space.example.com';

function renderOverview(
  snapshotValue: ReturnType<typeof snapshot> | null,
  migrationValue: ReturnType<typeof migrationState> | null = null,
  options: {
    harness?: SettingsClientHarness;
    onGo?: (target: string) => void;
    onAnnounce?: (message: string) => void;
    onRefresh?: () => void | Promise<void>;
  } = {},
) {
  const onGo = options.onGo ?? vi.fn();
  const onRefresh = options.onRefresh ?? vi.fn();
  const harness =
    options.harness ?? settingsClient({ initial: snapshotValue ?? snapshot() });
  const props = {
    snapshot: snapshotValue,
    migration: migrationValue,
    client: harness.client,
    onRefresh,
    onGo,
    onAnnounce: options.onAnnounce ?? vi.fn(),
  };
  const view = render(createElement(AccessOverviewSection, props));
  return { ...view, onGo, onRefresh, harness, props };
}

afterEach(cleanup);

describe('Access overview', () => {
  it('leads with a running migration and opens its progress', () => {
    const { onGo } = renderOverview(
      snapshot(),
      migrationState({
        status: 'running',
        direction: 'to-server',
        phase: 'upload-assets',
        transferredBytes: 42,
        totalBytes: 100,
      }),
    );
    expect(
      screen.getByText('正在把本地数据迁移到服务器 · 42% · 传输资产'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看进度' }));
    expect(onGo).toHaveBeenCalledWith('migration');
  });

  it('names a connection configuration error and points at the token field', () => {
    const { onGo } = renderOverview(
      snapshot({
        mode: 'server',
        serverUrl: SERVER,
        tokenConfigured: true,
        connection: { state: 'error', message: '服务端拒绝了 token' },
      }),
    );
    expect(screen.getByText('连接配置错误：服务端拒绝了 token')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '更新 token' }));
    expect(onGo).toHaveBeenCalledWith('server-token');
  });

  it('reports an offline server with the local queue depth and retries the probe', async () => {
    const harness = settingsClient({
      initial: snapshot({
        mode: 'server',
        serverUrl: SERVER,
        tokenConfigured: true,
        connection: { state: 'offline', message: '无法连接 Space 服务端' },
        sync: { pendingWrites: 3, conflicts: 0, failed: 0 },
      }),
      test: async () => ({ ok: true, serverVersion: '1.4.2' }),
    });
    const onRefresh = vi.fn();
    renderOverview(
      snapshot({
        mode: 'server',
        serverUrl: SERVER,
        tokenConfigured: true,
        connection: { state: 'offline', message: '无法连接 Space 服务端' },
        sync: { pendingWrites: 3, conflicts: 0, failed: 0 },
      }),
      null,
      { harness, onRefresh },
    );
    expect(
      screen.getByText('服务端离线，编辑先保存在本机（3 条待同步）'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试连接' }));
    await waitFor(() => expect(harness.tests).toHaveLength(1));
    expect(harness.tests[0]).toEqual({ serverUrl: SERVER });
    // The Host records the probe; the overview asks for a fresh snapshot.
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
  });

  it('sends unsettled writes to the sync queue', () => {
    const { onGo } = renderOverview(
      snapshot({
        mode: 'server',
        serverUrl: SERVER,
        tokenConfigured: true,
        connection: { state: 'online' },
        sync: { pendingWrites: 0, conflicts: 1, failed: 2 },
      }),
    );
    expect(screen.getByText('3 篇文档的修改需要处理')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '处理待同步写入' }));
    expect(onGo).toHaveBeenCalledWith('sync-queue');
  });

  it('shows the connected host and the last sync time', () => {
    const { onGo } = renderOverview(
      snapshot({
        mode: 'server',
        serverUrl: SERVER,
        tokenConfigured: true,
        connection: { state: 'online' },
        sync: {
          pendingWrites: 0,
          conflicts: 0,
          failed: 0,
          lastSyncedAt: '2026-11-12T08:00:00.000Z',
        },
      }),
    );
    expect(screen.getByText(/已连接 space\.example\.com/)).toBeTruthy();
    expect(screen.getByText(/上次同步/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '管理连接' }));
    expect(onGo).toHaveBeenCalledWith('server-url');
  });

  it('offers the server setup while the local authority has no target', () => {
    const { onGo } = renderOverview(snapshot());
    expect(
      screen.getByText('使用本地数据。想在多设备共享？可连接自部署服务器'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '配置服务器' }));
    expect(onGo).toHaveBeenCalledWith('server-url');
  });

  it('tests a saved but unverified address and asks for a fresh snapshot', async () => {
    const harness = settingsClient({
      initial: snapshot({ serverUrl: SERVER, tokenConfigured: true }),
      test: async () => ({ ok: true, authenticated: true, serverVersion: '1.4.2' }),
    });
    const onRefresh = vi.fn();
    renderOverview(snapshot({ serverUrl: SERVER, tokenConfigured: true }), null, {
      harness,
      onRefresh,
    });
    expect(screen.getByText('已保存服务器地址，尚未验证')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() => expect(harness.tests).toHaveLength(1));
    expect(harness.tests[0]).toEqual({ serverUrl: SERVER });
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
  });

  it('turns Host verification metadata into the migrate action', () => {
    const { onGo } = renderOverview(
      snapshot({
        serverUrl: SERVER,
        lastVerifiedAt: '2026-11-12T08:00:00.000Z',
        lastVerifiedVersion: '1.4.2',
      }),
    );
    expect(
      screen.getByText('space.example.com 可用；本地数据还没有迁过去'),
    ).toBeTruthy();
    expect(screen.getByText(/最近验证 .* · v1\.4\.2/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '迁移到服务器' }));
    expect(onGo).toHaveBeenCalledWith('migration');
    fireEvent.click(screen.getByRole('button', { name: '切换并放弃本地' }));
    expect(onGo).toHaveBeenCalledWith('mode-switch');
  });

  it('falls back to unverified when a target change cleared the metadata', () => {
    const verified = snapshot({
      serverUrl: SERVER,
      lastVerifiedAt: '2026-11-12T08:00:00.000Z',
    });
    const view = renderOverview(verified);
    expect(
      screen.getByText('space.example.com 可用；本地数据还没有迁过去'),
    ).toBeTruthy();
    view.rerender(
      createElement(AccessOverviewSection, {
        ...view.props,
        snapshot: snapshot({ serverUrl: SERVER, tokenConfigured: true }),
      }),
    );
    expect(screen.getByText('已保存服务器地址，尚未验证')).toBeTruthy();
  });

  it('announces a status transition through the page live region', () => {
    const onAnnounce = vi.fn();
    const local = snapshot();
    const view = renderOverview(local, null, { onAnnounce });
    view.rerender(
      createElement(AccessOverviewSection, {
        ...view.props,
        snapshot: snapshot({
          mode: 'server',
          serverUrl: SERVER,
          tokenConfigured: true,
          connection: { state: 'offline' },
        }),
      }),
    );
    expect(onAnnounce).toHaveBeenCalledWith(
      '服务端离线，编辑先保存在本机（0 条待同步）',
    );
  });

  it('never probes without a settings client', () => {
    const onGo = vi.fn();
    render(
      createElement(AccessOverviewSection, {
        snapshot: snapshot({ serverUrl: SERVER }),
        migration: null,
        client: undefined as SpaceSettingsClient | undefined,
        onRefresh: vi.fn(),
        onGo,
        onAnnounce: vi.fn(),
      }),
    );
    const button = screen.getByRole('button', { name: '测试连接' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});