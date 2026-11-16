/**
 * Migration section: authority-aware direction, explainable preflight and the
 * Chinese job vocabulary.
 *
 * A migration may only run in the direction the current authority allows; a
 * failed preflight must render the Host's message with a way to fix it, and
 * every lossy choice needs its own acknowledgement.
 */
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MigrationSettingsSection } from '../../../src/settings/migration-section';
import type { SpaceMigrationState, SpaceSettingsSnapshot } from '../../../src/client/rpc.js';
import {
  migrationClient,
  migrationPreflight,
  migrationState,
  settingsClient,
  snapshot,
} from './fixtures.js';

const SERVER = 'https://space.example.com';

const localSnapshot = (): SpaceSettingsSnapshot => snapshot();
const serverSnapshot = (): SpaceSettingsSnapshot =>
  snapshot({
    mode: 'server',
    serverUrl: SERVER,
    tokenConfigured: true,
    connection: { state: 'online' },
  });

function renderMigration(
  props: {
    snapshot?: SpaceSettingsSnapshot | null;
    state?: SpaceMigrationState | null;
    onStateChange?: (next: SpaceMigrationState) => void;
    settings?: ReturnType<typeof settingsClient>['client'];
    onGo?: (target: string) => void;
  } = {},
) {
  const harness = migrationClient();
  const view = render(
    createElement(MigrationSettingsSection, {
      client: harness.client,
      snapshot: props.snapshot === undefined ? localSnapshot() : props.snapshot,
      ...(props.settings === undefined ? {} : { settings: props.settings }),
      ...(props.state === undefined
        ? {}
        : {
            state: props.state,
            onStateChange: props.onStateChange ?? vi.fn(),
          }),
      onGo: props.onGo ?? vi.fn(),
    }),
  );
  return { ...view, harness };
}

afterEach(cleanup);

describe('Migration settings section', () => {
  it('offers only local-to-server while the local authority owns the data', async () => {
    renderMigration({ snapshot: localSnapshot() });
    expect(await screen.findByText('本地')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: '把本地数据迁移到服务器' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: '把服务器数据迁回本地' }),
    ).toBeNull();
    expect(screen.getByTestId('migration-direction-hint').textContent).toContain(
      '当前是本地模式，不能从服务端迁回',
    );
  });

  it('offers only server-to-local while the server authority owns the data', async () => {
    renderMigration({ snapshot: serverSnapshot() });
    expect(await screen.findByText(SERVER)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: '把服务器数据迁回本地' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: '把本地数据迁移到服务器' }),
    ).toBeNull();
    expect(screen.getByTestId('migration-direction-hint').textContent).toContain(
      '当前是服务端模式，不能把本地数据迁移到服务器',
    );
  });

  it('renders the preflight message with fix entries when ok is false', async () => {
    const harness = migrationClient({
      preflight: async () =>
        migrationPreflight({
          ok: false,
          message:
            '当前是服务端模式，不能把本地数据迁移到服务器；请先切回本地模式',
        }),
    });
    const onGo = vi.fn();
    render(
      createElement(MigrationSettingsSection, {
        client: harness.client,
        snapshot: localSnapshot(),
        onGo,
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: '把本地数据迁移到服务器' }),
    );
    expect(await screen.findByTestId('preflight-failure')).toBeTruthy();
    expect(
      screen.getByText(
        '当前是服务端模式，不能把本地数据迁移到服务器；请先切回本地模式',
      ),
    ).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: '开始迁移' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '去服务器区' }));
    expect(onGo).toHaveBeenCalledWith('server-url');
    fireEvent.click(screen.getByRole('button', { name: '先切回本地' }));
    expect(onGo).toHaveBeenCalledWith('mode-switch');
  });

  it('expands a second confirmation for a latest-version-only transfer', async () => {
    const harness = migrationClient({
      preflight: async () => migrationPreflight({ ok: true }),
      start: async (input) =>
        migrationState({
          status: 'running',
          direction: input.direction,
          phase: 'preflight',
        }),
    });
    render(
      createElement(MigrationSettingsSection, {
        client: harness.client,
        snapshot: localSnapshot(),
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: '把本地数据迁移到服务器' }),
    );
    const trim = await screen.findByLabelText(/只迁移每篇文档的最新版本/);
    fireEvent.click(trim);
    expect(screen.getByTestId('trim-history-confirm')).toBeTruthy();
    const start = screen.getByRole('button', {
      name: '开始迁移',
    }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(
      screen.getByTestId('migration-start-blocked').textContent,
    ).toContain('需要先确认丢弃历史版本');
    fireEvent.click(screen.getByLabelText(/我确认丢弃历史版本/));
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    await waitFor(() => expect(harness.starts).toHaveLength(1));
    expect(harness.starts[0]).toMatchObject({
      direction: 'to-server',
      trimHistory: true,
    });
  });

  it('renders Chinese phases and the completed counts and backup', async () => {
    const onStateChange = vi.fn();
    const view = renderMigration({
      snapshot: localSnapshot(),
      state: migrationState({
        status: 'running',
        direction: 'to-server',
        phase: 'upload-assets',
        transferredBytes: 42,
        totalBytes: 100,
      }),
      onStateChange,
    });
    expect(screen.getByText(/迁移中 · 本地 → 服务端 · 传输资产 · 42%/)).toBeTruthy();
    expect(screen.getByTestId('migration-running-hint')).toBeTruthy();
    view.rerender(
      createElement(MigrationSettingsSection, {
        client: migrationClient().client,
        snapshot: localSnapshot(),
        state: migrationState({
          status: 'done',
          direction: 'to-server',
          phase: 'done',
          message: '本地数据已迁移到服务端并切换',
          counts: { spaces: 2, nodes: 10, assets: 3 },
          backup: '/data/.migration/server-backup-1',
        }),
        onStateChange,
      }),
    );
    expect(screen.getByTestId('migration-counts').textContent).toContain(
      '空间 2 · 文档 10 · 资产 3',
    );
    expect(screen.getByTestId('migration-backup').textContent).toContain(
      '/data/.migration/server-backup-1',
    );
    expect(screen.getByText('完成 · 本地 → 服务端')).toBeTruthy();
  });

  it('translates each phase the Host reports', () => {
    const labels: [string, string][] = [
      ['preflight', '预检'],
      ['pack-assets', '打包资产'],
      ['freeze', '暂停写入'],
      ['snapshot', '导出快照'],
      ['upload-database', '上传数据库'],
      ['commit', '提交并校验'],
      ['download', '下载快照'],
      ['unpack', '解包'],
      ['verify', '校验数据'],
      ['switch', '切换数据位置'],
      ['cancelled', '已取消'],
      ['failed', '失败'],
    ];
    for (const [phase, label] of labels) {
      cleanup();
      renderMigration({
        snapshot: localSnapshot(),
        state: migrationState({
          status: 'running',
          direction: 'to-server',
          phase,
        }),
        onStateChange: vi.fn(),
      });
      expect(screen.getByText(new RegExp(`· ${label}`))).toBeTruthy();
    }
  });

  it('clears the old preflight panel when the job finishes', async () => {
    const onStateChange = vi.fn();
    const view = renderMigration({
      snapshot: localSnapshot(),
      state: migrationState(),
      onStateChange,
    });
    fireEvent.click(
      screen.getByRole('button', { name: '把本地数据迁移到服务器' }),
    );
    expect(await screen.findByTestId('preflight-panel')).toBeTruthy();
    view.rerender(
      createElement(MigrationSettingsSection, {
        client: migrationClient().client,
        snapshot: localSnapshot(),
        state: migrationState({ status: 'running', direction: 'to-server' }),
        onStateChange,
      }),
    );
    view.rerender(
      createElement(MigrationSettingsSection, {
        client: migrationClient().client,
        snapshot: localSnapshot(),
        state: migrationState({
          status: 'done',
          direction: 'to-server',
          message: '完成',
        }),
        onStateChange,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId('preflight-panel')).toBeNull(),
    );
  });

  it('shows the failure reason and retries the preflight', async () => {
    const harness = migrationClient();
    const onStateChange = vi.fn();
    render(
      createElement(MigrationSettingsSection, {
        client: harness.client,
        snapshot: localSnapshot(),
        state: migrationState({
          status: 'failed',
          direction: 'to-server',
          error: '无法连接 Space 服务端',
        }),
        onStateChange,
      }),
    );
    expect(screen.getByText('无法连接 Space 服务端')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(harness.preflights).toHaveLength(1));
    expect(harness.preflights[0]).toBe('to-server');
  });

  it('locks the direction controls while a migration runs', () => {
    renderMigration({
      snapshot: localSnapshot(),
      state: migrationState({
        status: 'running',
        direction: 'to-server',
        phase: 'freeze',
      }),
      onStateChange: vi.fn(),
    });
    expect(screen.getByTestId('migration-running-hint')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: '把本地数据迁移到服务器' }),
    ).toBeNull();
  });

  it('loads the authority snapshot itself when the page passes none', async () => {
    const settings = settingsClient({ initial: serverSnapshot() });
    render(
      createElement(MigrationSettingsSection, {
        client: migrationClient().client,
        settings: settings.client,
      }),
    );
    expect(await screen.findByText(SERVER)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: '把服务器数据迁回本地' }),
    ).toBeTruthy();
  });
});