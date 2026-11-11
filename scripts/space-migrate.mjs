#!/usr/bin/env node
/**
 * CLI migration for the self-hosted Space server.
 *
 * Runs the same transfer the settings wizard and Agent tool use, without DSH:
 *
 *   SPACE_SERVER_URL=... SPACE_TOKEN=... node scripts/space-migrate.mjs \
 *     --direction to-server [--overwrite] [--trim-history]
 *
 * Data directory defaults to `${DSH_HOME:-~/.dsh}/data/space` and can be
 * overridden with `SPACE_DATA_DIR` or `--data-dir`.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const options = { direction: 'to-server', overwrite: false, trimHistory: false };
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

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(`用法：
  SPACE_SERVER_URL=<url> SPACE_TOKEN=<token> node scripts/space-migrate.mjs \\
    --direction to-server|from-server [--overwrite] [--trim-history] [--data-dir <dir>]`);
  process.exit(0);
}
const serverUrl = process.env.SPACE_SERVER_URL;
const token = process.env.SPACE_TOKEN;
if (!serverUrl || !token) {
  console.error('需要 SPACE_SERVER_URL 与 SPACE_TOKEN 环境变量');
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

const modulePath = new URL('../lib/host/control/migration/transfer.js', import.meta.url);
let module;
try {
  module = await import(pathToFileURL(modulePath.pathname).href);
} catch {
  console.error('找不到构建产物；请先运行 `pnpm build:host`');
  process.exit(2);
}
const transfer = module.createSpaceMigrationTransfer({ directory: dataDir, serverUrl, token });

const preflight = await transfer.preflight();
if (!preflight.ok) {
  console.error(`预检失败：${preflight.message ?? '未知错误'}`);
  process.exit(1);
}
console.error(
  `本地数据：${(preflight.local.databaseBytes / 1048576).toFixed(1)} MiB 数据库，` +
    `${(preflight.local.assetBytes / 1048576).toFixed(1)} MiB 资产（${preflight.local.assetCount} 个）`,
);
if (options.direction === 'to-server' && preflight.needsOverwrite && !options.overwrite) {
  console.error('服务端已有数据；确认覆盖请加 --overwrite（服务端会先备份）');
  process.exit(1);
}

const onProgress = (progress) => {
  const total = progress.totalBytes ?? 0;
  const percent =
    total > 0 ? ` ${Math.min(100, Math.round((progress.transferredBytes / total) * 100))}%` : '';
  process.stderr.write(`\r[${progress.phase}]${percent} ${progress.message ?? ''}      `);
};
try {
  const result =
    options.direction === 'to-server'
      ? await transfer.toServer({
          overwrite: options.overwrite,
          trimHistory: options.trimHistory,
          onProgress,
        })
      : await transfer.fromServer({ onProgress });
  process.stderr.write('\n');
  console.log(JSON.stringify({ ok: true, direction: options.direction, ...result }, null, 2));
} catch (error) {
  process.stderr.write('\n');
  console.error(`迁移失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
