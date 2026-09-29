# opencode-mempalace

[English](README.md) | 简体中文

MemPalace 的 [OpenCode V2](https://opencode.ai/v2/docs/) 插件——把 [opencode-mempalace-persistence](https://github.com/geco/opencode-mempalace-persistence)（V1 插件）完整对等移植到 V2 插件 API。自动把对话挖矿进 MemPalace 宫殿、按需注入记忆、定期提示模型归档知识图谱事实。

在 Windows（opencode 2.0.19）上开发并实测；暂未发布 npm。

## 功能

- **会话挖矿**——idle/启动时把新对话导出为转录并 `mempalace mine --mode convos` 入档；每项目一个 wing；per-wing 游标 + 消息级去重（`mined_ids`，90 天/20 万条保留）
- **AI 检查点**——每 `saveInterval`（默认 15）条人类消息，提示模型经 MemPalace MCP 工具记录持久事实（diary_write / kg_add / kg_invalidate）
- **记忆注入**（`autoInjectContext`，默认关）——首条消息注入身份；每条消息注入 `mempalace search` 召回结果
- **压缩前抢救**——compaction 丢弃上下文前，注入抢救指令 + 身份 + `mempalace wake-up` 内容
- **可见性**——TUI toast（挖矿/检查点/每次 MemPalace 工具调用）、`/memory-status`、`/memory-log`
- **recall skill**——`mempalace-recall` 技能（问题驱动的搜索先行协议）自动注册
- **历史回填**——`OPENCODE_MEMPALACE_BACKFILL=1` 全量导出会话历史（幂等）
- **V1 状态兼容**——`~/.mempalace/` 状态文件（sync_state/游标/mined_ids）与 V1 插件无缝延续

## 前置条件

- OpenCode V2（实测 2.0.19）
- MemPalace CLI ≥ 3.3.5（`mempalace` 在 PATH，或用 `MEMPALACE_BIN` 指定）
- MemPalace MCP 已配置（模型的 KG 工具调用与 recall skill 依赖它）

## 安装

从 git 仓库安装：

```
opencode plugin add git+https://github.com/zczsyqxl/opencode-mempalace.git
```

然后重启 opencode 服务（`opencode service restart`）。每个 TUI 窗口打开时会立即弹出确认 toast：`opencode-mempalace v0.1.0 connected`。

> 本地开发不走包安装时的后备方案：在项目的 `.opencode/plugins/` 目录放一个 shim 文件：
> ```ts
> export { default } from "file:///D:/myprojects/opencode-mempalace/src/index.ts"
> ```
> 注意：opencode 2.0.19/Windows 上，项目 `plugins:` 配置数组里的本地路径条目实测不加载；上面的 `.opencode/plugins/` 发现式写法才是可用模式。TUI 侧 toast 入口（`./tui`）仅包形式自动加载。

验证加载：`~/.mempalace/hook_state/hook.log` 应出现 `mempalace plugin loaded (...)` 行。

## 配置（全部可选，位于 `~/.mempalace/`）

| 文件/键 | 默认 | 说明 |
|---|---|---|
| `plugin-config.json` → `autoInjectContext` | `false` | 身份 + 召回结果注入每条消息 |
| `plugin-config.json` → `saveInterval` | `15`（最小 5） | 检查点节奏（人类消息数） |
| `plugin-config.json` → `toasts` | `true` | TUI toast（`false` 静默） |
| `identity.txt` | （无则跳过） | 简短自我描述，注入首条消息 |

## 环境变量

| 变量 | 作用 |
|---|---|
| `OPENCODE_MEMPALACE_DEBUG=1` | 调试日志写入 `~/.mempalace/hook_state/debug.log` |
| `OPENCODE_MEMPALACE_BACKFILL=1` | 下次同步全量导出历史会话 |
| `MEMPALACE_BIN` | 覆盖 mempalace CLI 路径 |

## 日志与状态

| 路径 | 内容 |
|---|---|
| `~/.mempalace/hook_state/hook.log` | 加载/挖矿/检查点/压缩事件（错误永远落盘） |
| `~/.mempalace/hook_state/interactions.log` | 每次搜索/工具调用/挖矿的 JSON 行历史（`/memory-log` 数据源，自动轮转） |
| `~/.mempalace/hook_state/debug.log` | 调试日志（`OPENCODE_MEMPALACE_DEBUG=1` 时） |
| `~/.mempalace/sync_state.json` | wing 游标 + `mined_ids` 去重表 |
| `~/.mempalace/oc-sessions/<wing>/` | 待挖矿的导出转录（挖完即清） |

## 命令

- `/memory-status` —— 宫殿健康：wing 游标、已挖条数、积压、最近挖矿日志、`mempalace status` 原文（TUI 中使用）
- `/memory-log [N] [filter]` —— 最新 N 条交互（默认 20），可按 kind 过滤

## 开发

```
npm install
npm test          # vitest（249 项单测）
npm run typecheck
```

开发记录（设计文档、实现计划、集成清单）保存在本地 `docs/` 目录，刻意不入库。
