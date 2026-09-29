/**
 * The three MemPalace log streams, ported from V1 semantics:
 *
 *   debug(msg)            OPENCODE_MEMPALACE_DEBUG-gated → hook_state/debug.log
 *   hook(msg)             always written → hook_state/hook.log
 *   err(msg)              "ERROR: …" into both debug and hook (never silent)
 *   ilog(kind, data)      JSON lines → hook_state/interactions.log (+ rotation)
 *
 * Every write is wrapped in try/catch: logging must never crash the host
 * opencode process, no matter how broken the filesystem is.
 */
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import type { Paths } from "./paths"

/** Cap for interactions.log rotation (approx lines, V1 value). */
export const INTERACTIONS_MAX_LINES = 2000

/** Rotation only kicks in above this size, so the common path stays cheap (V1 value). */
const INTERACTIONS_ROTATE_BYTES = 600 * 1024

export interface Loggers {
  debug(msg: string): void
  hook(msg: string): void
  err(msg: string): void
  ilog(kind: string, data: Record<string, unknown>): void
}

export function makeLoggers(paths: Paths, debug: boolean): Loggers {
  const debugLog = (msg: string): void => {
    if (!debug) return
    try {
      mkdirSync(paths.hookStateDir, { recursive: true })
      appendFileSync(paths.debugLog, `[${new Date().toISOString()}] ${msg}\n`)
    } catch {}
  }

  const hook = (msg: string): void => {
    try {
      mkdirSync(paths.hookStateDir, { recursive: true })
      appendFileSync(paths.hookLog, `[${new Date().toISOString()}] ${msg}\n`)
    } catch {}
  }

  const ilog = (kind: string, data: Record<string, unknown>): void => {
    try {
      mkdirSync(paths.hookStateDir, { recursive: true })
      appendFileSync(
        paths.interactionsLog,
        JSON.stringify({ ts: new Date().toISOString(), kind, ...data }) + "\n",
      )
      // Cheap rotation (V1): count lines only when the file looks big.
      let size = 0
      try {
        size = statSync(paths.interactionsLog).size
      } catch {}
      if (size > INTERACTIONS_ROTATE_BYTES) {
        const lines = readFileSync(paths.interactionsLog, "utf-8").split("\n")
        if (lines.length > INTERACTIONS_MAX_LINES) {
          writeFileSync(paths.interactionsLog, lines.slice(-INTERACTIONS_MAX_LINES).join("\n"))
        }
      }
    } catch {}
  }

  const err = (msg: string): void => {
    debugLog("ERROR: " + msg)
    hook("ERROR: " + msg)
  }

  return { debug: debugLog, hook, err, ilog }
}
