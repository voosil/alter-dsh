/**
 * Doubles shared by the settings-page UI tests.
 *
 * These are plain structural implementations of the browser clients declared in
 * `src/client/rpc.ts`: the UI tests never import the Host, so every setting and
 * migration behaviour is exercised through the same seam the panel uses.
 */
import type {
  SpaceMigrationClient,
  SpaceMigrationDirection,
  SpaceMigrationPreflight,
  SpaceMigrationState,
  SpaceRemoteTestResult,
  SpaceSettingsClient,
  SpaceSettingsSnapshot,
  SpaceSyncQueueEntry,
} from '../../../src/client/rpc.js';

/** A fake bearer token used by the form tests (never a real credential). */
export const TEST_TOKEN = ['ui', 'test', 'token'].join('-');

/** Settings snapshot with the local-authority defaults filled in. */
export function snapshot(
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

/** Queue row defaults; `docId`/`state` are what the tests vary. */
export function queueEntry(
  overrides: Partial<SpaceSyncQueueEntry> & { docId: string },
): SpaceSyncQueueEntry {
  return {
    state: 'failed',
    entries: 1,
    baseRevision: 1,
    updatedAt: '2026-11-12T00:00:00.000Z',
    ...overrides,
  };
}

/** Live migration job with the Idle defaults filled in. */
export function migrationState(
  overrides: Partial<SpaceMigrationState> = {},
): SpaceMigrationState {
  return {
    status: 'idle',
    transferredBytes: 0,
    totalBytes: null,
    ...overrides,
  };
}

/** Passing migration preflight with a small local dataset. */
export function migrationPreflight(
  overrides: Partial<SpaceMigrationPreflight> = {},
): SpaceMigrationPreflight {
  return {
    server: { reachable: true, empty: true },
    local: {
      databaseBytes: 1024,
      assetBytes: 2048,
      assetCount: 2,
      hasUserData: true,
    },
    needsOverwrite: false,
    overwriteDropsServerData: false,
    replacesLocal: false,
    ok: true,
    ...overrides,
  };
}

type SettingsPatch = Parameters<SpaceSettingsClient['update']>[0];
type TestInput = Parameters<SpaceSettingsClient['test']>[0];

/** One settings-client double plus the calls it observed. */
export interface SettingsClientHarness {
  client: SpaceSettingsClient;
  updates: SettingsPatch[];
  tests: TestInput[];
  resolves: { docId: string; action: 'retry' | 'discard' }[];
  getCalls(): number;
}

/** Build a settings client whose reads/updates/tests are observable. */
export function settingsClient(options: {
  initial: SpaceSettingsSnapshot;
  /** Snapshot returned by a successful save. */
  updated?: SpaceSettingsSnapshot;
  /** Dynamic read used by polling tests; defaults to `initial`. */
  get?: () => Promise<SpaceSettingsSnapshot>;
  test?: (input: TestInput) => Promise<SpaceRemoteTestResult>;
  queue?: SpaceSyncQueueEntry[];
  resolve?: (
    docId: string,
    action: 'retry' | 'discard',
  ) => Promise<{ resolved: number; state: SpaceSettingsSnapshot }>;
}): SettingsClientHarness {
  const updates: SettingsPatch[] = [];
  const tests: TestInput[] = [];
  const resolves: { docId: string; action: 'retry' | 'discard' }[] = [];
  let getCalls = 0;
  const client: SpaceSettingsClient = {
    get: async () => {
      getCalls += 1;
      return options.get === undefined ? options.initial : options.get();
    },
    update: async (patch) => {
      updates.push(patch);
      return options.updated ?? options.initial;
    },
    test: async (input) => {
      tests.push(input);
      return options.test === undefined ? { ok: true } : options.test(input);
    },
    syncStatus: async () => options.initial,
    syncQueue: async () => options.queue ?? [],
    resolveSync: async (docId, action) => {
      resolves.push({ docId, action });
      return options.resolve === undefined
        ? { resolved: 1, state: options.updated ?? options.initial }
        : options.resolve(docId, action);
    },
    flush: async () => options.initial,
  };
  return {
    client,
    updates,
    tests,
    resolves,
    getCalls: () => getCalls,
  };
}

type MigrationStartInput = Parameters<SpaceMigrationClient['start']>[0];

/** One migration-client double plus the calls it observed. */
export interface MigrationClientHarness {
  client: SpaceMigrationClient;
  preflights: SpaceMigrationDirection[];
  starts: MigrationStartInput[];
  cancels(): number;
}

/** Build a migration client with an idle-by-default job. */
export function migrationClient(options: {
  preflight?: (
    direction: SpaceMigrationDirection,
  ) => Promise<SpaceMigrationPreflight>;
  status?: () => SpaceMigrationState | Promise<SpaceMigrationState>;
  start?: (
    input: MigrationStartInput,
  ) => SpaceMigrationState | Promise<SpaceMigrationState>;
  cancel?: () => SpaceMigrationState | Promise<SpaceMigrationState>;
} = {}): MigrationClientHarness {
  const preflights: SpaceMigrationDirection[] = [];
  const starts: MigrationStartInput[] = [];
  let cancelCalls = 0;
  const client: SpaceMigrationClient = {
    preflight: async (direction) => {
      preflights.push(direction);
      return options.preflight === undefined
        ? migrationPreflight()
        : options.preflight(direction);
    },
    start: async (input) => {
      starts.push(input);
      if (options.start !== undefined) return options.start(input);
      return migrationState({
        status: 'running',
        direction: input.direction,
        phase: 'preflight',
        message: '开始迁移…',
      });
    },
    status: async () => {
      if (options.status === undefined) return migrationState();
      return options.status();
    },
    cancel: async () => {
      cancelCalls += 1;
      if (options.cancel !== undefined) return options.cancel();
      return migrationState({ status: 'cancelled', message: '迁移已取消' });
    },
  };
  return { client, preflights, starts, cancels: () => cancelCalls };
}