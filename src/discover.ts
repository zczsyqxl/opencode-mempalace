/**
 * Session discovery for the sync engine (V2 replacement for V1's SQL query).
 *
 * Three-layer degradation chain (design §6.1, resolved by the Task 1 probe):
 *
 *   1. Registry (`hook_state/oc_sessions.json`) — the prompt hook records
 *      every session it sees; always available, always consulted.
 *   2. `ctx.session.list` — UNAVAILABLE in the plugin context (probe A1:
 *      `typeof === "undefined"`), so this layer is dropped entirely.
 *   3. `node:sqlite` read-only scan of opencode's own `session_v2` table
 *      (probe A2: available under Bun 1.4.2) — catches sessions from other
 *      opencode instances this plugin never saw a prompt for. Only the
 *      discovery columns are SELECTed; message content is never touched.
 *
 * If both fallbacks are unavailable, discovery degrades to registry-only
 * (and backfill degrades with it, per the design).
 *
 * The sqlite opener is injectable so tests never need a real database; the
 * default opener resolves `node:sqlite` via dynamic import so environments
 * without it still load this module.
 */
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ExportMessage } from "./export"
import type { Paths } from "./paths"
import { readSessions, readSyncState } from "./state"

/** One session the sync engine should consider exporting. */
export interface Candidate {
  sessionID: string
  /** Working directory — mapped to a wing by `wingFor`. */
  directory: string
  /** Session title, when any source knows one. */
  title?: string
}

/** Minimal read-only view of a sqlite connection the discovery chain needs. */
export interface SqliteDb {
  /** Run a SELECT and return every row. */
  query(sql: string): unknown[]
  /** Release the connection. */
  close(): void
}

/** Open a sqlite database read-only, or return null when impossible. */
export type SqliteOpener = (dbPath: string) => SqliteDb | null | Promise<SqliteDb | null>;

/** Injectable discovery dependencies; every field optional. */
export interface DiscoverDeps {
  /**
   * sqlite opener override. `() => null` disables the sqlite layer entirely;
   * a throwing opener degrades to registry-only without crashing.
   */
  openSqlite?: SqliteOpener
  /** Database path override (default: opencode's canonical DB location). */
  dbPath?: string
  /** Include every sqlite row regardless of `time_updated` (BACKFILL=1). */
  backfill?: boolean
}

/** opencode's own session database (XDG-style location, Windows included). */
export function defaultDbPath(): string {
  return join(homedir(), ".local", "share", "opencode", "opencode.db")
}

/** The only columns discovery ever reads from `session_v2`. */
const DISCOVERY_SQL = "SELECT id, directory, title, time_updated FROM session_v2"

/**
 * Map the REAL `ctx.session.context()` result (Task 1 probe A3 — a FLAT
 * message array, no nested `info` objects) to `ExportMessage[]`:
 *
 *   user       → { id, role: "user", text: <text field verbatim>,
 *                  ts: time.created, complete: true }
 *   assistant  → { id, role: "assistant", text: content[].text parts joined
 *                  with "\n" (non-text parts ignored), ts: time.created,
 *                  complete: time.completed OR finish present (probe A3:
 *                  both are set on finished replies; a streaming reply has
 *                  neither) }
 *   everything else (the trailing `{type:"idle"}` markers, tool/system/…
 *   entries) is dropped.
 *
 * Total function: garbage elements are skipped, non-array input yields [].
 */
export function toExportMessages(raw: unknown): ExportMessage[] {
  if (!Array.isArray(raw)) return []
  const out: ExportMessage[] = []
  for (const element of raw) {
    if (typeof element !== "object" || element === null) continue
    const m = element as Record<string, unknown>
    if (m.type !== "user" && m.type !== "assistant") continue
    if (typeof m.id !== "string" || m.id === "") continue

    const time = typeof m.time === "object" && m.time !== null ? (m.time as Record<string, unknown>) : {}
    const created = time.created
    const ts = typeof created === "number" && Number.isFinite(created) ? created : 0

    let text = ""
    let complete = true
    if (m.type === "user") {
      if (typeof m.text === "string") text = m.text
    } else {
      if (Array.isArray(m.content)) {
        const parts: string[] = []
        for (const part of m.content) {
          if (typeof part !== "object" || part === null) continue
          const p = part as Record<string, unknown>
          if (p.type === "text" && typeof p.text === "string") parts.push(p.text)
        }
        text = parts.join("\n")
      }
      const completed = time.completed
      complete =
        (typeof completed === "number" && Number.isFinite(completed)) || typeof m.finish === "string"
    }
    out.push({ id: m.id, role: m.type, text, ts, complete })
  }
  return out
}

/** Narrow one `session_v2` row defensively; anything malformed → null. */
function parseRow(row: unknown): { id: string; directory: string | null; title: string | null; time_updated: number } | null {
  if (typeof row !== "object" || row === null) return null
  const r = row as Record<string, unknown>
  if (typeof r.id !== "string" || r.id === "") return null
  if (typeof r.time_updated !== "number" || !Number.isFinite(r.time_updated)) return null
  const directory = typeof r.directory === "string" ? r.directory : null
  const title = typeof r.title === "string" && r.title !== "" ? r.title : null
  return { id: r.id, directory, title, time_updated: r.time_updated }
}

/**
 * Real opener used by the index.ts wiring: READ-ONLY `node:sqlite`
 * connection (WAL mode makes concurrent reads with a running opencode
 * safe). Dynamic import + total try/catch: any failure (module missing, DB
 * missing, table missing) yields null and discovery degrades silently.
 */
export async function realSqliteOpener(dbPath: string): Promise<SqliteDb | null> {
  try {
    if (!existsSync(dbPath)) return null
  } catch {
    return null
  }
  try {
    const sqlite = await import("node:sqlite")
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
    return {
      query: (sql: string) => db.prepare(sql).all() as unknown[],
      close: () => {
        try {
          db.close()
        } catch {}
      },
    }
  } catch {
    return null
  }
}

/**
 * Merge the registry with the sqlite layer into a deduplicated candidate
 * list:
 *
 *   - every registry session is a candidate (the prompt hook vouches for it);
 *   - a sqlite session is a candidate when `time_updated > last_sync_ms`
 *     (its wing cursor is not knowable pre-wing, so the V1-compat minimum
 *     is the filter) OR it is already registered;
 *   - dedup by sessionID with the registry winning for `directory` and
 *     sqlite filling in a missing `title`.
 *
 * Never throws: a broken sqlite layer degrades to registry-only.
 */
export async function collectCandidates(paths: Paths, deps: DiscoverDeps = {}): Promise<Candidate[]> {
  const registry = readSessions(paths)
  const candidates = new Map<string, Candidate>()
  for (const [sessionID, meta] of Object.entries(registry)) {
    const candidate: Candidate = { sessionID, directory: meta.directory }
    if (meta.title !== undefined) candidate.title = meta.title
    candidates.set(sessionID, candidate)
  }

  const opener = deps.openSqlite ?? realSqliteOpener
  let db: SqliteDb | null = null
  try {
    db = await opener(deps.dbPath ?? defaultDbPath())
    if (db !== null) {
      const lastSyncMs = readSyncState(paths).last_sync_ms
      for (const row of db.query(DISCOVERY_SQL)) {
        const r = parseRow(row)
        if (r === null) continue
        const known = candidates.get(r.id)
        if (known !== undefined) {
          if (known.title === undefined && r.title !== null) known.title = r.title
          continue
        }
        if (!deps.backfill && !(r.time_updated > lastSyncMs)) continue
        const candidate: Candidate = { sessionID: r.id, directory: r.directory ?? "" }
        if (r.title !== null) candidate.title = r.title
        candidates.set(r.id, candidate)
      }
    }
  } catch {
    // Registry-only: the sqlite layer is a fallback, never a requirement.
  } finally {
    if (db !== null) {
      try {
        db.close()
      } catch {}
    }
  }

  return [...candidates.values()]
}
