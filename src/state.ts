/**
 * Persistent state for the sync engine, ported from V1 semantics:
 *
 *   sync_state.json                    per-wing cursors + mined message IDs
 *   hook_state/opencode_counters.json  per-session human-message counters
 *                                      (AI-checkpoint cadence)
 *   hook_state/oc_sessions.json        known-session registry (new in V2)
 *
 * Parsing is total: garbage on disk yields defaults and never throws — a
 * corrupted state file must not crash the host opencode process. Writes are
 * best-effort for the same reason: if a write fails, the worst case is that
 * the next run re-exports and re-mines idempotently ("少存", never data loss
 * or duplicates).
 *
 * mined_ids retention is by AGE (90 days) and COUNT (200k newest) — NEVER by
 * cursor. V1's cursor-based pruning silently dropped IDs whenever a cursor
 * moved backwards, disabling the dedup filter (Review Focus #4). Non-numeric
 * mined_ids entries are filtered on read, never fatal.
 *
 * Per-wing cursors: one failing wing never stalls the others — each wing's
 * cursor advances independently and `last_sync_ms` (the V1 compatibility
 * field) always mirrors the minimum across wings.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { Paths } from "./paths"

/** Sync cursors + message-level dedup set persisted in `sync_state.json`. */
export interface SyncState {
  /** V1 compatibility field: min timestamp across all wing cursors. */
  last_sync_ms: number
  /** Per-wing cursor: newest message timestamp successfully mined per wing. */
  wings: Record<string, number>
  /** Message IDs already filed, mapped to the ms timestamp when mined. */
  mined_ids: Record<string, number>
}

/** Retention: mined_ids entries older than 90 days drop out. */
export const MINED_IDS_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000
/** Retention: at most the 200k newest mined_ids entries survive. */
export const MINED_IDS_MAX_ENTRIES = 200_000

/** Best-effort read: any failure (missing file included) means "no file". */
function readRaw(file: string): string | null {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return null
  }
}

/** Best-effort pretty-printed JSON write; creates parent dirs; never throws. */
function writeJson(file: string, value: unknown): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8")
  } catch {}
}

/** Narrow `unknown` to a real, finite number (rejects NaN/Infinity/strings). */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/** Keep only finite-number entries; anything else (objects, null, strings…) goes. */
function numericRecord(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  const out: Record<string, number> = {}
  for (const [key, v] of Object.entries(value)) {
    if (isFiniteNumber(v)) out[key] = v
  }
  return out
}

function emptySyncState(): SyncState {
  return { last_sync_ms: 0, wings: {}, mined_ids: {} }
}

/**
 * Parse raw sync_state.json text. `null` stands for "no file". Total
 * function: malformed JSON or non-object JSON → `{0, {}, {}}`; non-numeric
 * `mined_ids` (and `wings`) entries are filtered, not fatal.
 */
export function parseSyncState(raw: string | null): SyncState {
  if (raw === null) return emptySyncState()

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptySyncState()
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return emptySyncState()
  }

  const obj = parsed as Record<string, unknown>
  const lastSync = obj.last_sync_ms
  return {
    last_sync_ms: isFiniteNumber(lastSync) ? lastSync : 0,
    wings: numericRecord(obj.wings),
    mined_ids: numericRecord(obj.mined_ids),
  }
}

/** Read `paths.stateFile`; missing or corrupted → `{0, {}, {}}`. Never throws. */
export function readSyncState(paths: Paths): SyncState {
  return parseSyncState(readRaw(paths.stateFile))
}

/** Persist `st` to `paths.stateFile` (best-effort, never throws). */
export function writeSyncState(paths: Paths, st: SyncState): void {
  writeJson(paths.stateFile, st)
}

/**
 * Advance one wing's cursor. Pure: returns a fresh SyncState with
 * `last_sync_ms` recomputed as the MINIMUM across all wing cursors — a wing
 * whose mine failed simply keeps its old cursor and pins the field, while
 * other wings keep advancing independently.
 */
export function markWingSynced(st: SyncState, wing: string, ts: number): SyncState {
  const wings = { ...st.wings, [wing]: ts }
  const cursors = Object.values(wings)
  const last_sync_ms = cursors.length > 0 ? Math.min(...cursors) : 0
  return { last_sync_ms, wings, mined_ids: { ...st.mined_ids } }
}

/**
 * Merge freshly exported message IDs into the mined set with V1 retention:
 *
 * 1. merge: an ID seen in both keeps the NEWER timestamp;
 * 2. age: entries older than 90 days (ts < now - MINED_IDS_MAX_AGE_MS) drop —
 *    regardless of whether they came from disk or from this export;
 * 3. count: above 200k entries only the NEWEST survive.
 *
 * Retention never consults cursors (V1 bug, Review Focus #4).
 */
export function mergeExportedIds(
  mined: Record<string, number>,
  byWing: Map<string, Map<string, number>>,
  now: number,
): Record<string, number> {
  const merged: Record<string, number> = { ...mined }
  for (const exported of byWing.values()) {
    for (const [id, ts] of exported) {
      const prev = merged[id]
      merged[id] = prev === undefined ? ts : Math.max(prev, ts)
    }
  }

  const cutoff = now - MINED_IDS_MAX_AGE_MS
  const retained = Object.entries(merged).filter(([, ts]) => ts >= cutoff)

  if (retained.length > MINED_IDS_MAX_ENTRIES) {
    retained.sort(([, a], [, b]) => b - a) // newest first (V8 sort is stable)
    retained.length = MINED_IDS_MAX_ENTRIES
  }

  const out: Record<string, number> = {}
  for (const [id, ts] of retained) out[id] = ts
  return out
}

/** Per-session AI-checkpoint cadence, persisted in `opencode_counters.json`. */
export interface SessionCounter {
  /** Human messages seen so far in the session. */
  humanMsgs: number
  /** Last boundary index (floor(humanMsgs/interval)) that fired a checkpoint. */
  lastCheckpoint: number
}

/**
 * Count one more human message and report whether an AI checkpoint is armed.
 *
 * V1 arming rule, evaluated on the counter BEFORE this bump:
 * `armed = floor(humanMsgs / interval) > lastCheckpoint` — so the message
 * that takes a session from 14→15 stays disarmed and the follow-up from
 * {15, 0} arms (exactly one checkpoint per boundary crossing). The returned
 * counter keeps `lastCheckpoint` untouched; the consumer advances it only
 * after the checkpoint instruction was actually delivered.
 *
 * A non-positive `interval` (never produced by config, floor 5) never arms.
 */
export function bumpCounter(
  c: SessionCounter | undefined,
  interval: number,
): { counter: SessionCounter; armed: boolean } {
  const prevMsgs = c?.humanMsgs ?? 0
  const lastCheckpoint = c?.lastCheckpoint ?? 0
  const armed = interval > 0 ? Math.floor(prevMsgs / interval) > lastCheckpoint : false
  return { counter: { humanMsgs: prevMsgs + 1, lastCheckpoint }, armed }
}

/** Read `paths.countersFile`; missing/corrupted → `{}`, malformed entries dropped. Never throws. */
export function readCounters(paths: Paths): Record<string, SessionCounter> {
  const raw = readRaw(paths.countersFile)
  if (raw === null) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}

  const out: Record<string, SessionCounter> = {}
  for (const [sessionID, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    if (!isFiniteNumber(entry.humanMsgs) || !isFiniteNumber(entry.lastCheckpoint)) continue
    out[sessionID] = { humanMsgs: entry.humanMsgs, lastCheckpoint: entry.lastCheckpoint }
  }
  return out
}

/** Persist `counters` to `paths.countersFile` (best-effort, never throws). */
export function writeCounters(paths: Paths, counters: Record<string, SessionCounter>): void {
  writeJson(paths.countersFile, counters)
}

/** One registry entry in the known-sessions registry (`oc_sessions.json`). */
export interface SessionMeta {
  /** Working-directory of the session (mapped to a wing by Task 6's `wingFor`). */
  directory: string
  /** Session title, when the source knows one. */
  title?: string
  /** Last time this session produced a human message (ms epoch). */
  lastSeenMs: number
}

/**
 * Register/refresh a session in the registry. Pure upsert: the newest meta
 * replaces any previous entry for `id`; other entries pass through untouched.
 */
export function mergeSession(
  reg: Record<string, SessionMeta>,
  id: string,
  meta: SessionMeta,
): Record<string, SessionMeta> {
  return { ...reg, [id]: meta }
}

function parseSessionMeta(value: unknown): SessionMeta | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const entry = value as Record<string, unknown>
  if (typeof entry.directory !== "string") return null
  if (!isFiniteNumber(entry.lastSeenMs)) return null
  if (typeof entry.title !== "string") return { directory: entry.directory, lastSeenMs: entry.lastSeenMs }
  return { directory: entry.directory, title: entry.title, lastSeenMs: entry.lastSeenMs }
}

/** Read `paths.sessionsRegistry`; missing/corrupted → `{}`, malformed entries dropped. Never throws. */
export function readSessions(paths: Paths): Record<string, SessionMeta> {
  const raw = readRaw(paths.sessionsRegistry)
  if (raw === null) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}

  const out: Record<string, SessionMeta> = {}
  for (const [sessionID, value] of Object.entries(parsed)) {
    const meta = parseSessionMeta(value)
    if (meta !== null) out[sessionID] = meta
  }
  return out
}

/** Persist `reg` to `paths.sessionsRegistry` (best-effort, never throws). */
export function writeSessions(paths: Paths, reg: Record<string, SessionMeta>): void {
  writeJson(paths.sessionsRegistry, reg)
}
