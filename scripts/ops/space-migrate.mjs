#!/usr/bin/env node
/**
 * CLI migration for the self-hosted Space server.
 *
 * Runs the same transfer the settings wizard and Agent tool use, without DSH:
 *
 *   SPACE_SERVER_URL=... SPACE_TOKEN=... node scripts/ops/space-migrate.mjs \
 *     --direction to-server [--overwrite] [--trim-history]
 *
 *   SPACE_SERVER_URL=... SPACE_TOKEN=... node scripts/ops/space-migrate.mjs \
 *     --direction from-server --overwrite
 *
 * Data directory defaults to `${DSH_HOME:-~/.dsh}/data/space` and can be
 * overridden with `SPACE_DATA_DIR` or `--data-dir`. The command never prompts:
 * replacing data requires the explicit `--overwrite` flag, and `from-server`
 * refuses to run while the plugin still has unsettled writes for that server.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const HELP = `用法：
  SPACE_SERVER_URL=<url> SPACE_TOKEN=<token> node scripts/ops/space-migrate.mjs \\
    --direction to-server|from-server [--overwrite] [--trim-history] [--data-dir <dir>]

方向：
  to-server    本地数据上传并替换服务端数据（服务端非空时需要 --overwrite，服务端会先备份）
  from-server  下载服务端快照并替换本地数据（必须加 --overwrite；会先备份本地库）

选项：
  --overwrite      确认覆盖目标端现有数据（两个方向都必须显式给出）
  --trim-history   只保留每篇文档的最新版本（仅 to-server，会丢历史）
  --data-dir <dir> 覆盖本地数据目录（默认 $SPACE_DATA_DIR 或 ${'$'}{DSH_HOME:-~/.dsh}/data/space）
  -h, --help       显示本帮助

环境变量：
  SPACE_SERVER_URL 服务端地址；SPACE_TOKEN 服务端 bearer token；SPACE_DATA_DIR 本地数据目录

安全：
  from-server 只允许在当前连接配置为服务端模式、且该服务端没有未同步写入时运行，避免覆盖尚未上传的本地编辑。
  Ctrl-C 会中止传输（服务端/本地已写入的迁移包会被清理，目标数据不变）。`;

function parseArgs(argv) {
  const options = {
    direction: 'to-server',
    overwrite: false,
    trimHistory: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--direction') {
      options.direction = argv[index + 1];
      index += 1;
    } else if (arg === '--overwrite') options.overwrite = true;
    else if (arg === '--trim-history') options.trimHistory = true;
    else if (arg === '--data-dir') {
      options.dataDir = argv[index + 1];
      index += 1;
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

/** Normalize a server URL the same way the settings store does. */
function normalizeServerUrl(url) {
  return url.replace(/\/+$/, '');
}

/** Read the local connection choice; missing/!broken files count as local. */
async function readConnectionSettings(dataDir) {
  try {
    const raw = await readFile(join(dataDir, 'connection.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      mode: parsed?.mode === 'server' ? 'server' : 'local',
      serverUrl:
        typeof parsed?.serverUrl === 'string' ? parsed.serverUrl : null,
    };
  } catch {
    return { mode: 'local', serverUrl: null };
  }
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
if (options.help) {
  console.log(HELP);
  process.exit(0);
}
const serverUrl = process.env.SPACE_SERVER_URL;
const token = process.env.SPACE_TOKEN;
if (!serverUrl || !token) {
  console.error('需要 SPACE_SERVER_URL 与 SPACE_TOKEN 环境变量（--help 查看用法）');
  process.exit(2);
}
if (options.direction !== 'to-server' && options.direction !== 'from-server') {
  console.error('--direction 必须是 to-server 或 from-server');
  process.exit(2);
}
const dataDir = resolve(
  options.dataDir ??
    process.env.SPACE_DATA_DIR ??
    join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'data', 'space'),
);

// The host build output lives at <repo>/lib. This script is in <repo>/scripts/ops,
// so the import base is two levels up, not one.
const libBase = new URL('../../lib/', import.meta.url);
let createSpaceMigrationTransfer;
let readRemoteQueueCounts;
try {
  ({ createSpaceMigrationTransfer } = await import(
    new URL('host/control/migration/transfer.js', libBase).href
  ));
  ({ readRemoteQueueCounts } = await import(
    new URL('host/remote/cache.js', libBase).href
  ));
} catch {
  console.error('找不到构建产物；请先运行 `pnpm build:host`');
  process.exit(2);
}

const controller = new AbortController();
process.once('SIGINT', () => {
  console.error('\n收到中断，正在取消迁移…');
  controller.abort();
});

// The write queue/cache is keyed by the normalized server URL the settings
// store uses; a trailing slash would silently look up an empty queue.
const serverIdentity = normalizeServerUrl(serverUrl);
const transfer = createSpaceMigrationTransfer({
  directory: dataDir,
  serverUrl: serverIdentity,
  token,
});

function reportFailure(error) {
  if (controller.signal.aborted) {
    console.error('迁移已取消（目标数据保持不变）');
    process.exit(130);
  }
  console.error(`迁移失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const onProgress = (progress) => {
  const total = progress.totalBytes ?? 0;
  const percent =
    total > 0
      ? ` ${Math.min(100, Math.round((progress.transferredBytes / total) * 100))}%`
      : '';
  process.stderr.write(
    `\r[${progress.phase}]${percent} ${progress.message ?? ''}      `,
  );
};

// Static, local checks run before touching the network so a doomed
// `from-server` fails fast instead of after a full preflight.
if (options.direction === 'from-server') {
  if (!options.overwrite) {
    console.error(
      'from-server 会替换本地数据库与资产；确认覆盖请加 --overwrite（会先备份本地数据到 .migration/）',
    );
    process.exit(2);
  }
  const connection = await readConnectionSettings(dataDir);
  if (connection.mode !== 'server') {
    console.error(
      '当前连接配置不是服务端模式，不能从服务端迁回；请先在设置里切换到该服务端，或确认没有本地权威数据需要保留',
    );
    process.exit(1);
  }
  if (
    connection.serverUrl !== null &&
    normalizeServerUrl(connection.serverUrl) !== serverIdentity
  ) {
    console.error(
      `当前连接配置指向 ${connection.serverUrl}，与 SPACE_SERVER_URL 不一致；请使用同一地址迁移`,
    );
    process.exit(1);
  }
  // Queued writes are unacknowledged user content; replacing the local
  // database would silently lose them.
  const queue = readRemoteQueueCounts(dataDir, serverIdentity);
  const unsettled = queue.pending + queue.conflicts + queue.failed;
  if (unsettled > 0) {
    console.error(
      `该服务端仍有 ${unsettled} 条未同步写入（待同步 ${queue.pending}、冲突 ${queue.conflicts}、失败 ${queue.failed}）；` +
        '请先在设置里恢复连接并处理完写队列后再迁回',
    );
    process.exit(1);
  }
}

try {
  const preflight = await transfer.preflight(options.direction);
  if (!preflight.ok) {
    console.error(`预检失败：${preflight.message ?? '未知错误'}`);
    process.exit(1);
  }
  console.error(
    `本地数据：${(preflight.local.databaseBytes / 1048576).toFixed(1)} MiB 数据库，` +
      `${(preflight.local.assetBytes / 1048576).toFixed(1)} MiB 资产（${preflight.local.assetCount} 个）`,
  );

  if (
    options.direction === 'to-server' &&
    preflight.needsOverwrite &&
    !options.overwrite
  ) {
    console.error('服务端已有数据；确认覆盖请加 --overwrite（服务端会先备份）');
    process.exit(1);
  }

  const result =
    options.direction === 'to-server'
      ? await transfer.toServer({
          overwrite: options.overwrite,
          trimHistory: options.trimHistory,
          onProgress,
          signal: controller.signal,
        })
      : await transfer.fromServer({
          onProgress,
          signal: controller.signal,
        });
  process.stderr.write('\n');
  const printable =
    options.direction === 'to-server'
      ? { counts: result.counts, serverBackup: result.serverBackup }
      : { counts: result.counts, localBackup: result.localBackup };
  console.log(
    JSON.stringify({ ok: true, direction: options.direction, ...printable }, null, 2),
  );
} catch (error) {
  process.stderr.write('\n');
  reportFailure(error);
}
