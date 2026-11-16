/**
 * Settings page runtime wiring: one shared authority snapshot.
 *
 * The page reads the settings snapshot once, polls it, and hands the same value
 * to the overview, the server section and the about row. The sections must not
 * start their own reads, and the 5 s poll must never overwrite a draft the user
 * is editing.
 */
import { createElement } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpaceSettingsPage } from '../../../src/settings/page';
import type { SpaceService } from '../../../vendor/protocol/src/index';
import {
  migrationClient,
  migrationState,
  settingsClient,
  snapshot,
} from './fixtures.js';

const SERVER = 'https://space.example.com';

const fakeService = {
  listAgents: async () => [],
  listArchivedSpaces: async () => [],
  unarchiveSpace: async () => {
    throw new Error('not called');
  },
} as unknown as SpaceService;

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

function renderPage(settings: ReturnType<typeof settingsClient>) {
  const migration = migrationClient({ status: () => migrationState() });
  return render(
    createElement(SpaceSettingsPage, {
      service: fakeService,
      settings: settings.client,
      migration: migration.client,
      onBack: () => undefined,
    }),
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Space settings page snapshot wiring', () => {
  it('reads one shared snapshot and shows it in the overview and about row', async () => {
    vi.useFakeTimers();
    const harness = settingsClient({ initial: serverSnapshot });
    renderPage(harness);
    await flush();
    expect(harness.getCalls()).toBe(1);
    expect(screen.getByTestId('access-overview').getAttribute('data-state')).toBe(
      'online',
    );
    expect(screen.getByTestId('about-data-location').textContent).toBe(
      `保存在 ${SERVER}`,
    );
    // The server section renders from the page snapshot instead of reading again.
    expect(screen.getByTestId('connection-status').textContent).toContain(
      '已连接服务端',
    );
    expect(harness.getCalls()).toBe(1);
  });

  it('polls the snapshot and announces a changed state', async () => {
    vi.useFakeTimers();
    let current = serverSnapshot;
    const harness = settingsClient({
      initial: current,
      get: async () => current,
    });
    renderPage(harness);
    await flush();
    expect(screen.getByTestId('access-overview').getAttribute('data-state')).toBe(
      'online',
    );
    current = snapshot({
      mode: 'server',
      serverUrl: SERVER,
      tokenConfigured: true,
      connection: { state: 'offline', message: '无法连接 Space 服务端' },
      sync: { pendingWrites: 3, conflicts: 0, failed: 0 },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(harness.getCalls()).toBe(2);
    expect(screen.getByTestId('access-overview').getAttribute('data-state')).toBe(
      'offline',
    );
    expect(screen.getByTestId('settings-announcement').textContent).toContain(
      '服务端离线',
    );
  });

  it('moves from saved-unverified to verified after a Host-recorded probe', async () => {
    vi.useFakeTimers();
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
    renderPage(harness);
    await flush();
    expect(screen.getByTestId('access-overview').getAttribute('data-state')).toBe(
      'local-saved',
    );
    fireEvent.click(
      within(screen.getByTestId('access-overview')).getByRole('button', {
        name: '测试连接',
      }),
    );
    // Flush the probe promise and the refresh it triggers.
    await flush();
    await flush();
    expect(screen.getByTestId('access-overview').getAttribute('data-state')).toBe(
      'local-verified',
    );
    expect(screen.getByTestId('settings-announcement').textContent).toContain(
      '可用',
    );
  });

  it('keeps the server-section draft across a snapshot poll', async () => {
    vi.useFakeTimers();
    let current = snapshot({ serverUrl: SERVER, tokenConfigured: true });
    const harness = settingsClient({ initial: current, get: async () => current });
    renderPage(harness);
    await flush();
    const url = screen.getByLabelText('服务器地址') as HTMLInputElement;
    fireEvent.change(url, { target: { value: 'https://draft.example.com' } });
    current = snapshot({ serverUrl: 'https://polled.example.com' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(harness.getCalls()).toBe(2);
    expect(url.value).toBe('https://draft.example.com');
  });
});