/**
 * /memory-status and /memory-log — read-only palace views in the transcript.
 *
 * V1's README described both commands but V1 never implemented them; V2
 * registers them natively via ctx.command.transform (wired in ./index.ts).
 *
 * Split of concerns:
 *   - renderMemoryStatus / renderMemoryLog / parseMemoryLogArgs / commandArgs
 *     are PURE — every input is injected, so they are trivially testable.
 *   - readLastLines / readLines / countPendingFiles are the thin IO half:
 *     best-effort and never throwing, because a status view must not break
 *     the host opencode process any more than a hook may (V1 discipline).
 *
 * Rendering order for /memory-log is V1's "newest last": entries appear in
 * chronological order with the newest at the bottom of the view.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { singleLine, truncate } from "./hooks"
import type { SyncState } from "./state"

/** `/memory-log` entry count when the user passes no N (V1 default). */
export const MEMORY_LOG_DEFAULT_N = 20
/** Upper clamp for the user-supplied N. */
export const MEMORY_LOG_MAX_N = 200
/** How many hook.log tail lines /memory-status shows. */
export const MINE_LOG_TAIL_LINES = 5
/** Per-field cap in the /memory-log compact summary (keeps entries one line). */
const FIELD_VALUE_MAX_CHARS = 120

// ---------------------------------------------------------------------------
// /memory-log — argument parsing
// ---------------------------------------------------------------------------

/**
 * V1 usage `/memory-log [N] [filter]`: a first all-digit token is N (clamped
 * to 1..200); every remaining token forms the filter (spaces preserved).
 * No args → `{ n: 20 }`; a non-numeric first token means the whole input is
 * the filter.
 */
export function parseMemoryLogArgs(argText: string): { n: number; filter?: string } {
  const tokens = argText.trim().split(/\s+/).filter((t) => t !== "")
  if (tokens.length === 0) return { n: MEMORY_LOG_DEFAULT_N }

  let n = MEMORY_LOG_DEFAULT_N
  let rest = tokens
  if (/^\d+$/.test(tokens[0]!)) {
    n = Math.min(MEMORY_LOG_MAX_N, Math.max(1, Number.parseInt(tokens[0]!, 10)))
    rest = tokens.slice(1)
  }
  if (rest.length === 0) return { n }
  return { n, filter: rest.join(" ") }
}

/**
 * Extract the text AFTER the command name from a command prompt. V2 passes
 * the remaining text (e.g. "5 search"); tolerate the full "/memory-log 5
 * search" shape by stripping an optional leading `/<command>` token.
 */
export function commandArgs(promptText: string, command: string): string {
  const trimmed = promptText.trim()
  if (trimmed === "") return ""
  const first = trimmed.split(/\s+/)[0]!
  if (first === `/${command}` || first === command) {
    return trimmed.slice(first.length).trim()
  }
  return trimmed
}

// ---------------------------------------------------------------------------
// /memory-log — rendering (pure)
// ---------------------------------------------------------------------------

/** One parsed interactions.log line: ilog's `{ ts, kind, ...data }` shape. */
interface InteractionEntry {
  ts: string
  kind: string
  fields: Record<string, unknown>
}

/**
 * Parse one interactions.log line. `null` = malformed → skipped: non-JSON,
 * non-object, or missing/unparsable `ts` / non-string `kind` (ilog always
 * writes both, so anything else is corruption, never fatal).
 */
function parseInteractionEntry(line: string): InteractionEntry | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  if (typeof obj.ts !== "string" || typeof obj.kind !== "string") return null
  if (Number.isNaN(new Date(obj.ts).getTime())) return null

  const fields: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (key === "ts" || key === "kind") continue
    fields[key] = value
  }
  return { ts: obj.ts, kind: obj.kind, fields }
}

/**
 * Format a timestamp in LOCAL time (storage stays UTC ISO; only display
 * converts). `offsetMinutes` is the injectable timezone offset for tests,
 * mirroring `Date.prototype.getTimezoneOffset()` semantics (UTC+8 → -480).
 */
export function formatLocalTime(ms: number, offsetMinutes: number = new Date().getTimezoneOffset()): string {
  // getTimezoneOffset() = UTC - local (UTC+8 → -480), so local = UTC - offset.
  const shifted = new Date(ms - offsetMinutes * 60_000)
  return shifted.toISOString().slice(11, 19)
}

/** Same conversion for full datetimes: `YYYY-MM-DD HH:MM:SS` in local time. */
export function formatLocalDateTime(ms: number, offsetMinutes: number = new Date().getTimezoneOffset()): string {
  const shifted = new Date(ms - offsetMinutes * 60_000)
  return shifted.toISOString().slice(0, 19).replace("T", " ")
}

/** `"2026-09-29T01:02:03.456Z"` → local `"01:02:03"` (ts is always UTC ISO from ilog). */
function timeOfDay(ts: string): string {
  return formatLocalTime(new Date(ts).getTime())
}

/** Compact `key=value` pairs, spaces between; strings single-lined, the rest JSON. */
function compactFields(fields: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(fields)) {
    const rendered =
      typeof value === "string" ? singleLine(value) : (JSON.stringify(value) ?? String(value))
    parts.push(`${key}=${truncate(rendered, FIELD_VALUE_MAX_CHARS)}`)
  }
  return parts.join(" ")
}

/**
 * Render the newest `n` interactions from `lines` (the whole interactions.log
 * content — filtering happens BEFORE the tail slice so older matches are not
 * lost). `filter` is a case-insensitive substring match on `kind`. Output is
 * one line per entry, `[HH:MM:SS] kind — k=v k=v`, in V1 "newest last" order.
 */
export function renderMemoryLog(lines: string[], n: number, filter?: string): string {
  const wanted = filter === undefined ? undefined : filter.toLowerCase()
  const entries: InteractionEntry[] = []
  for (const line of lines) {
    const entry = parseInteractionEntry(line)
    if (entry === null) continue
    if (wanted !== undefined && !entry.kind.toLowerCase().includes(wanted)) continue
    entries.push(entry)
  }

  const newest = entries.slice(-Math.max(1, n))
  if (newest.length === 0) {
    return filter === undefined
      ? "No MemPalace interactions recorded yet."
      : `No MemPalace interactions match "${filter}".`
  }
  return newest
    .map((e) => {
      const summary = compactFields(e.fields)
      return summary === "" ? `[${timeOfDay(e.ts)}] ${e.kind}` : `[${timeOfDay(e.ts)}] ${e.kind} — ${summary}`
    })
    .join("\n")
}

// ---------------------------------------------------------------------------
// /memory-status — rendering (pure)
// ---------------------------------------------------------------------------

/** Everything /memory-status shows; gathered by the caller (index.ts). */
export interface MemoryStatusInput {
  /** Export files waiting in syncDir's per-wing subdirectories. */
  pendingFiles: number
  /** Per-wing cursors + mined set (sync_state.json). */
  syncState: SyncState
  /** Newest hook.log lines (mine results), already tailed by the caller. */
  lastMineLog: string[]
  /** `mempalace status` CLI output verbatim; "" when unavailable. */
  palaceStatus: string
}

/**
 * Markdown palace health report: last sync (ISO), per-wing cursor ISOs,
 * mined message count, pending export backlog, the mine-log tail, and the
 * `mempalace status` output verbatim. All inputs injected → pure function.
 */
export function renderMemoryStatus(input: MemoryStatusInput): string {
  const st = input.syncState
  const lines: string[] = []
  const push = (...ls: string[]): void => {
    lines.push(...ls)
  }

  const wingCursorValues = Object.values(st.wings).filter((v) => typeof v === "number")
  const newestSync = wingCursorValues.length > 0 ? Math.max(...wingCursorValues) : 0
  const local = (ms: number): string => (ms > 0 ? formatLocalDateTime(ms) : "never")

  push("## MemPalace Status", "")
  push("_times shown in your local timezone (logs on disk stay UTC)_", "")
  push(`- Last sync (newest wing): ${local(newestSync)}`)
  push(`- Dedup watermark (oldest wing): ${local(st.last_sync_ms)}`)
  push(`- Mined messages: ${Object.keys(st.mined_ids).length}`)
  push(`- Pending export files: ${input.pendingFiles}`)

  push("", "**Wing cursors**")
  const wings = Object.entries(st.wings).sort(([a], [b]) => a.localeCompare(b))
  if (wings.length === 0) push("- (no wings synced yet)")
  for (const [wing, ts] of wings) push(`- ${wing}: ${formatLocalDateTime(ts)}`)

  push("", "**Recent mine log**")
  if (input.lastMineLog.length === 0) push("_no mine log yet_")
  else push("```", ...input.lastMineLog, "```")

  push("", "**mempalace status**")
  if (input.palaceStatus === "") push("_mempalace CLI unavailable_")
  else push("```", input.palaceStatus, "```")

  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// IO helpers (best-effort, never throw)
// ---------------------------------------------------------------------------

/** All non-blank lines of a text file in file order; any failure → []. */
export function readLines(file: string): string[] {
  try {
    return readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l !== "")
  } catch {
    return []
  }
}

/** Newest `n` non-blank lines of a text file, order preserved; failure → []. */
export function readLastLines(file: string, n: number): string[] {
  return readLines(file).slice(-n)
}

/**
 * Count export files waiting under syncDir's per-wing subdirectories (the
 * pipeline writes `syncDir/<wing>/sync_*.txt`). A missing syncDir simply
 * means no backlog → 0.
 */
export function countPendingFiles(syncDir: string): number {
  try {
    let count = 0
    for (const entry of readdirSync(syncDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        count += readdirSync(join(syncDir, entry.name), { withFileTypes: true }).filter((e) => e.isFile()).length
      } catch {
        // One unreadable wing dir must not zero out the others.
      }
    }
    return count
  } catch {
    return 0
  }
}
