# opencode-mempalace

A MemPalace plugin for [OpenCode V2](https://opencode.ai/v2/docs/) — a full parity port of [opencode-mempalace-persistence](https://github.com/geco/opencode-mempalace-persistence) (the V1 plugin) to the V2 plugin API. It automatically mines every conversation into your MemPalace palace, injects memories on demand, and periodically prompts the model to file knowledge-graph facts.

Built and battle-tested on Windows (opencode 2.0.19); not yet published to npm.

## Features

- **Session mining** — on idle/startup, new conversations are exported as transcripts and mined via `mempalace mine --mode convos`. One wing per project; per-wing cursors + message-level dedup (`mined_ids`, 90-day / 200k-entry retention)
- **AI checkpoints** — every `saveInterval` (default 15) human messages, the model is prompted to file durable facts through the MemPalace MCP tools (diary_write / kg_add / kg_invalidate)
- **Memory injection** (`autoInjectContext`, off by default) — identity injected on the first message; `mempalace search` results injected with every message
- **Pre-compaction rescue** — before compaction discards context, injects a rescue instruction + identity + `mempalace wake-up` content
- **Visibility** — TUI toasts (mining / checkpoints / every MemPalace tool call), `/memory-status`, `/memory-log`
- **Recall skill** — the `mempalace-recall` skill (question-driven search-before-answer) is auto-registered
- **History backfill** — `OPENCODE_MEMPALACE_BACKFILL=1` exports the full session history (idempotent)
- **V1 state compatibility** — `~/.mempalace/` state files (sync_state / cursors / mined_ids) carry over seamlessly from the V1 plugin

## Prerequisites

- OpenCode V2 (tested on 2.0.19)
- MemPalace CLI ≥ 3.3.5 (`mempalace` on PATH, or point `MEMPALACE_BIN` at it)
- MemPalace MCP configured (the model's KG tool calls and the recall skill depend on it)

## Install

From a git repository:

```
opencode plugin add git+https://github.com/zczsyqxl/opencode-mempalace.git
```

Then restart the opencode service (`opencode service restart`). Every TUI window confirms the bridge with an immediate toast: `opencode-mempalace v0.1.0 connected`.

> Fallback for local development without the package install: drop a shim file into your project's `.opencode/plugins/` directory:
> ```ts
> export { default } from "file:///D:/myprojects/opencode-mempalace/src/index.ts"
> ```
> Note: on opencode 2.0.19/Windows, local-path entries in a project's `plugins:` config array were not loaded (empirically); the `.opencode/plugins/` discovery above is the working pattern. The TUI-side toast entry (`./tui`) only auto-loads in package form.

Verify loading: `~/.mempalace/hook_state/hook.log` should contain a `mempalace plugin loaded (...)` line.

## Configuration (all optional, under `~/.mempalace/`)

| File / key | Default | Description |
|---|---|---|
| `plugin-config.json` → `autoInjectContext` | `false` | Inject identity + recall results into every message |
| `plugin-config.json` → `saveInterval` | `15` (min 5) | Checkpoint cadence (human messages) |
| `plugin-config.json` → `toasts` | `true` | TUI toasts (`false` silences them) |
| `identity.txt` | (skipped if absent) | A short self-description, injected into the first message |

## Environment variables

| Variable | Effect |
|---|---|
| `OPENCODE_MEMPALACE_DEBUG=1` | Write a debug log to `~/.mempalace/hook_state/debug.log` |
| `OPENCODE_MEMPALACE_BACKFILL=1` | Next sync exports the full session history |
| `MEMPALACE_BIN` | Override the mempalace CLI path |

## Logs & state

| Path | Contents |
|---|---|
| `~/.mempalace/hook_state/hook.log` | Load / mine / checkpoint / compaction events (errors always land here) |
| `~/.mempalace/hook_state/interactions.log` | JSON-lines history of every search / tool call / mine (source of `/memory-log`, auto-rotated) |
| `~/.mempalace/hook_state/debug.log` | Debug log (when `OPENCODE_MEMPALACE_DEBUG=1`) |
| `~/.mempalace/sync_state.json` | Wing cursors + the `mined_ids` dedup table |
| `~/.mempalace/oc-sessions/<wing>/` | Exported transcripts waiting to be mined (cleaned up after mining) |

## Commands

- `/memory-status` — palace health: wing cursors, mined count, backlog, recent mine log, verbatim `mempalace status` output (use inside the TUI)
- `/memory-log [N] [filter]` — the newest N interaction entries (default 20), optionally filtered by kind

## Development

```
npm install
npm test          # vitest (249 unit tests)
npm run typecheck
```

Development records (design spec, implementation plan, integration checklist) are kept locally under `docs/` and are intentionally not part of the repository.
