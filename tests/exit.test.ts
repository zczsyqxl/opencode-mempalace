/**
 * Task 13: backfill (`OPENCODE_MEMPALACE_BACKFILL`) + synchronous exit rescue.
 *
 *   backfillRequested      env → boolean (V1 `!!` rule)
 *   planExitWings          pure budget walk: min(perWing, remaining), stop at 0
 *   runSync + backfill     discovery widened (cursor floor 0) BUT mined_ids
 *                          dedup still applies; debounce bypassed
 *   runExitSync            synchronous salvage of whatever a failed/busy run
 *                          left in oc-sessions/ — no discovery, no export,
 *                          no miningLock; first mine error stops the walk
 *                          (V1 semantics); files of unmined wings are kept
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { ExportMessage } from "../src/export"
import type { MempalaceResult } from "../src/mempalace"
import { buildPaths, type Paths } from "../src/paths"
import {
  backfillRequested,
  pendingWings,
  planExitWings,
  runExitSync,
  runSync,
  resetSyncEngineForTests,
  type ExitDeps,
  type SyncDeps,
} from "../src/pipeline"
import type { Loggers } from "../src/logs"
import type { Candidate } from "../src/discover"
import { readSyncState, writeSyncState } from "../src/state"

/** Fresh temp dir per test; never touch the real ~/.mempalace. */
let tmp = ""
afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true })
    tmp = ""
  }
  resetSyncEngineForTests()
})

function freshPaths(): Paths {
  tmp = mkdtempSync(join(tmpdir(), "mp-exit-"))
  return buildPaths(join(tmp, "base"))
}

function msg(partial: Partial<ExportMessage> & Pick<ExportMessage, "id">): ExportMessage {
  return { role: "user", text: "text", ts: 1000, complete: true, ...partial }
}

/** Fixed injectable clock value for deterministic cursors. */
const NOW = 1_000_000

/** Toast fake recording [variant, title, message] triples. */
function fakeToast(): { calls: Array<[string, string, string]>; fn: (variant: "info" | "success" | "warning" | "error", title: string, message: string) => void } {
  const calls: Array<[string, string, string]> = []
  return { calls, fn: (variant, title, message) => { calls.push([variant, title, message]) } }
}

/** Loggers fake capturing debug/hook/err lines (ilog unused here). */
function fakeLoggers(): Loggers & { debugLines: string[]; hookLines: string[]; errLines: string[] } {
  const debugLines: string[] = []
  const hookLines: string[] = []
  const errLines: string[] = []
  return {
    debugLines,
    hookLines,
    errLines,
    debug: (m) => { debugLines.push(m) },
    hook: (m) => { hookLines.push(m) },
    err: (m) => { errLines.push(m) },
    ilog: () => {},
  }
}

/** Leave `files` leftover export files in one pending wing dir. */
function seedPending(paths: Paths, wing: string, files = 1): void {
  const dir = join(paths.syncDir, wing)
  mkdirSync(dir, { recursive: true })
  for (let i = 0; i < files; i++) writeFileSync(join(dir, `sync_leftover_${i}.txt`), "leftover\n", "utf8")
}

interface ExitScript {
  mine?(wingDir: string, wing: string, timeoutMs: number, call: number): MempalaceResult
}

function fakeExitDeps(script: ExitScript = {}): ExitDeps & { mineCalls: Array<{ wingDir: string; wing: string; timeoutMs: number }> } {
  const mineCalls: Array<{ wingDir: string; wing: string; timeoutMs: number }> = []
  const deps: ExitDeps = {
    runMineSync: (wingDir, wing, timeoutMs) => {
      const call = mineCalls.length + 1
      mineCalls.push({ wingDir, wing, timeoutMs })
      if (script.mine) return script.mine(wingDir, wing, timeoutMs, call)
      return { ok: true, stdout: "Drawers filed: 1" }
    },
    now: () => NOW,
  }
  return { ...deps, mineCalls }
}

// ---------------------------------------------------------------------------
// backfillRequested — pure env predicate (V1 `!!` rule)
// ---------------------------------------------------------------------------

describe("backfillRequested", () => {
  it("false when absent, undefined, or empty string", () => {
    expect(backfillRequested({})).toBe(false)
    expect(backfillRequested({ OPENCODE_MEMPALACE_BACKFILL: undefined })).toBe(false)
    expect(backfillRequested({ OPENCODE_MEMPALACE_BACKFILL: "" })).toBe(false)
  })

  it("true for ANY non-empty value (V1 truthiness: '1', 'true', even '0')", () => {
    expect(backfillRequested({ OPENCODE_MEMPALACE_BACKFILL: "1" })).toBe(true)
    expect(backfillRequested({ OPENCODE_MEMPALACE_BACKFILL: "true" })).toBe(true)
    expect(backfillRequested({ OPENCODE_MEMPALACE_BACKFILL: "0" })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// planExitWings — pure budget walk
// ---------------------------------------------------------------------------

describe("planExitWings", () => {
  const WINGS = ["alpha", "beta", "gamma"]

  it("3 wings / 70s budget → 30s, 30s, 10s (third wing gets the remainder)", () => {
    expect(planExitWings(WINGS, 1_000, 70_000, 30_000)).toEqual([
      { wing: "alpha", timeoutMs: 30_000 },
      { wing: "beta", timeoutMs: 30_000 },
      { wing: "gamma", timeoutMs: 10_000 },
    ])
  })

  it("20s budget → only the first wing, at min(perWing, remaining) = 20s", () => {
    expect(planExitWings(WINGS, 1_000, 20_000, 30_000)).toEqual([{ wing: "alpha", timeoutMs: 20_000 }])
  })

  it("wings beyond the budget are simply absent from the plan", () => {
    expect(planExitWings(WINGS, 1_000, 0, 30_000)).toEqual([])
    expect(planExitWings(WINGS, 1_000, 30_000, 30_000)).toEqual([{ wing: "alpha", timeoutMs: 30_000 }])
  })

  it("no wings → empty plan", () => {
    expect(planExitWings([], 1_000, 70_000, 30_000)).toEqual([])
  })

  it("defaults: 45s total budget / 30s per wing", () => {
    expect(planExitWings(WINGS, 1_000)).toEqual([
      { wing: "alpha", timeoutMs: 30_000 },
      { wing: "beta", timeoutMs: 15_000 },
    ])
  })
})

// ---------------------------------------------------------------------------
// runSync + backfill — widened discovery, dedup kept, debounce bypassed
// ---------------------------------------------------------------------------

describe("runSync backfill", () => {
  it("passes backfill=true to the discovery dep and logs the V1 debug line", async () => {
    const paths = freshPaths()
    const toast = fakeToast()
    const log = fakeLoggers()
    const flags: Array<boolean | undefined> = []
    const deps: SyncDeps = {
      readContext: async () => [msg({ id: "f1" }), msg({ id: "f2", ts: 2000 })],
      listCandidates: async (backfill?: boolean) => {
        flags.push(backfill)
        return [{ sessionID: "ses_f", directory: "/p/alpha" }]
      },
      runMine: async () => ({ ok: true, stdout: "" }),
      now: () => NOW,
    }
    await runSync(deps, paths, { toast: toast.fn, loggers: log, backfill: true })
    expect(flags).toEqual([true])
    expect(log.debugLines).toContain("backfill requested: exporting full history")
  })

  it("a normal run passes false to the discovery dep", async () => {
    const paths = freshPaths()
    const toast = fakeToast()
    const flags: Array<boolean | undefined> = []
    const deps: SyncDeps = {
      readContext: async () => [msg({ id: "n1" }), msg({ id: "n2", ts: 2000 })],
      listCandidates: async (backfill?: boolean) => {
        flags.push(backfill)
        return [{ sessionID: "ses_n", directory: "/p/alpha" }]
      },
      runMine: async () => ({ ok: true, stdout: "" }),
      now: () => NOW,
    }
    await runSync(deps, paths, { toast: toast.fn, loggers: fakeLoggers() })
    expect(flags).toEqual([false])
  })

  it("mined_ids dedup STILL applies under backfill: fully-mined history re-exports nothing", async () => {
    const paths = freshPaths()
    const toast = fakeToast()
    // cursor floor is 0 under backfill, but these two ids are already mined
    writeSyncState(paths, { last_sync_ms: 0, wings: {}, mined_ids: { f1: 1, f2: 2 } })
    let mineCalls = 0
    const deps: SyncDeps = {
      readContext: async () => [msg({ id: "f1" }), msg({ id: "f2", ts: 2000 })],
      listCandidates: async () => [{ sessionID: "ses_f", directory: "/p/alpha" }] as Candidate[],
      runMine: async () => {
        mineCalls++
        return { ok: true, stdout: "" }
      },
      now: () => NOW,
    }
    await runSync(deps, paths, { toast: toast.fn, loggers: fakeLoggers(), backfill: true })
    expect(mineCalls).toBe(0)
    expect(readSyncState(paths)).toEqual({ last_sync_ms: 0, wings: {}, mined_ids: { f1: 1, f2: 2 } })
  })

  it("backfill bypasses the 5s debounce (a forced full export is never skipped)", async () => {
    const paths = freshPaths()
    const toast = fakeToast()
    let calls = 0
    const deps: SyncDeps = {
      readContext: async () => [],
      listCandidates: async () => {
        calls++
        return []
      },
      runMine: async () => ({ ok: true, stdout: "" }),
      now: () => NOW, // frozen clock: the 2nd start is INSIDE the debounce window
    }
    await runSync(deps, paths, { toast: toast.fn, loggers: fakeLoggers() })
    await runSync(deps, paths, { toast: toast.fn, loggers: fakeLoggers(), backfill: true })
    expect(calls).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// pendingWings — what a previous run left behind
// ---------------------------------------------------------------------------

describe("pendingWings", () => {
  it("wing dirs with ≥1 file, sorted; empty wing dirs and loose files ignored", () => {
    const paths = freshPaths()
    seedPending(paths, "beta", 2)
    seedPending(paths, "alpha", 1)
    mkdirSync(join(paths.syncDir, "empty"))
    writeFileSync(join(paths.syncDir, "loose.txt"), "x", "utf8")
    expect(pendingWings(paths)).toEqual(["alpha", "beta"])
  })

  it("missing syncDir → []", () => {
    const paths = freshPaths()
    expect(pendingWings(paths)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// runExitSync — synchronous salvage (fake sync mine runner)
// ---------------------------------------------------------------------------

describe("runExitSync", () => {
  it("pending wing dir: mined with the planned timeout, state committed, files cleaned", () => {
    const paths = freshPaths()
    seedPending(paths, "alpha", 2)
    writeSyncState(paths, { last_sync_ms: 5, wings: { alpha: 5 }, mined_ids: { old: 5 } })
    const log = fakeLoggers()
    const deps = fakeExitDeps()

    runExitSync(deps, paths, { loggers: log })

    expect(deps.mineCalls).toEqual([{ wingDir: join(paths.syncDir, "alpha"), wing: "alpha", timeoutMs: 30_000 }])
    // cursor advanced to now; pre-existing mined_ids survive (nothing new to add)
    const st = readSyncState(paths)
    expect(st.wings.alpha).toBe(NOW)
    expect(st.last_sync_ms).toBe(NOW)
    expect(st.mined_ids).toEqual({ old: 5 })
    // wing dir and the now-empty sync workspace are gone
    expect(existsSync(join(paths.syncDir, "alpha"))).toBe(false)
    expect(existsSync(paths.syncDir)).toBe(false)
    expect(log.hookLines.some((l) => l.includes("wing alpha mined"))).toBe(true)
  })

  it("nothing pending → fast no-op (no mine, no state write)", () => {
    const paths = freshPaths()
    const log = fakeLoggers()
    const deps = fakeExitDeps()

    runExitSync(deps, paths, { loggers: log })

    expect(deps.mineCalls).toEqual([])
    expect(readSyncState(paths)).toEqual({ last_sync_ms: 0, wings: {}, mined_ids: {} })
  })

  it("mine failure → log, STOP (V1 returned on first error): later wings untouched, files kept, cursor stays", () => {
    const paths = freshPaths()
    seedPending(paths, "alpha")
    seedPending(paths, "beta")
    const log = fakeLoggers()
    const deps = fakeExitDeps({
      mine: (_dir, wing) => (wing === "alpha" ? { ok: false, error: "boom" } : { ok: true, stdout: "" }),
    })

    runExitSync(deps, paths, { loggers: log })

    expect(deps.mineCalls.map((c) => c.wing)).toEqual(["alpha"]) // stopped after the first error
    expect(existsSync(join(paths.syncDir, "alpha"))).toBe(true) // failed wing keeps its files
    expect(existsSync(join(paths.syncDir, "beta"))).toBe(true) // never attempted
    expect(readdirSync(join(paths.syncDir, "beta"))).toHaveLength(1)
    expect(readSyncState(paths)).toEqual({ last_sync_ms: 0, wings: {}, mined_ids: {} })
    expect(log.errLines.some((l) => l.includes("mine failed (alpha)"))).toBe(true)
  })

  it("budget truncation: wings beyond the plan are skipped, kept on disk, and logged for next startup", () => {
    const paths = freshPaths()
    seedPending(paths, "alpha")
    seedPending(paths, "beta")
    seedPending(paths, "gamma")
    const log = fakeLoggers()
    const deps = fakeExitDeps()

    runExitSync(deps, paths, { loggers: log, budgetMs: 40_000, perWingMs: 30_000 })

    // plan: alpha 30s + beta 10s → gamma absent
    expect(deps.mineCalls).toEqual([
      { wingDir: join(paths.syncDir, "alpha"), wing: "alpha", timeoutMs: 30_000 },
      { wingDir: join(paths.syncDir, "beta"), wing: "beta", timeoutMs: 10_000 },
    ])
    expect(existsSync(join(paths.syncDir, "gamma"))).toBe(true)
    expect(existsSync(join(paths.syncDir, "alpha"))).toBe(false)
    expect(log.hookLines.some((l) => l.includes("gamma") && l.includes("next startup"))).toBe(true)
  })

  it("a throwing sync runner is treated as a failure (never throws to the exit path)", () => {
    const paths = freshPaths()
    seedPending(paths, "alpha")
    const log = fakeLoggers()
    const deps: ExitDeps = {
      runMineSync: () => {
        throw new Error("kaboom")
      },
      now: () => NOW,
    }

    expect(() => runExitSync(deps, paths, { loggers: log })).not.toThrow()
    expect(existsSync(join(paths.syncDir, "alpha"))).toBe(true)
    expect(readSyncState(paths)).toEqual({ last_sync_ms: 0, wings: {}, mined_ids: {} })
    expect(log.errLines.some((l) => l.includes("alpha"))).toBe(true)
  })
})
