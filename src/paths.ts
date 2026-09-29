/**
 * Single source of truth for every `~/.mempalace/` file location.
 *
 * Layout is V1-compatible (opencode-mempalace-persistence) so an existing
 * V1 user's state carries over untouched:
 *
 *   <baseDir>/sync_state.json                 per-wing cursors + mined_ids
 *   <baseDir>/plugin-config.json              user configuration
 *   <baseDir>/identity.txt                    palace identity text
 *   <baseDir>/hook_state/opencode_counters.json
 *   <baseDir>/hook_state/hook.log             always-on diagnostic log
 *   <baseDir>/hook_state/interactions.log     structured JSON-line history
 *   <baseDir>/hook_state/oc_sessions.json     known-session registry (new in V2)
 *   <baseDir>/hook_state/debug.log            debug log (V2: under hook_state,
 *                                             NOT /tmp — Windows has no /tmp)
 *   <baseDir>/oc-sessions/                    private export workspace
 *
 * Pure derivation via `join`: no IO, no environment reads, trivially testable.
 */
import { join } from "node:path"

export interface Paths {
  /** Root, normally `~/.mempalace`. */
  baseDir: string
  /** Per-wing sync cursors + mined message IDs (`sync_state.json`). */
  stateFile: string
  /** User plugin configuration (`plugin-config.json`). */
  pluginConfig: string
  /** Palace identity text (`identity.txt`). */
  identityFile: string
  /** Hook scratch directory (`hook_state/`). */
  hookStateDir: string
  /** AI-checkpoint message counters (`hook_state/opencode_counters.json`). */
  countersFile: string
  /** Always-on diagnostic log (`hook_state/hook.log`). */
  hookLog: string
  /** Structured interaction history (`hook_state/interactions.log`). */
  interactionsLog: string
  /** Known-session registry for the discovery chain (`hook_state/oc_sessions.json`). */
  sessionsRegistry: string
  /** Private export workspace (`oc-sessions/`). */
  syncDir: string
  /** Debug-gated log (`hook_state/debug.log`) — the Windows-safe /tmp replacement. */
  debugLog: string
}

export function buildPaths(baseDir: string): Paths {
  const hookStateDir = join(baseDir, "hook_state")
  return {
    baseDir,
    stateFile: join(baseDir, "sync_state.json"),
    pluginConfig: join(baseDir, "plugin-config.json"),
    identityFile: join(baseDir, "identity.txt"),
    hookStateDir,
    countersFile: join(hookStateDir, "opencode_counters.json"),
    hookLog: join(hookStateDir, "hook.log"),
    interactionsLog: join(hookStateDir, "interactions.log"),
    sessionsRegistry: join(hookStateDir, "oc_sessions.json"),
    syncDir: join(baseDir, "oc-sessions"),
    debugLog: join(hookStateDir, "debug.log"),
  }
}
