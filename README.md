# opencode-mempalace

MemPalace 的 [OpenCode V2](https://opencode.ai/v2/docs/) 插件——把 [opencode-mempalace-persistence](https://github.com/geco/opencode-mempalace-persistence)（V1）完整对等移植到 V2 插件 API：自动把对话挖矿进 MemPalace 宫殿、按需注入记忆、定期提示模型归档知识图谱事实。

自用优先（Windows 环境实测），暂不发布 npm。

## 功能

- **会话挖矿**：idle/启动时把新对话导出转录并 `mempalace mine --mode convos` 入档；每项目一个 wing；per-wing 游标 + 消息级去重（`mined_ids`，90 天/20 万条保留）
- **AI 检查点**：每 `saveInterval`（默认 15）条人类消息提示模型经 MemPalace MCP 工具记录（diary_write / kg_add / kg_invalidate）
- **记忆注入**（`autoInjectContext`，默认关）：首条消息注入身份；每条消息 `mempalace search` 注入召回结果
- **压缩前抢救**：compaction 前注入抢救指令 + 身份 + `mempalace wake-up` 内容
- **可见性**：TUI toast（挖矿/检查点/每次 MemPalace 工具调用）、`/memory-status`、`/memory-log`
- **recall skill**：`mempalace-recall` 技能自动注册（问题驱动搜索先行）
- **历史回填**：`OPENCODE_MEMPALACE_BACKFILL=1` 全量导出（幂等）
- **V1 状态兼容**：`~/.mempalace/` 下状态文件（sync_state/游标/mined_ids）与 V1 插件无缝延续

## 前置条件

- OpenCode V2（实测 2.0.19）
- MemPalace CLI ≥ 3.3.5（`mempalace` 在 PATH，或 `MEMPALACE_BIN` 环境变量指定）
- MemPalace MCP 已配置（模型的 KG 工具调用与 recall skill 依赖它）

## 安装（本机实测模式）

本机实测（opencode 2.0.19 / Windows）：项目配置 `plugins:` 数组的本地路径**不加载**；可用的是 `.opencode/plugins/` 自动发现。在你的项目里：

```pwsh
New-Item -ItemType Directory -Force -Path .opencode\plugins | Out-Null
@'
export { default } from "file:///D:/myprojects/opencode-mempalace/src/index.ts"
'@ | Set-Content .opencode\plugins\mempalace.ts -Encoding utf8
```

> 官方文档另有 `plugins: ["..."]` 数组与 npm 包两种加载形式；npm 包（含 `./tui` toast 入口自动加载）是发布后的推荐方式，本机未测。

验证加载：`~/.mempalace/hook_state/hook.log` 出现 `mempalace plugin loaded (...)`。

## 配置（全部可选，`~/.mempalace/`）

| 文件/键 | 默认 | 说明 |
|---|---|---|
| `plugin-config.json` → `autoInjectContext` | `false` | 身份 + 召回结果注入每条消息 |
| `plugin-config.json` → `saveInterval` | `15`（最小 5） | 检查点节奏（人类消息数） |
| `plugin-config.json` → `toasts` | `true` | TUI toast（false 静默） |
| `identity.txt` | （无则跳过） | 你的身份描述，注入首条消息 |

## 环境变量

| 变量 | 作用 |
|---|---|
| `OPENCODE_MEMPALACE_DEBUG=1` | 调试日志写入 `~/.mempalace/hook_state/debug.log` |
| `OPENCODE_MEMPALACE_BACKFILL=1` | 下次同步全量回填历史会话 |
| `MEMPALACE_BIN` | 覆盖 mempalace CLI 路径 |

## 日志与状态

| 路径 | 内容 |
|---|---|
| `~/.mempalace/hook_state/hook.log` | 加载/挖矿/检查点/压缩事件（ERROR 永远落盘） |
| `~/.mempalace/hook_state/interactions.log` | 每次搜索/工具调用/挖矿的 JSON 行历史（`/memory-log` 数据源，自动轮转） |
| `~/.mempalace/hook_state/debug.log` | 调试日志（DEBUG=1 时） |
| `~/.mempalace/sync_state.json` | wing 游标 + mined_ids 去重表 |
| `~/.mempalace/oc-sessions/<wing>/` | 待挖矿的导出转录（挖完即清） |

## 命令

- `/memory-status` — 宫殿健康：wing 游标、mined 数、积压、mine 日志尾、`mempalace status` 原文（TUI 中使用）
- `/memory-log [N] [filter]` — 交互历史尾部 N 条（默认 20），filter 按 kind 过滤

## 开发

```pwsh
npm install
npm test          # vitest（249 单测）
npm run typecheck
```

设计文档：`docs/superpowers/specs/`；实现计划：`docs/superpowers/plans/`；集成验证清单：`docs/test-checklist.md`。
