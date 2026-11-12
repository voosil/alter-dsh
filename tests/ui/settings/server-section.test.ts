/**
 * Server settings section: the authority mode must never flip silently.
 *
 * Saving a URL/token only pre-configures the target server (so a later
 * migration can use it); a real mode change has to be acknowledged with the
 * discard checkbox and is sent with `discard: true`. The Host rejects a bare
 * flip, so the UI must not produce one.
 */
import { createElement } from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ServerSettingsSection } from '../../../src/settings/server-section';
import type {
  SpaceSettingsClient,
  SpaceSettingsSnapshot,
  SpaceSyncQueueEntry,
} from '../../../src/client/rpc.js';

type SettingsPatch = Parameters<SpaceSettingsClient['update']>[0];

function snapshot(
  overrides: Partial<SpaceSettingsSnapshot> = {},
): SpaceSettingsSnapshot {
  return {
    mode: 'local',
    serverUrl: null,
    tokenConfigured: false,
    updatedAt: '2026-11-12T00:00:00.000Z',
    connection: { state: 'local' },
    capabilities: {
      remoteDirectories: false,
      workspaceMapping: true,
      agentConfigurable: true,
    },
    sync: { pendingWrites: 0, conflicts: 0, failed: 0 },
    ...overrides,
  };
}

function fakeClient(
  initial: SpaceSettingsSnapshot,
  next: SpaceSettingsSnapshot,
  queue: SpaceSyncQueueEntry[] = [],
): { client: SpaceSettingsClient; updates: SettingsPatch[] } {
  const updates: SettingsPatch[] = [];
  const client: SpaceSettingsClient = {
    get: async () => initial,
    update: async (patch) => {
      updates.push(patch);
      return next;
    },
    test: async () => ({ ok: true }),
    syncStatus: async () => initial,
    syncQueue: async () => queue,
    resolveSync: async () => ({ resolved: 0, state: initial }),
    flush: async () => initial,
  };
  return { client, updates };
}

async function ready(): Promise<void> {
  await screen.findByRole('group', { name: '空间模式' });
}

afterEach(cleanup);

describe('Server settings section', () => {
  it('saves a URL/token without sending a mode change', async () => {
    const { client, updates } = fakeClient(
      snapshot(),
      snapshot({
        serverUrl: 'https://space.example.com',
        tokenConfigured: true,
      }),
    );
    render(createElement(ServerSettingsSection, { client }));
    await ready();
    fireEvent.change(screen.getByLabelText('服务器地址'), {
      target: { value: 'https://space.example.com' },
    });
    fireEvent.change(screen.getByLabelText('设备 token'), {
      target: { value: 'paste-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toEqual({
      serverUrl: 'https://space.example.com',
      token: 'paste-token',
    });
    expect(updates[0]).not.toHaveProperty('mode');
    expect(updates[0]).not.toHaveProperty('discard');
    expect(screen.getByText('服务器配置已保存')).toBeTruthy();
  });

  it('requires the discard acknowledgement before switching to the server', async () => {
    const { client, updates } = fakeClient(
      snapshot(),
      snapshot({
        mode: 'server',
        serverUrl: 'https://space.example.com',
        tokenConfigured: true,
        connection: { state: 'online' },
        capabilities: {
          remoteDirectories: true,
          workspaceMapping: false,
          agentConfigurable: true,
        },
      }),
    );
    render(createElement(ServerSettingsSection, { client }));
    await ready();
    fireEvent.click(screen.getByRole('button', { name: '自部署服务器' }));
    expect(screen.getByTestId('mode-discard-confirm')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('服务器地址'), {
      target: { value: 'https://space.example.com' },
    });
    fireEvent.change(screen.getByLabelText('设备 token'), {
      target: { value: 'paste-token' },
    });
    const save = screen.getByRole('button', {
      name: '确认切换',
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/我确认切换到服务端/));
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toEqual({
      mode: 'server',
      discard: true,
      serverUrl: 'https://space.example.com',
      token: 'paste-token',
    });
    expect(screen.getByText('已切换到服务端模式')).toBeTruthy();
  });

  it('requires the acknowledgement before changing the URL with a pending queue', async () => {
    const server = snapshot({
      mode: 'server',
      serverUrl: 'https://space.example.com',
      tokenConfigured: true,
      connection: { state: 'online' },
    });
    const { client, updates } = fakeClient(
      server,
      snapshot({ ...server, serverUrl: 'https://new.example.com' }),
      [
        {
          docId: 'doc-1',
          state: 'pending',
          entries: 2,
          baseRevision: 3,
          updatedAt: '2026-11-12T00:00:00.000Z',
        },
      ],
    );
    render(createElement(ServerSettingsSection, { client }));
    await ready();
    fireEvent.change(screen.getByLabelText('服务器地址'), {
      target: { value: 'https://new.example.com' },
    });
    expect(await screen.findByTestId('mode-discard-confirm')).toBeTruthy();
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/我确认更换服务器地址/));
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toEqual({
      serverUrl: 'https://new.example.com',
      discard: true,
    });
    expect(updates[0]).not.toHaveProperty('mode');
  });

  it('requires the acknowledgement when switching back to local', async () => {
    const { client, updates } = fakeClient(
      snapshot({
        mode: 'server',
        serverUrl: 'https://space.example.com',
        tokenConfigured: true,
        connection: { state: 'online' },
      }),
      snapshot({ mode: 'local' }),
    );
    render(createElement(ServerSettingsSection, { client }));
    await ready();
    fireEvent.click(screen.getByRole('button', { name: '本地' }));
    fireEvent.click(screen.getByLabelText(/我确认切回本地/));
    fireEvent.click(screen.getByRole('button', { name: '确认切换' }));
    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toEqual({ mode: 'local', discard: true });
    expect(screen.getByText('已切回本地模式')).toBeTruthy();
  });
});
