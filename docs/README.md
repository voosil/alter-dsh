# 文档知识库

本目录是 Alter-dsh 的工程知识库。文档的**分类、体量、数量与写作规则**以本文件为唯一事实源；
`AGENTS.md` 只保留入口与硬性约束，不复制这里的规则。其中可机械校验的规则由 `pnpm docs:check` 自动
校验，并在 `pnpm check` 中强制执行；语义规则由评审负责（见「校验边界」）。

## 分类（固定四类，一类一个目录）

| 目录 | 类型 | 回答什么问题 | 权威性 |
| --- | --- | --- | --- |
| `specs/` | 规范 | 当前必须遵守的契约与约束：数据模型、协议、工具契约、架构边界、持久化行为 | **规范**：与代码不一致时修正实现或升版规范 |
| `designs/` | 方案 | 为什么这样设计、方向与取舍、已采纳/已废弃的决策摘要 | 非规范：为 spec 提供理由；冲突时以 spec 为准 |
| `research/` | 调研 | 外部事实、候选方案对比与证据 | 有时效：允许过时；结论被采纳后压缩为摘要并链接 spec/design |
| `acceptance/` | 验收 | 可执行的检查清单与一次性验证记录（含状态） | 记录性：只回答「是否验收、怎么验收」，不描述实现 |

不设 `archive/`：被取代的文档直接删除（git 保留历史），或把结论并入现有文档。

## 体量预算（硬上限，自动校验）

| 角色 | 路径 | 行数上限 | 字节上限 |
| --- | --- | --- | --- |
| Agent 入口 | `AGENTS.md` | 90 | 8 KiB |
| 产品入口 | `README.md` | 120 | 12 KiB |
| 文档总索引 + 规则 | `docs/README.md` | 140 | 10 KiB |
| 分类索引 | `docs/*/README.md` | 60 | 5 KiB |
| 内容文档 | `docs/*/*.md`（非 README） | 300 | 24 KiB |
| 源码目录说明 | `vendor/README.md` | 100 | 12 KiB |

## 数量预算（硬上限，自动校验）

- markdown 只允许出现在 `AGENTS.md`、`README.md`、`docs/**` 与 `vendor/README.md` 这几处；
  仓库根目录只允许 `AGENTS.md`、`README.md` 两个 markdown 文件，其他位置新增 markdown 校验会失败。
- `docs/` 最多 6 个分类目录；当前固定 4 个，新增分类须先改本文件与校验脚本。
- 单个分类目录最多 8 个 markdown 文件（含该目录的 `README.md`）。
- 知识文档（根目录 2 个 + `docs/**/*.md` + `vendor/README.md`）总数最多 24 个。
- 层级固定为 `docs/<分类>/<文档>.md`，不再向下嵌套。

## 校验边界

`pnpm docs:check` **自动校验**的是可机械判定的规则：目录与分类、体量/数量预算、frontmatter、单一 H1、
变更记录式标题、关键文档的代码/缩进代码、全仓 markdown 范围、kebab-case 命名、索引完整性与相对链接/
锚点可解析。写作规则中的语义部分（单一事实源、只写当前有效内容、不写实现与源码说明、时效与合并
判断）**由评审负责**，脚本只能辅助，不能替代。校验脚本自身的回归用例在
`tests/docs-check.test.ts`（`pnpm exec vitest run tests/docs-check.test.ts`）；改动校验规则时同步更新用例。

入口文档还必须满足：`AGENTS.md` 含 `docs/README.md` 引用与 `pnpm docs:check` 命令，`README.md` 链到
`docs/README.md`；frontmatter 的键不得重复。

## 写作规则

1. **只写当前有效内容。** 不写变更历史、日期日志、评审过程、一次性叙事。历史交给 git；
   决策只保留「结论 + 理由（≤3 句）+ 被否方案一句话」。
2. **单一事实源。** 同一事实只在一处定义，其余文档链接它，不复制。spec 是契约的事实源；
   代码与测试是实现的事实源 —— 文档不复述实现。
3. **关键文档只放规则。** `AGENTS.md`、`README.md`、本文件、各分类 `README.md`、`vendor/README.md`
   只写导航、硬性约束、规则与索引，禁止实现细节、逐文件源码说明、变更记录与代码（命令片段除外）。
4. **不写源码说明。** 文档不逐文件/逐函数解释实现，不贴大段源码，不写调试过程；
   规范可含最小契约片段（类型、JSON 信封、表格）。
5. **一个文档一个主题。** 标题即主题；接近预算先拆分，拆分后同步更新索引。
6. **记录性内容有界。** `acceptance/` 记录被再次验收取代或过期时删除或合并；
   `research/` 结论被采纳后压缩为摘要，只保留仍影响决策的证据。
7. **时效性用元数据表达。** 正文不写「最近更新 / 本次调整」；实质修改时更新 frontmatter `updated`。
8. **链接可解析。** 文档间引用用相对路径，不引用已删除的文档或旧文件名。
9. **索引同步。** 新增/删除/重命名文档时，必须在同一变更里更新本文件与该分类的 `README.md`。
10. **命名。** 文件名为 kebab-case 语义化全名，不加日期、序号、状态前缀（版本号属于主题的一部分，如 `-v0`）；
    命名规则由 `pnpm docs:check` 校验。

## 元数据

`docs/**/*.md`（含分类 README，不含本文件）必须以 frontmatter 开头，且**只允许**以下三个键，
顺序不限（示例无注释；照抄示例即可）：

```yaml
---
type: spec
status: active
updated: 2026-11-09
---
```

- `type`：`spec | design | research | acceptance`，必须与所在目录一致。
- `status`：`active | draft`；被取代的文档不允许保留 `superseded`，应删除或并入现有文档。
- `updated`：真实 `YYYY-MM-DD` 日期，仅在实质修改时更新。

## 变更流程

1. 先按上表选分类；一个事实有多个读者时，写进权威分类，其他位置只链接。
2. 新增/删除/重命名 → 更新本文件索引与该分类 `README.md`。
3. 运行 `pnpm docs:check`（只校验文档）与 `pnpm check`（全量）。
4. 关键文档接近预算时，先精简或下沉细节到内容文档，再更新。
5. 行为/契约变化与文档不一致时，同一变更里同时修改代码、测试与 spec。

## 索引

| 分类 | 入口 | 内容 |
| --- | --- | --- |
| 规范 | [specs/README.md](specs/README.md) | 文档模型、Operations、Agent 工具契约、系统架构与持久化边界 |
| 方案 | [designs/README.md](designs/README.md) | 文档内容架构方向、Agent 文档工具方案与决策 |
| 调研 | [research/README.md](research/README.md) | 文档存储格式调研、DSH Agent 创建调研 |
| 验收 | [acceptance/README.md](acceptance/README.md) | 空间↔工作区映射清单、协作者创建验证记录 |
