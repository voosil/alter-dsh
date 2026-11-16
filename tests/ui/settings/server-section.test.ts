/**
 * Server settings section: authority mode, saved link and the sync queue.
 *
 * Saving in the settings page pre-configures a target server; a real mode
 * change (or a URL change that orphans the local queue) must be acknowledged.
 * The section probes the saved link after saving, offers token clearing and
 * explains why the primary button is unavailable.
 */
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerSettingsSection } from '../../../src/settings/server-section';
import {
  queueEntry,
  settingsClient,
  snapshot,
  TEST_TOKEN,
} from './fixtures.js';

const SERVER = 'https://space.example.com';
const NEW_SERVER = 'https://new.example.com';

const serverSnapshot = snapshot({
  mode: 'server',
  serverUrl: SERVER,
  tokenConfigured: true,
  connection: { state: 'online' },
  capabilities: {
    remoteDirectories: true,
    workspaceMapping: false,
    agentConfigurable: true,
  },
});

async function modeSwitchReady(): Promise<void> {
  await screen.findByRole('group', { name: '空间模式' });
}

afterEach(cleanup);

describe('Server settings section', () => {
  it('saves a URL/token without a mode change, then probes the saved link', async () => {
    let current = snapshot();
    const harness = settingsClient({
      initial: current,
      updated: snapshot({ serverUrl: SERVER, tokenConfigured: true }),
      get: async () => current,
      test: async () => {
        // The Host records a probe of the saved URL + stored token.
        current = snapshot({
          serverUrl: SERVER,
          tokenConfigured: true,
          lastVerifiedAt: '2026-11-12T09:00:00.000Z',
          lastVerifiedVersion: '1.4.2',
        });
        return { ok: true, authenticated: true, serverVersion: '1.4.2' };
      },
    });
    render(createElement(ServerSettingsSection, { client: harness.client }));
    await modeSwitchReady();
    fireEvent.change(screen.getByLabelText('服务器地址'), {
      target: { value: SERVER },
    });
    fireEvent.change(screen.getByLabelText('设备 token'), {
      target: { value: TEST_TOKEN },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存并测试' }));
    await waitFor(() => expect(harness.updates).toHaveLength(1));
    expect(harness.updates[0]).toEqual({
      serverUrl: SERVER,
      token: TEST_TOKEN,
    });
    expect(harness.updates[0]).not.toHaveProperty('mode');
    expect(harness.updates[0]).not.toHaveProperty('discard');
    await waitFor(() => expect(harness.tests).toHaveLength(1));
    expect(harness.tests[0]).toEqual({ serverUrl: SERVER, token: TEST_TOKEN });
    expect(screen.getByText('服务器配置已保存，连接正常')).toBeTruthy();
    // Save + probe re-reads the snapshot, so the Host-recorded verification shows.
    expect(await screen.findByText(/最近验证 .* · v1\.4\.2/)).toBeTruthy();
  });

  it('lets the Host fall back to the stored token when no new token was typed', async () => {
    const harness = settingsClient({
      initial: snapshot({ serverUrl: SERVER, tokenConfigured: true }),
      updated: snapshot({ serverUrl: NEW_SERVER, tokenConfigured: true }),
      test: async () => ({ ok: true }),
    });
    render(createElement(ServerSettingsSection, { client: harness.client }));
    await modeSwitchReady();
    fireEvent.change(screen.getByLabelText('服务器地址'), {
      target: { value: NEW_SERVER },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存并测试' }));
    await waitFor(() => expect(harness.updates).toHaveLength(1));
    expect(harness.updates[0]).toEqual({ serverUrl: NEW_SERVER });
    await waitFor(() => expect(harness.tests).toHaveLength(1));
    expect(harness.tests[0]).toEqual({ serverUrl: NEW_SERVER });
    expect(harness.tests[0]).not.toHaveProperty('token');
  });

  it('requires the discard acknowledgement before switching to the server', async () => {
    const harness = settingsClient({
      initial: snapshot(),
      updated: serverSnapshot,
      test: async () => ({ ok: true }),
    });
    render(createElement(ServerSettingsSection, { client: harness.client }));
    await modeSwitchReady();
    fireEvent.click(screen.getByRole('button', { name: '自部署服务器' }));
    expect(screen.getByTestId('mode-discard-confirm')).toBeTruthy();
    expect(screen.getByText(/切换不会上传本地数据/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('服务器地址'), {
      target: { value: SERVER },
    });
    fireEvent.change(screen.getByLabelText('设备 token'), {
      target: { value: TEST_TOKEN },
    });
    const save = screen.getByRole('button', {
      name: '确认切换',
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/我确认切换到服务端/));
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(harness.updates).toHaveLength(1));
    expect(harness.updates[0]).toEqual({
      mode: 'server',
      discard: true,
      serverUrl: SERVER,
      token: TEST_TOKEN,
    });
    expect(screen.getByText('已切换到服务端模式，连接正常')).toBeTruthy();
  });

  it('requires the acknowledgement before changing the URL with a pending queue', async () => {
    const harness = settingsClient({
      initial: serverSnapshot,
      updated: snapshot({
        ...serverSnapshot,
        serverUrl: NEW_SERVER,
      }),
      queue: [
        queueEntry({ docId: 'doc-1', state: 'pending', entries: 2 }),
      ],
    });
    render(createElement(ServerSettingsSection, { client: harness.client }));
    await screen.findByTestId('sync-queue');
    fireEvent.change(screen.getByLabelText('服务器地址'), {
      target: { value: NEW_SERVER },
    });
    expect(await screen.findByTestId('mode-discard-confirm')).toBeTruthy();
    const save = screen.getByRole('button', {
      name: '保存并测试',
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/我确认更换服务器地址/));
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(harness.updates).toHaveLength(1));
    expect(harness.updates[0]).toEqual({
      serverUrl: NEW_SERVER,
      discard: true,
    });
    expect(harness.updates[0]).not.toHaveProperty('mode');
  });

  it('requires the acknowledgement when switching back to local', async () => {
    const harness = settingsClient({
      initial: serverSnapshot,
      updated: snapshot({ mode: 'local' }),
    });
    render(createElement(ServerSettingsSection, { client: harness.client }));
    await waitFor(() =>
      expect(
        (screen.getByLabelText('服务器地址') as HTMLInputElement).value,
      ).toBe(SERVER),
    );
    fireEvent.click(screen.getByRole('button', { name: '本地' }));
    fireEvent.click(screen.getByLabelText(/我确认切回本地/));
    fireEvent.click(screen.getByRole('button', { name: '确认切换' }));
    await waitFor(() => expect(harness.updates).toHaveLength(1));
    expect(harness.updates[0]).toEqual({ mode: 'local', discard: true });
    expect(harness.tests).toHaveLength(0);
    expect(screen.getByText('已切回本地模式')).toBeTruthy();
  });

  it('shows a queued document title and falls back to the docId', async () => {
    const harness = settingsClient({
      initial: serverSnapshot,
      queue: [
        queueEntry({ docId: 'doc-a', title: '规划稿', state: 'pending' }),
        queueEntry({
          docId: 'doc-b',
          state: 'failed',
          entries: 2,
          lastError: 'HTTP 500',
        }),
      ],
    });
    render(createElement(ServerSettingsSection, { client: harness.client }));
    await screen.findByTestId('sync-queue');
    expect(screen.getByText('规划稿')).toBeTruthy();
    expect(screen.getByText('doc-b')).toBeTruthy();
    expect(screen.getByText(/等待连接/)).toBeTruthy();
    expect(screen.getByText(/提交失败/)).toBeTruthy();
    expect(screen.getByText(/HTTP 500/)).toBeTruthy();
  });

  it('asks for confirmation before discarding one document queue', async () => {
    const harness = settingsClient({
      initial: serverSnapshot,
      queue: [queueEntry({ docId: 'doc-a', title: '规划稿', state: 'failed' })],
    });
    render(createElement(ServerSettingsSection, { client: harness.client }));
    await screen.findByTestId('sync-queue');
    fireEvent.click(screen.getByRole('button', { name: '丢弃本地写入' }));
    expect(harness.resolves).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '确认丢弃' }));
    await waitFor(() => expect(harness.resolves).toHaveLength(1));
    expect(harness.resolves[0]).toEqual({
      docId: 'doc-a',
      action: 'discard',
    });
  });

  it('confirms a bulk discard and resolves every queued document', async () => {
    const harness = settingsClient({
      initial: serverSnapshot,
      queue: [
        queueEntry({ docId: 'doc-a', state: 'failed' }),
        queueEntry({ docId: 'doc-b', state: 'conflict' }),
      ],
    });
    render(createElement(ServerSettingsSection, { client: harness.client }));
    await screen.findByTestId('sync-queue');
    fireEvent.click(screen.getByRole('button', { name: '丢弃全部' }));
    expect(screen.getByTestId('discard-all-confirm')).toBeTruthy();
    expect(harness.resolves).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '确认丢弃' }));
    await waitFor(() => expect(harness.resolves).toHaveLength(2));
    expect(harness.resolves).toEqual([
      { docId: 'doc-a', action: 'discard' },
      { docId: 'doc-b', action: 'discard' },
    ]);
  });

  it('retries all but the writes that are merely waiting for the link', async () => {
    const harness = settingsClient({
      initial: serverSnapshot,
      queue: [
        queueEntry({ docId: 'doc-a', state: 'failed' }),
        queueEntry({ docId: 'doc-b', state: 'conflict' }),
        queueEntry({ docId: 'doc-c', state: 'pending' }),
      ],
    });
    render(createElement(ServerSettingsSection, { client: harness.client }));
    await screen.findByTestId('sync-queue');
    fireEvent.click(screen.getByRole('button', { name: '重试全部' }));
    await waitFor(() => expect(harness.resolves).toHaveLength(2));
    expect(harness.resolves).toEqual([
      { docId: 'doc-a', action: 'retry' },
      { docId: 'doc-b', action: 'retry' },
    ]);
  });

  it('clears a pre-configured token while the authority stays local', async () => {
    const localWithToken = snapshot({
      serverUrl: SERVER,
      tokenConfigured: true,
    });
    const harness = settingsClient({
      initial: localWithToken,
      updated: snapshot({ serverUrl: SERVER, tokenConfigured: false }),
    });
    render(createElement(ServerSettingsSection, { client: harness.client }));
    await screen.findByRole('button', { name: '清除' });
    fireEvent.click(screen.getByRole('button', { name: '清除' }));
    await waitFor(() => expect(harness.updates).toHaveLength(1));
    expect(harness.updates[0]).toEqual({ token: null });
    expect(await screen.findByText('已清除设备 token')).toBeTruthy();
  });

  it('keeps a server-mode token editable but not clearable', async () => {
    const harness = settingsClient({ initial: serverSnapshot });
    render(createElement(ServerSettingsSection, { client: harness.client }));
    await screen.findByTestId('server-token-locked');
    expect(screen.queryByRole('button', { name: '清除' })).toBeNull();
  });

  it('explains why the primary button is unavailable', async () => {
    const harness = settingsClient({ initial: snapshot() });
    render(createElement(ServerSettingsSection, { client: harness.client }));
    await modeSwitchReady();
    fireEvent.click(screen.getByRole('button', { name: '自部署服务器' }));
    expect(await screen.findByText('需要填写服务器地址')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('服务器地址'), {
      target: { value: SERVER },
    });
    expect(await screen.findByText('需要填写设备 token')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('设备 token'), {
      target: { value: TEST_TOKEN },
    });
    expect(await screen.findByText('需要先勾选确认')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/我确认切换到服务端/));
    await waitFor(() =>
      expect(screen.queryByTestId('save-blocked-reason')).toBeNull(),
    );
  });

  it('offers a token fix when the save fails on authorization', async () => {
    const harness = settingsClient({
      initial: snapshot({ serverUrl: SERVER, tokenConfigured: true }),
    });
    harness.client.update = async () => {
      const error = new Error('服务端拒绝了 token') as Error & { code: string };
      error.code = 'remote/unauthorized';
      throw error;
    };
    render(createElement(ServerSettingsSection, { client: harness.client }));
    await waitFor(() =>
      expect(
        (screen.getByLabelText('服务器地址') as HTMLInputElement).value,
      ).toBe(SERVER),
    );
    fireEvent.change(screen.getByLabelText('服务器地址'), {
      target: { value: NEW_SERVER },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存并测试' }));
    expect(
      await screen.findByText('保存失败：服务端拒绝了 token'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '更新 token' }));
    expect(document.activeElement).toBe(screen.getByLabelText('设备 token'));
  });

  it('locks every authority control while a migration runs', async () => {
    const harness = settingsClient({ initial: serverSnapshot });
    render(
      createElement(ServerSettingsSection, {
        client: harness.client,
        snapshot: serverSnapshot,
        onSnapshotChange: vi.fn(),
        migrationRunning: true,
      }),
    );
    expect(screen.getByTestId('server-migration-lock')).toBeTruthy();
    expect(
      (screen.getByLabelText('服务器地址') as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: '本地' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: '保存并测试' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('turns a sync count into a shortcut to the queue', async () => {
    const harness = settingsClient({
      initial: snapshot({
        ...serverSnapshot,
        sync: { pendingWrites: 2, conflicts: 0, failed: 0 },
      }),
      queue: [queueEntry({ docId: 'doc-a', state: 'pending' })],
    });
    render(createElement(ServerSettingsSection, { client: harness.client }));
    const queue = await screen.findByTestId('sync-queue');
    fireEvent.click(screen.getByRole('button', { name: '2 条待同步' }));
    expect(document.activeElement).toBe(queue);
  });

  it('shows saved-but-unverified and then the Host-recorded probe result', async () => {
    let current = snapshot({ serverUrl: SERVER, tokenConfigured: true });
    const harness = settingsClient({
      initial: current,
      get: async () => current,
      test: async () => {
        current = snapshot({
          serverUrl: SERVER,
          tokenConfigured: true,
          lastVerifiedAt: '2026-11-12T09:00:00.000Z',
          lastVerifiedVersion: '1.4.2',
        });
        return { ok: true, authenticated: true, serverVersion: '1.4.2' };
      },
    });
    render(createElement(ServerSettingsSection, { client: harness.client }));
    expect(await screen.findByText('已保存，尚未验证')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() => expect(harness.tests).toHaveLength(1));
    expect(await screen.findByText(/最近验证 \d{2}:\d{2} · v1\.4\.2/)).toBeTruthy();
    expect(screen.getByText(/连接成功/)).toBeTruthy();
  });

  it('shows a probe recorded in the page snapshot', async () => {
    const harness = settingsClient({ initial: serverSnapshot });
    render(
      createElement(ServerSettingsSection, {
        client: harness.client,
        snapshot: snapshot({
          ...serverSnapshot,
          lastVerifiedAt: '2026-11-12T08:00:00.000Z',
          lastVerifiedVersion: '9.9.9',
        }),
        onSnapshotChange: vi.fn(),
      }),
    );
    expect(await screen.findByText(/最近验证 .* · v9\.9\.9/)).toBeTruthy();
  });

  it('returns to unverified when the next snapshot cleared the record', async () => {
    const harness = settingsClient({ initial: serverSnapshot });
    const onSnapshotChange = vi.fn();
    const verified = snapshot({
      ...serverSnapshot,
      lastVerifiedAt: '2026-11-12T08:00:00.000Z',
      lastVerifiedVersion: '9.9.9',
    });
    const view = render(
      createElement(ServerSettingsSection, {
        client: harness.client,
        snapshot: verified,
        onSnapshotChange,
      }),
    );
    expect(await screen.findByText(/最近验证 .* · v9\.9\.9/)).toBeTruthy();
    // A saved URL/token change makes the Host clear the verification.
    view.rerender(
      createElement(ServerSettingsSection, {
        client: harness.client,
        snapshot: snapshot({
          ...serverSnapshot,
          lastVerifiedAt: undefined,
          lastVerifiedVersion: undefined,
        }),
        onSnapshotChange,
      }),
    );
    expect(await screen.findByText('已保存，尚未验证')).toBeTruthy();
  });

  it('keeps the draft when the page pushes a new snapshot', async () => {
    const harness = settingsClient({ initial: snapshot() });
    const onSnapshotChange = vi.fn();
    const view = render(
      createElement(ServerSettingsSection, {
        client: harness.client,
        snapshot: snapshot(),
        onSnapshotChange,
      }),
    );
    await modeSwitchReady();
    const url = screen.getByLabelText('服务器地址') as HTMLInputElement;
    fireEvent.change(url, { target: { value: 'https://draft.example.com' } });
    view.rerender(
      createElement(ServerSettingsSection, {
        client: harness.client,
        snapshot: snapshot({ serverUrl: 'https://polled.example.com' }),
        onSnapshotChange,
      }),
    );
    expect(url.value).toBe('https://draft.example.com');
    expect(harness.getCalls()).toBe(0);
  });
});

