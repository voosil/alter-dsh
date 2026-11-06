/** Persistent single-writer authority for Space product data. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Space } from '@alter/protocol';
import type {
  SpaceStore,
  SpaceStoreData,
  SpaceStoreOptions,
} from './contracts.js';

/** 业务数据文件相对数据目录的固定名称。 */
export const SPACE_DATA_FILE = 'space.json';
/** 默认空间由产品内置，首次启动即存在，不可归档或删除。 */
export const DEFAULT_SPACE_ID = 'sp-inbox';
export const DEFAULT_SPACE_NAME = '日常';

const DATA_VERSION = 1;

const ARRAY_FIELDS = [
  'spaces',
  'nodes',
  'thoughts',
  'comments',
  'versions',
  'agents',
  'tasks',
  'events',
  'milestones',
] as const;

function defaultSpace(now: Date): Space {
  return {
    id: DEFAULT_SPACE_ID,
    name: DEFAULT_SPACE_NAME,
    goal: '',
    directories: [],
    collaboratorIds: [],
    isDefault: true,
    order: 0,
    createdAt: now.toISOString(),
    archivedAt: null,
  };
}

/**
 * 首次启动（文件缺失、无法解析或版本不符）时的完整默认数据。
 * 只有默认空间；其余集合与 hub 快照都从空开始，由真实业务逐步写入。
 */
function createDefaultData(now: Date): SpaceStoreData {
  return {
    version: DATA_VERSION,
    spaces: [defaultSpace(now)],
    nodes: [],
    thoughts: [],
    comments: [],
    versions: [],
    agents: [],
    tasks: [],
    events: [],
    milestones: [],
    hub: {},
  };
}

/**
 * 兼容旧数据：版本一致时补齐后来新增的集合字段；版本不符或形状无法辨认
 * 时返回 undefined，由调用方重建默认数据。
 */
function parseData(value: unknown): SpaceStoreData | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== DATA_VERSION) return undefined;
  for (const field of ARRAY_FIELDS) {
    if (!Array.isArray(record[field])) record[field] = [];
  }
  const hub = record.hub;
  if (typeof hub !== 'object' || hub === null || Array.isArray(hub))
    record.hub = {};
  return record as unknown as SpaceStoreData;
}

async function readData(
  file: string,
  now: Date,
): Promise<{ data: SpaceStoreData; fresh: boolean }> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    const data = parseData(parsed);
    if (data) return { data, fresh: false };
  } catch {
    // 文件缺失、不可读或不是合法 JSON 时按首次启动处理。
  }
  return { data: createDefaultData(now), fresh: true };
}

/**
 * Open the Space authority in `directory`.
 *
 * 所有写入都是「改动 + 原子替换」并串行执行：先写临时文件，再 rename 覆盖
 * 正式文件；写入失败时回滚到本次改动前的内存快照并抛出，避免内存与磁盘
 * 状态分叉。`close` 等待已排队的写入结束后关闭，之后的写入直接失败。
 */
export async function openSpaceStore(
  options: SpaceStoreOptions,
): Promise<SpaceStore> {
  const file = join(options.directory, SPACE_DATA_FILE);
  await mkdir(options.directory, { recursive: true });

  async function writeAtomically(data: SpaceStoreData): Promise<void> {
    const temporary = `${file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await rename(temporary, file);
  }

  const loaded = await readData(file, options.now());
  let data = loaded.data;
  if (loaded.fresh) await writeAtomically(data);

  let closed = false;
  let queue: Promise<void> = Promise.resolve();

  function update<T>(change: (data: SpaceStoreData) => T): Promise<T> {
    if (closed) return Promise.reject(new Error('Space 数据已关闭'));
    const run = queue.then(async () => {
      const snapshot = structuredClone(data);
      let result: T;
      try {
        result = change(data);
      } catch (error) {
        data = snapshot;
        throw error;
      }
      try {
        await writeAtomically(data);
      } catch (error) {
        data = snapshot;
        throw error;
      }
      return result;
    });
    // 一次失败不应中断后续排队的写入。
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    read: () => data,
    update,
    async close() {
      closed = true;
      await queue;
    },
  };
}
