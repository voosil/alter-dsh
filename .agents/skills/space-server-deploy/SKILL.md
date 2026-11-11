---
name: space-server-deploy
description: 部署并接通 Space 自部署服务端（Docker + 命名 token），或把已有服务端接入当前 DSH 的 Space 插件。用于用户要求“把空间放到服务器 / 多设备共享空间 / 配置服务端地址和 token”时。
---

# Space 服务端部署与接入

按顺序执行；每一步验证通过再继续。目标：同一套 Space 插件从本地模式切到用户自己的 Space 服务端，数据可迁移、可回退。

## 1. 收集必要信息（一次问清）

- 服务器：地址、SSH 访问方式（或“本机 Docker”）、CPU 架构（x86_64/arm64）。
- 网络：私网（Tailscale/WireGuard）还是公网；公网必须走 TLS 反向代理。
- 数据：是否要把当前本地空间迁移到服务端（是则先备份本地数据目录）。
- 用户愿意提供的 token：**不要让用户在对话里贴已有 token**；由服务端生成后通过安全方式交给用户/直接写入本机 credentials。

## 2. 启动服务端

- 在服务器上取得本仓库（或 `docker compose` 文件）：`Dockerfile`、`docker-compose.yml`。
- 生成 token：`openssl rand -hex 32`（每个设备一个；记为 `<label>=<token>`）。
- 写 `.env`：`SPACE_TOKENS=laptop=<token>`；`docker compose up -d --build`。
- 验证：`curl -fsS http://127.0.0.1:8787/healthz` 返回 `{"ok":true,...}`；`/version` 的 `product` 为 `@alter-dsh/space`。
- 私网：保持端口只绑 loopback，用 `tailscale serve`（HTTPS + tailnet）或反代暴露；公网：Caddy/Nginx 终止 TLS，不要直接暴露 8787。
- 数据卷挂在 `/data`；确认 `space.db`、`assets/`、`backups/` 落在卷内。

## 3. 配置客户端插件

- 用 `space_settings` 工具：`action=set, mode=server, server_url=<URL>, token=<token>`。
- 该写入需要 DSH 审批；用户拒绝时停止并说明。token 不回显、不写进对话摘要。
- `action=get` 确认 `mode=server`、连接状态 `online`、`serverVersion` 与插件版本兼容；不兼容就升级对应一侧后重试。
- `action=test` 可先探测 URL/token，不保存。
- 多台设备重复第 3 步即可共享同一服务端；每台设备使用独立 token。

## 4. 迁移本地数据（可选）

- 先备份本地 `~/.dsh/data/space`（快照或整目录复制）。
- 使用 Space 迁移 CLI/设置页向导（同一套 `migration.*` RPC）：预检 → 资产预拷贝 → 冻结快照 → 校验 → 切换；失败不改变本地权威。
- 服务端必须为空库，或用户显式确认覆盖并先备份。

## 5. 验证与回退

- 验证：打开空间面板读写一篇文档；`space_settings action=get` 的 `pendingWrites=0`、`conflicts=0`；重启桌面后仍在线。
- 回退：`space_settings action=set, mode=local`；本地库仍在，不丢数据；服务端数据保留在卷里，可再次切换。
- 若出现 `conflicts>0`：保留服务端权威，按冲突提示在编辑器里处理，不要直接清空本地缓存目录。

## 禁止

- 不要用云盘/NAS 同步 `space.db`。
- 不要把 token 写进 URL、日志、提交或聊天记录。
- 不要在未备份时覆盖服务端已有数据。
