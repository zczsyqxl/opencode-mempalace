/**
 * The incremental mining pipeline (sync engine), ported from V1 semantics.
 *
 * One `runSync` pass:
 *
 *   1. discovery (`deps.listCandidates`) → for each candidate read the
 *      session context (`deps.readContext`), filter out already-mined
 *      messages (`filterExportable` with `loadMinedIds`), and write the
 *      transcript into `oc-sessions/<wing>/` (V1 file naming);
 *   2. mine each wing SERIALLY via `deps.runMine` (mempalace CLI, no shell);
 *   3. on wing success — and ONLY then — advance that wing's cursor
 *      (`markWingSynced` with the incomplete-clamped value), commit that
 *      wing's exported message IDs (`mergeExportedIds`), and delete the
 *      wing's export files. Crash mid-mine therefore means "stored less",
 *      never lost or duplicated content (design §7 invariant);
 *   4. "is held by" lock contention backs off through RETRY_DELAYS_MS with
 *      ≤10s random jitter; any other error fails only its own wing and the
 *      run CONTINUES with the next wing;
 *   5. busy-progress / busy / error / summary toasts use the V1 wording
 *      (busy messages MUST start with "palace busy" — the T9 throttle
 *      matches that prefix).
 *
 * Re-entrancy: `miningLock` rejects concurrent runs outright and a start
 * within SYNC_DEBOUNCE_MS of the previous start is skipped — except a
 * BACKFILL run, which always goes through (a forced full export must never
 * be silently dropped).
 *
 * Exit rescue (`runExitSync`, Task 13): a SYNCHRONOUS best-effort salvage of
 * whatever a failed/busy run left in `oc-sessions/`. Discovery and export
 * are async (ctx reads), so at exit they are skipped entirely — only the
 * pending wing dirs are mined, serially, under `planExitWings`'s budget.
 * The miningLock is deliberately ignored (V1: exit takes ownership) and the
 * first mine error stops the walk (V1 returned on first error); files of
 * unmined wings stay on disk for the next startup catch-up sync.
 *
 * Everything is injectable (`deps`) and the whole engine never throws to
 * the host: every stage is wrapped, failures land in the hook log.
 */
import { mkdirSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildTranscript, cursorClamp, exportFileName, filterExportable, wingFor, type ExportMessage } from "./export"
import type { Candidate } from "./discover"
import type { Loggers } from "./logs"
import type { Paths } from "./paths"
import { classifyMineError, parseDrawers, type MempalaceResult } from "./mempalace"
import {
  markWingSynced,
  mergeExportedIds,
  mergeSession,
  readSessions,
  readSyncState,
  writeSessions,
  writeSyncState,
} from "./state"

/** Toast emitter shape shared with ./toast (variant, title, message). */
export type ToastFn = (variant: "info" | "success" | "warning" | "error", title: string, message: string) => void

/** V1 busy backoff schedule (~10.5 minutes total with jitter). */
export const RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 180_000, 300_000] as const
/** Random jitter added to each retry delay (0…10s inclusive). */
export const RETRY_JITTER_MAX_MS = 10_000
/** A run started less than this long after the previous start is skipped. */
export const SYNC_DEBOUNCE_MS = 5_000

/** Injected side effects; tests substitute fakes for all of them. */
export interface SyncDeps {
  readContext(sessionID: string): Promise<ExportMessage[]>
  /**
   * Candidate discovery. `backfill` mirrors `opts.backfill` so the discovery
   * layer can widen its cursor floor to 0 (full history) — the message-level
   * `mined_ids` dedup is applied by the pipeline either way.
   */
  listCandidates(backfill?: boolean): Promise<Candidate[]>
  runMine(wingDir: string, wing: string): Promise<MempalaceResult>
  now(): number
  /** Timer source for busy retries (defaults to setTimeout; fake in tests). */
  sleep?(ms: number): Promise<void>
  /** Random source for retry jitter (defaults to Math.random). */
  random?(): number
}

export interface SyncOpts {
  toast: ToastFn
  loggers: Loggers
  /**
   * BACKFILL=1 runs bypass the debounce so a forced full export cannot be
   * silently skipped (candidate enumeration itself is widened in discover).
   */
  backfill?: boolean
}

/** Whether the user requested a full-history backfill (V1 `!!` rule: any non-empty value). */
export function backfillRequested(env: NodeJS.ProcessEnv): boolean {
  return !!env.OPENCODE_MEMPALACE_BACKFILL
}

/**
 * Pure exit-budget walk (V1): hand each wing `min(perWingMs, remaining)`
 * in order and stop once the budget is spent — wings beyond the budget are
 * simply absent from the plan (they are logged as covered-next-startup by
 * the caller). `now` is accepted for V1 call-site symmetry; the walk itself
 * needs only the budget.
 */
export function planExitWings(
  wings: string[],
  now: number,
  budgetMs = 45_000,
  perWingMs = 30_000,
): Array<{ wing: string; timeoutMs: number }> {
  void now
  const plan: Array<{ wing: string; timeoutMs: number }> = []
  let remaining = budgetMs
  for (const wing of wings) {
    if (remaining <= 0) break
    const timeoutMs = Math.min(perWingMs, remaining)
    plan.push({ wing, timeoutMs })
    remaining -= timeoutMs
  }
  return plan
}

/** Ruling 1: the dedup set is exactly the key set of `mined_ids`. */
export function loadMinedIds(paths: Paths): Set<string> {
  return new Set(Object.keys(readSyncState(paths).mined_ids))
}

// Re-entrancy state for the (single) sync engine of this plugin instance.
let mining = false
let lastStartTs = Number.NEGATIVE_INFINITY

/** Test seam: reset the lock + debounce clock between tests. */
export function resetSyncEngineForTests(): void {
  mining = false
  lastStartTs = Number.NEGATIVE_INFINITY
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** One wing's exports accumulated during the candidate pass. */
interface WingPlan {
  wing: string
  wingDir: string
  /** Absolute paths of the export files written for this wing. */
  files: string[]
  /** Message id → ts for every exported message (committed on success). */
  ids: Map<string, number>
  /** Incomplete (in-flight) message timestamps — clamp the wing cursor. */
  incompleteTs: number[]
}

function planFor(plans: Map<string, WingPlan>, wing: string, paths: Paths): WingPlan {
  let plan = plans.get(wing)
  if (plan === undefined) {
    plan = { wing, wingDir: join(paths.syncDir, wing), files: [], ids: new Map(), incompleteTs: [] }
    plans.set(wing, plan)
  }
  return plan
}

/** Best-effort toast: a broken emitter must never break the sync. */
function safeToast(opts: SyncOpts, variant: "info" | "success" | "warning" | "error", message: string): void {
  try {
    opts.toast(variant, "MemPalace", message)
  } catch {}
}

/** Delete every file in `dir` and remove the dir itself; never throws. */
function cleanWingDir(dir: string): void {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile()) rmSync(join(dir, entry.name), { force: true })
    }
    rmdirSync(dir)
  } catch {}
}

/**
 * Mine one wing with the V1 busy-backoff loop. Resolves with the successful
 * result, the failing result (non-busy error), or null when busy retries
 * were exhausted (files stay on disk for the next trigger).
 */
async function mineWing(deps: SyncDeps, opts: SyncOpts, plan: WingPlan): Promise<MempalaceResult | null> {
  const log = opts.loggers
  for (let attempt = 0; ; attempt++) {
    let result: MempalaceResult
    try {
      result = await deps.runMine(plan.wingDir, plan.wing)
    } catch (err) {
      result = { ok: false, error: String(err) }
    }
    if (result.ok) return result

    if (classifyMineError(result.error) === "busy") {
      if (attempt >= RETRY_DELAYS_MS.length) {
        log.hook(`mine busy-retries exhausted (wing ${plan.wing}); ${plan.files.length} file(s) left for the next run`)
        return null
      }
      const jitter = Math.floor((deps.random?.() ?? Math.random()) * (RETRY_JITTER_MAX_MS + 1))
      safeToast(opts, "info", "palace busy (another instance mining?) — backing off, will retry")
      log.debug(
        `mine busy (wing ${plan.wing}); retry ${attempt + 1}/${RETRY_DELAYS_MS.length} in ${RETRY_DELAYS_MS[attempt]! + jitter}ms`,
      )
      await (deps.sleep?.(RETRY_DELAYS_MS[attempt]! + jitter) ?? defaultSleep(RETRY_DELAYS_MS[attempt]! + jitter))
      continue
    }

    safeToast(opts, "error", `mine failed (${plan.wing}): ${result.error.slice(0, 120)}`)
    log.err(`mine failed (${plan.wing}): ${result.error}`)
    return result
  }
}

async function syncOnce(deps: SyncDeps, paths: Paths, opts: SyncOpts, startNowMs: number): Promise<void> {
  const log = opts.loggers

  let candidates: Candidate[] = []
  try {
    candidates = await deps.listCandidates(opts.backfill === true)
  } catch (err) {
    log.err(`candidate discovery failed: ${String(err)}`)
    return
  }
  // Salvage sweep (2026-09-30 incident), BEFORE the no-candidates early exit:
  // wing dirs still holding files with no new export this run (their mine died
  // with a previous plugin generation, or busy retries exhausted) join the
  // mining set, and a shared wing dir's older leftovers join this run's file
  // counts. Mining is directory-level, so every pending file in a wing dir is
  // filed in one pass; a salvaged wing's message ids are unknown (they died
  // with the dead run), so its cursor banks at now with no id commit — the
  // same semantics as the exit rescue.
  const plans = new Map<string, WingPlan>()
  for (const wing of pendingWings(paths)) {
    const plan = planFor(plans, wing, paths)
    try {
      plan.files = readdirSync(plan.wingDir).sort().map((f) => join(plan.wingDir, f))
    } catch {}
  }
  if (candidates.length === 0 && plans.size === 0) return

  const seen = loadMinedIds(paths)
  let incompleteTotal = 0

  for (const candidate of candidates) {
    let messages: ExportMessage[]
    try {
      messages = await deps.readContext(candidate.sessionID)
    } catch (err) {
      log.err(`context read failed (${candidate.sessionID}): ${String(err)}`)
      // Design §7: the session stays discoverable via the registry so the
      // next idle re-reads it even if wing cursors move past its timestamp.
      try {
        const meta = { directory: candidate.directory, lastSeenMs: deps.now() }
        writeSessions(paths, mergeSession(readSessions(paths), candidate.sessionID, candidate.title !== undefined ? { ...meta, title: candidate.title } : meta))
      } catch {}
      continue
    }

    const { exportable, incompleteTs } = filterExportable(messages, seen)
    const plan = planFor(plans, wingFor(candidate.directory), paths)
    plan.incompleteTs.push(...incompleteTs)
    incompleteTotal += incompleteTs.length

    // V1 skip rule (Review Focus #3): a lone exportable message with nothing
    // in flight is not worth a transcript — no file, no cursor movement.
    if (exportable.length < 2 && incompleteTs.length === 0) continue

    // V1 header label: the title verbatim when present, else the sanitized
    // title, else the first 12 chars of the session id — never a bare "# ".
    const title = candidate.title ?? ""
    const label = title.replace(/[^a-zA-Z0-9 _-]/g, "_") || candidate.sessionID.slice(0, 12)
    const content = buildTranscript(title || label, candidate.sessionID, exportable, new Date(startNowMs))
    const file = join(plan.wingDir, exportFileName(new Date(startNowMs), title, candidate.sessionID, content))
    try {
      mkdirSync(plan.wingDir, { recursive: true, mode: 0o700 })
      // 0600/0700 are no-ops on Windows but kept for posix parity with V1.
      writeFileSync(file, content + "\n", { mode: 0o600 })
    } catch (err) {
      log.err(`export write failed (${candidate.sessionID}): ${String(err)}`)
      continue
    }
    plan.files.push(file)
    for (const m of exportable) plan.ids.set(m.id, m.ts)
  }

  const wingOrder = [...plans.values()].filter((p) => p.files.length > 0).map((p) => p.wing)
  if (wingOrder.length === 0) return

  let state = readSyncState(paths)
  const succeeded: string[] = []
  let minedSessions = 0
  let drawers = 0

  let index = 0
  for (const wing of wingOrder) {
    index++
    const plan = plans.get(wing)!
    const result = await mineWing(deps, opts, plan)

    if (result !== null && result.ok) {
      const successNow = deps.now()
      const clamp = cursorClamp(plan.incompleteTs, successNow)
      // Cursor + this wing's ids commit together, in one state write.
      let next = markWingSynced(state, wing, clamp)
      next = { ...next, mined_ids: mergeExportedIds(state.mined_ids, new Map([[wing, plan.ids]]), successNow) }
      writeSyncState(paths, next)
      state = next

      cleanWingDir(plan.wingDir)
      minedSessions += plan.files.length
      drawers += parseDrawers(result.stdout)
      succeeded.push(wing)
      safeToast(opts, "info", `wing ${wing} done (${index}/${wingOrder.length})`)
      log.hook(`wing ${wing} mined: ${plan.files.length} session file(s), ${plan.ids.size} message(s), cursor ${clamp}`)
    }
  }

  // Drop the workspace itself when nothing is waiting inside it.
  try {
    rmdirSync(paths.syncDir)
  } catch {}

  if (minedSessions > 0) {
    const drawersLabel = drawers > 0 ? ` (${drawers} drawers)` : ""
    const waiting =
      incompleteTotal +
      [...plans.values()].reduce((n, p) => (succeeded.includes(p.wing) ? n : n + p.ids.size), 0)
    const waitLabel = waiting > 0 ? `, ${waiting} message(s) still waiting` : ", queue empty"
    safeToast(opts, "success", `mined ${minedSessions} session(s) → ${succeeded.join(", ")}${drawersLabel}${waitLabel}`)
  }
  log.ilog("sync", {
    candidates: candidates.length,
    mined: minedSessions,
    wings: succeeded,
    drawers,
    waiting: incompleteTotal,
  })
}

/**
 * Run one debounced, lock-guarded sync pass. Never rejects; unexpected
 * internal errors are logged, never thrown to the host.
 */
export async function runSync(deps: SyncDeps, paths: Paths, opts: SyncOpts): Promise<void> {
  try {
    if (mining) return
    const nowMs = deps.now()
    if (!opts.backfill && nowMs - lastStartTs < SYNC_DEBOUNCE_MS) return
    if (opts.backfill) opts.loggers.debug("backfill requested: exporting full history")
    mining = true
    lastStartTs = nowMs
    try {
      await syncOnce(deps, paths, opts, nowMs)
    } finally {
      mining = false
    }
  } catch (err) {
    try {
      opts.loggers.err(`sync failed: ${String(err)}`)
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Exit rescue (Task 13) — synchronous salvage of pending wing dirs
// ---------------------------------------------------------------------------

/** Injected side effects of the exit rescue; tests substitute fakes. */
export interface ExitDeps {
  /** Synchronous mine (spawnSync-backed in production). */
  runMineSync(wingDir: string, wing: string, timeoutMs: number): MempalaceResult
  /** Clock for cursor timestamps (defaults to Date.now). */
  now?(): number
}

export interface ExitOpts {
  loggers: Loggers
  /** Total wall-clock budget for the whole rescue (default 45s, V1). */
  budgetMs?: number
  /** Per-wing mine timeout (default 30s, V1). */
  perWingMs?: number
}

/**
 * Wings with at least one export file waiting under `paths.syncDir`
 * (leftovers of failed/busy runs), sorted for deterministic planning.
 * Total: a missing or unreadable workspace yields [].
 */
export function pendingWings(paths: Paths): string[] {
  let entries
  try {
    entries = readdirSync(paths.syncDir, { withFileTypes: true })
  } catch {
    return []
  }
  const wings: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      if (readdirSync(join(paths.syncDir, entry.name)).length > 0) wings.push(entry.name)
    } catch {}
  }
  return wings.sort()
}

/**
 * Synchronous exit rescue (V1 semantics): mine what a previous run already
 * exported but failed to mine. No discovery, no export (both need async ctx
 * reads), no miningLock (exit takes ownership), no busy backoff — one sync
 * mine call per planned wing under `planExitWings`'s budget; the FIRST
 * failure stops the walk and every unmined wing's files stay on disk for
 * the next startup catch-up sync.
 *
 * On wing success: cursor to now (clamp≈now — nothing new is read at exit,
 * so there is no incomplete-clamp input and no new message id to commit),
 * the retention-shaped `mergeExportedIds` commit, then file cleanup.
 * Never throws to the exit path.
 */
export function runExitSync(deps: ExitDeps, paths: Paths, opts: ExitOpts): void {
  const log = opts.loggers
  try {
    const pending = pendingWings(paths)
    if (pending.length === 0) {
      log.debug("exit rescue: nothing pending — clean exit")
      return
    }

    const plan = planExitWings(pending, deps.now?.() ?? Date.now(), opts.budgetMs, opts.perWingMs)
    const planned = new Set(plan.map((p) => p.wing))
    for (const wing of pending) {
      if (!planned.has(wing)) log.hook(`exit rescue: wing ${wing} over budget — covered next startup`)
    }
    log.hook(`exit rescue: ${plan.length}/${pending.length} pending wing(s): ${plan.map((p) => p.wing).join(", ")}`)

    let state = readSyncState(paths)
    for (const { wing, timeoutMs } of plan) {
      const wingDir = join(paths.syncDir, wing)
      let result: MempalaceResult
      try {
        result = deps.runMineSync(wingDir, wing, timeoutMs)
      } catch (err) {
        result = { ok: false, error: String(err) }
      }
      if (!result.ok) {
        log.err(`exit rescue: mine failed (${wing}): ${result.error}`)
        log.hook("exit rescue: stopped — remaining wing(s) covered next startup")
        return
      }

      // Commit = cursor + (empty) id merge + cleanup, mirroring syncOnce.
      const successNow = deps.now?.() ?? Date.now()
      let next = markWingSynced(state, wing, successNow)
      next = { ...next, mined_ids: mergeExportedIds(state.mined_ids, new Map([[wing, new Map()]]), successNow) }
      writeSyncState(paths, next)
      state = next

      cleanWingDir(wingDir)
      log.hook(`exit rescue: wing ${wing} mined, cursor ${successNow}`)
    }

    // Drop the workspace itself when nothing is waiting inside it.
    try {
      rmdirSync(paths.syncDir)
    } catch {}
  } catch (err) {
    try {
      log.err(`exit rescue failed: ${String(err)}`)
    } catch {}
  }
}
