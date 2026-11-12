---
name: space-server-deploy
description: 部署并接通 Space 自部署服务端（Docker + 命名 token），或把已有服务端接入当前 DSH 的 Space 插件。用于用户要求“把空间放到服务器 / 多设备共享空间 / 配置服务端地址和 token”时。
---

# Space 服务端部署与接入

按顺序执行；每一步验证通过再继续。目标：同一套 Space 插件从本地模式切到用户自己的 Space 服务端，
数据可迁移、可备份、可回滚。下面的命令在服务器上的仓库根目录执行（“本机 Docker”就在本机执行）。

## 1. 收集必要信息（一次问清）

- 服务器：客户端最终使用的 URL、SSH 访问方式（或“本机 Docker”）、CPU 架构（x86_64/arm64）。
- 网络：私网（Tailscale/WireGuard）还是公网；公网必须走 TLS 反向代理。
- 数据：是否要把当前本地空间迁移到服务端（是则先备份本地数据目录）。
- token：**不要让用户在对话里贴已有 token**；由服务端生成后通过安全方式交给用户。

## 2. 启动服务端

- 在服务器上取得本仓库，或至少复制 `Dockerfile`、`docker-compose.yml`、`.env.example`。
- `cp .env.example .env`；为每台设备生成独立 token：`openssl rand -hex 32`，按 `<label>=<token>` 填进
  `SPACE_TOKENS`（逗号分隔，每个至少 16 字符）。`.env.example` 的占位值会被服务端拒绝，必须替换。
- `docker compose up -d --build`：compose 自动读取同目录 `.env`，数据卷挂 `/data`，容器内监听
  `0.0.0.0:8787`，健康检查使用 `SPACE_PORT`。
- 验证：`curl -fsS http://127.0.0.1:8787/healthz` 返回 `{"ok":true,...}`；`/version` 的 `product` 为
  `@alter-dsh/space`，`protocolVersion` 与插件一致。
- 环境变量：`SPACE_TOKENS` 必填；`SPACE_DATA_DIR` 默认 `/data`；`SPACE_HOST` 默认 `127.0.0.1`（镜像与
  compose 内为 `0.0.0.0`）；`SPACE_PORT` 默认 `8787`；`SPACE_SNAPSHOTS` 默认 `true`（设为 `false` 关闭每日
  快照，需自行备份）。
- 网络：compose 默认只把端口发布到 loopback；跨设备用 `tailscale serve`（HTTPS + tailnet）或 TLS 反代
  暴露，公网不要直接暴露 8787。
- 数据：`space.db`、`assets/`、`backups/` 都在 `/data`。用命名卷，或把宿主机目录绑定到 `/data`——绑定目录
  必须对容器内 `node` 用户（uid 1000）可写：`sudo chown -R 1000:1000 <dir>`，否则启动即报权限错误。
- 容器内监听 `0.0.0.0`，启动日志打印的 `http://0.0.0.0:8787` 不是客户端地址；客户端填宿主机/反代 URL。

## 3. 配置客户端插件

- 先探测，不落盘：`space_settings action=test, server_url=<URL>, token=<token>`。
- 保存地址/token 但**不切换**模式：`space_settings action=set, server_url=<URL>, token=<token>`
  （不带 `mode`）。该写入需要 DSH 审批，用户拒绝就停止；token 只写不回显、不进对话摘要。
- `space_settings action=get` 确认：`mode` 仍为 `local`、`serverUrl` 已保存、`tokenConfigured=true`。
- 切换会替换数据权威，必须显式：先把本地数据迁移过去（第 4 步）；不迁移则显式放弃本地数据：
  `space_settings action=set, mode=server, server_url=<URL>, token=<token>, discard=true`
  （先确认已备份）。直接 `mode=server` 且不带 `discard` 会被拒绝，不会静默换库。
- 切换后再 `action=get`：`mode=server`、`connection.state=online`、`connection.serverVersion` 与插件兼容；
  `connection.pendingWrites` / `connection.conflicts` 均为 0（队列与冲突计数都在 `connection.*` 下）。
  断网时写入进队列，可在设置页「待同步写入」逐条重试/丢弃，或 `space_settings action=flush` 重试；
  冲突以服务端 revision 为准，不自动覆盖，不要直接清空数据目录。
- 多台设备重复第 3 步，每台设备使用独立 token。

## 4. 迁移本地数据（可选）

- 先备份本地数据目录（`~/.dsh/data/space`；快照在 `backups/`，或退出 DSH 后整目录复制）。
- 设置页「数据迁移」：选「把本地数据迁移到服务器」→ 预检 → 开始迁移。目标非空需显式确认覆盖
  （服务端会先备份），可选只迁移每篇文档的最新版本。失败不改变当前权威。
- Agent 工具等价：`space_migrate action=preflight, direction=to-server` → 用户确认 →
  `space_migrate action=start, direction=to-server`（覆盖加 `overwrite`，只迁最新版本加 `trim_history`）。
- 无 DSH 环境用 CLI（先构建 Host 面；环境变量只加在 `pnpm migrate` 上，不要加在 `pnpm build:host` 前）：
  `pnpm build:host`
  `SPACE_SERVER_URL=<URL> SPACE_TOKEN=<token> pnpm migrate --direction to-server [--overwrite] [--trim-history]`
- 反向迁移用 `--direction from-server`：会覆盖本地，存在未同步写队列时会被拒绝。

## 5. 备份、恢复、升级与回滚

- 每日快照：`<dataDir>/backups/space-YYYYMMDD.db.gz`（有资产时另有 `.assets.tar.gz`），默认保留 3 份；
  只防误删/误改/损坏，不防磁盘故障，需定期复制到外部：
  `docker compose cp space:/data/backups ./space-backups`
- 手工备份：`docker compose stop space` 后整卷/整目录复制，再 `docker compose start space`；运行中不要手工
  移动 `space.db`。
- 恢复（先停服务，再回放快照，恢复后启动验证）：
  `docker compose stop space`
  `docker compose cp ./space-backups/space-YYYYMMDD.db.gz space:/data/restore.db.gz`
  `docker compose run --rm --no-deps --entrypoint sh space -c 'gunzip -c /data/restore.db.gz > /data/space.db && rm -f /data/restore.db.gz /data/space.db-wal /data/space.db-shm'`
  `docker compose run --rm --no-deps --entrypoint node space -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/data/space.db',{readOnly:true});const rows=db.prepare('PRAGMA quick_check').all();process.exit(rows.every((row)=>row.quick_check==='ok')?0:1)"`
  需要图片时再解包资产：`docker compose cp ./space-backups/space-YYYYMMDD.assets.tar.gz space:/data/assets.tar.gz`，
  然后 `docker compose run --rm --no-deps --entrypoint sh space -c 'tar xzf /data/assets.tar.gz -C /data && rm /data/assets.tar.gz'`。
  最后 `docker compose start space`，确认 `/healthz` 与 `space_settings action=get` 在线。
- 升级：先备份；给当前镜像留回滚标签 `docker tag alter-dsh-space-server:local alter-dsh-space-server:rollback`；
  `docker compose build --pull && docker compose up -d`；验证 `/healthz`、`/version` 与
  `space_settings action=get` 的 `connection.serverVersion`。插件侧同步更新安装（见仓库 AGENTS.md）。
- 回滚：`docker compose down`，用回滚镜像启动（临时改 compose 的 `image:` 或回到旧提交重新 build）。若新版本
  已升级数据库 schema，旧版本会拒绝启动，必须同时恢复升级前快照（见“恢复”），再确认在线与队列计数。
- 客户端回退到本地：`space_settings action=set, mode=local, discard=true`（需要显式确认）。切换回本地不会
  删除服务端卷里的数据，但本机看不到服务端侧数据；要保留就先执行「数据迁移 → 服务端 → 本地」。
- 升级/迁移/恢复失败时不要删除数据目录；保留 `.migration/`、`.corrupt-*` 与 `backups/` 供排查。

## 禁止

- 不要用云盘/NAS 同步 `space.db`。
- 不要把 token 写进 URL、日志、提交或聊天记录；`.env` 不入库。
- 不要在未备份时覆盖服务端已有数据。