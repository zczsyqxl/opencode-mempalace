import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildTranscript, type ExportMessage } from "../src/export"
import {
  collectCandidates,
  toExportMessages,
  type Candidate,
  type SqliteDb,
  type SqliteOpener,
} from "../src/discover"
import { buildPaths, type Paths } from "../src/paths"
import {
  RETRY_DELAYS_MS,
  SYNC_DEBOUNCE_MS,
  loadMinedIds,
  resetSyncEngineForTests,
  runSync,
  type SyncDeps,
  type SyncOpts,
} from "../src/pipeline"
import { readSessions, readSyncState, writeSessions, writeSyncState } from "../src/state"
import { makeLoggers } from "../src/logs"

/** Fresh temp dir per test; never touch the real ~/.mempalace. */
let tmp = ""
afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true })
    tmp = ""
  }
  resetSyncEngineForTests()
  vi.useRealTimers()
})

function freshPaths(): Paths {
  tmp = mkdtempSync(join(tmpdir(), "mp-pipe-"))
  return buildPaths(join(tmp, "base"))
}

function msg(partial: Partial<ExportMessage> & Pick<ExportMessage, "id">): ExportMessage {
  return { role: "user", text: "text", ts: 1000, complete: true, ...partial }
}

/** Fixed injectable clock value for deterministic cursors/filenames. */
const NOW = 1_000_000

/** Toast fake recording [variant, title, message] triples. */
function fakeToast(): { calls: Array<[string, string, string]>; fn: SyncOpts["toast"] } {
  const calls: Array<[string, string, string]> = []
  return { calls, fn: (variant, title, message) => { calls.push([variant, title, message]) } }
}

interface DepsScript {
  candidates?: Candidate[]
  context?: Record<string, ExportMessage[]> | ((sessionID: string) => ExportMessage[])
  mine?: (wingDir: string, wing: string, call: number) => Promise<{ ok: true; stdout: string } | { ok: false; error: string }>
  now?: () => number
  random?: () => number
}

function fakeDeps(script: DepsScript = {}): SyncDeps & { mineCalls: Array<{ wingDir: string; wing: string }>; candidateCalls: number } {
  const mineCalls: Array<{ wingDir: string; wing: string }> = []
  let candidateCount = 0
  const deps: SyncDeps = {
    readContext: async (sessionID) => {
      const c = script.context
      if (typeof c === "function") return c(sessionID)
      if (c && sessionID in c) return c[sessionID]
      throw new Error(`no context scripted for ${sessionID}`)
    },
    listCandidates: async () => {
      candidateCount++
      return script.candidates ?? []
    },
    runMine: async (wingDir, wing) => {
      const call = mineCalls.length + 1
      mineCalls.push({ wingDir, wing })
      if (script.mine) return script.mine(wingDir, wing, call)
      return { ok: true, stdout: "" }
    },
    now: script.now ?? (() => NOW),
    ...(script.random !== undefined ? { random: script.random } : {}),
  }
  // `candidateCalls` must be live (a plain spread would freeze it at 0).
  return { ...deps, mineCalls, get candidateCalls() { return candidateCount } }
}

function opts(paths: Paths, toast: SyncOpts["toast"]): SyncOpts {
  return { toast, loggers: makeLoggers(paths, false) }
}

// ---------------------------------------------------------------------------
// toExportMessages — the real probed ctx.session.context() shape (Task 1 A3)
// ---------------------------------------------------------------------------

/** Verbatim element shapes from v2-probe-findings.json contextShape.liveSession. */
const PROBE_USER = {
  id: "msg_0eb727a51001606odQWdvJRRfJ",
  time: { created: 1790656547087 },
  text: '"say hi"',
  files: [],
  type: "user",
}
const PROBE_ASSISTANT = {
  id: "msg_0eb728941001nDwdyB4sZwVXyK",
  time: { created: 1790656547205, streamed: 1790656548782, completed: 1790656548784 },
  type: "assistant",
  agent: "build",
  model: { id: "claude-sonnet-5-5", providerID: "opencode" },
  content: [{ type: "text", text: "Hi!" }],
  finish: "stop",
  rawFinish: "end_turn",
  cost: 0.038333,
  tokens: { input: 4, output: 6, reasoning: 0, cache: { read: 0, write: 15306 } },
}
const PROBE_IDLE = { id: "msg_0eb728fb4001JcjVM0Dj3zDo2e", time: { created: 1790656548788 }, type: "idle", outcome: "succeeded" }

describe("toExportMessages", () => {
  it("maps the probed live-session array exactly (user.text, assistant content text parts, time.created)", () => {
    expect(toExportMessages([PROBE_USER, PROBE_ASSISTANT, PROBE_IDLE])).toEqual([
      { id: PROBE_USER.id, role: "user", text: '"say hi"', ts: 1790656547087, complete: true },
      { id: PROBE_ASSISTANT.id, role: "assistant", text: "Hi!", ts: 1790656547205, complete: true },
    ])
  })

  it("assistant without time.completed AND without finish is incomplete (still streaming)", () => {
    const streaming = { ...PROBE_ASSISTANT, id: "msg_stream", time: { created: 5, streamed: 6 }, finish: undefined }
    const out = toExportMessages([streaming])
    expect(out[0]?.complete).toBe(false)
    expect(out[0]?.text).toBe("Hi!")
  })

  it("assistant completion is recognized from time.completed OR finish", () => {
    const onlyCompleted = { ...PROBE_ASSISTANT, id: "a1", time: { created: 1, completed: 2 }, finish: undefined }
    const onlyFinish = { ...PROBE_ASSISTANT, id: "a2", time: { created: 3 }, finish: "stop" }
    const out = toExportMessages([onlyCompleted, onlyFinish])
    expect(out.map((m) => m.complete)).toEqual([true, true])
  })

  it("joins multiple assistant text parts and ignores non-text parts", () => {
    const multi = {
      ...PROBE_ASSISTANT,
      id: "a3",
      content: [
        { type: "tool", name: "bash" },
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ],
    }
    expect(toExportMessages([multi])[0]?.text).toBe("one\ntwo")
  })

  it("drops garbage elements (non-objects, missing id) instead of throwing", () => {
    expect(toExportMessages([null, 42, "x", { type: "user" }, { id: "", type: "user", text: "t", time: { created: 1 } }])).toEqual([])
  })

  it("non-array input → []", () => {
    expect(toExportMessages(undefined)).toEqual([])
    expect(toExportMessages(null)).toEqual([])
    expect(toExportMessages({})).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// collectCandidates — registry + node:sqlite merge
// ---------------------------------------------------------------------------

const ROW_A = { id: "ses_sqla", directory: "/p/alpha", title: "Sql Alpha", time_updated: 5000 }
const ROW_B = { id: "ses_sqlb", directory: "/p/beta", title: null, time_updated: 900 }

function seededRegistry(paths: Paths, entries: Record<string, { directory: string; title?: string; lastSeenMs?: number }>): void {
  const reg: Record<string, { directory: string; title?: string; lastSeenMs: number }> = {}
  for (const [id, meta] of Object.entries(entries)) reg[id] = { lastSeenMs: 1, ...meta }
  writeSessions(paths, reg)
}

function fakeOpener(rows: unknown[], log: { dbPath: string; sql: string }[] = []): SqliteOpener {
  return (dbPath) => {
    log.push({ dbPath, sql: "" })
    const db: SqliteDb = {
      query: (sql) => {
        log[log.length - 1]!.sql = sql
        return rows
      },
      close: () => {},
    }
    return db
  }
}

describe("collectCandidates", () => {
  it("registry-only when the sqlite opener yields nothing (A2 degraded path)", async () => {
    const paths = freshPaths()
    seededRegistry(paths, { ses_reg: { directory: "/p/reg", title: "Reg" } })
    const out = await collectCandidates(paths, { openSqlite: () => null })
    expect(out).toEqual([{ sessionID: "ses_reg", directory: "/p/reg", title: "Reg" }])
  })

  it("includes sqlite rows newer than last_sync_ms; older ones only when registered", async () => {
    const paths = freshPaths()
    writeSyncState(paths, { last_sync_ms: 1000, wings: { w: 1000 }, mined_ids: {} })
    seededRegistry(paths, { ses_sqlb: { directory: "/registry/beta" } }) // old row, but registered
    const out = await collectCandidates(paths, {
      openSqlite: fakeOpener([ROW_A, ROW_B, { garbage: true }]),
      dbPath: join(tmp, "opencode.db"),
    })
    const ids = out.map((c) => c.sessionID).sort()
    expect(ids).toEqual(["ses_sqla", "ses_sqlb"])
  })

  it("backfill: true includes every sqlite row regardless of time_updated", async () => {
    const paths = freshPaths()
    writeSyncState(paths, { last_sync_ms: 999_999, wings: { w: 999_999 }, mined_ids: {} })
    const out = await collectCandidates(paths, {
      openSqlite: fakeOpener([ROW_B]),
      dbPath: join(tmp, "opencode.db"),
      backfill: true,
    })
    expect(out.map((c) => c.sessionID)).toEqual(["ses_sqlb"])
  })

  it("dedups by sessionID: registry directory wins, sqlite fills a missing title", async () => {
    const paths = freshPaths()
    seededRegistry(paths, { ses_sqla: { directory: "/registry/alpha" } }) // no title
    const out = await collectCandidates(paths, {
      openSqlite: fakeOpener([{ ...ROW_A, directory: "/elsewhere" }]),
      dbPath: join(tmp, "opencode.db"),
    })
    expect(out).toEqual([{ sessionID: "ses_sqla", directory: "/registry/alpha", title: "Sql Alpha" }])
  })

  it("sqlite-only sessions map straight to candidates (no registry write)", async () => {
    const paths = freshPaths()
    const out = await collectCandidates(paths, {
      openSqlite: fakeOpener([ROW_B]),
      dbPath: join(tmp, "opencode.db"),
    })
    expect(out).toEqual([{ sessionID: ROW_B.id, directory: ROW_B.directory }])
    expect(readSessions(paths)).toEqual({})
  })

  it("SELECT touches only session_v2 discovery columns", async () => {
    const paths = freshPaths()
    const log: { dbPath: string; sql: string }[] = []
    const dbPath = join(tmp, "opencode.db")
    await collectCandidates(paths, { openSqlite: fakeOpener([ROW_A], log), dbPath })
    expect(log[0]?.dbPath).toBe(dbPath)
    expect(log[0]?.sql).toBe("SELECT id, directory, title, time_updated FROM session_v2")
  })

  it("a throwing opener degrades to registry-only without crashing", async () => {
    const paths = freshPaths()
    seededRegistry(paths, { ses_reg: { directory: "/p/reg" } })
    const out = await collectCandidates(paths, {
      openSqlite: () => {
        throw new Error("boom")
      },
    })
    expect(out).toEqual([{ sessionID: "ses_reg", directory: "/p/reg" }])
  })

  it("the db handle is closed after reading", async () => {
    const paths = freshPaths()
    let closed = 0
    const opener: SqliteOpener = () => ({
      query: () => [ROW_A],
      close: () => {
        closed++
      },
    })
    await collectCandidates(paths, { openSqlite: opener, dbPath: join(tmp, "x.db") })
    expect(closed).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// runSync — the sync engine (all fake deps)
// ---------------------------------------------------------------------------

describe("runSync", () => {
  it("no candidates → nothing happens (no files, no state, no toasts)", async () => {
    const paths = freshPaths()
    const toast = fakeToast()
    const deps = fakeDeps({ candidates: [] })
    await runSync(deps, paths, opts(paths, toast.fn))
    expect(deps.mineCalls).toEqual([])
    expect(toast.calls).toEqual([])
    expect(readSyncState(paths)).toEqual({ last_sync_ms: 0, wings: {}, mined_ids: {} })
    expect(existsSync(paths.syncDir)).toBe(false)
  })

  it("one wing's mine error does not stall the other wing (cursor, ids, cleanup)", async () => {
    const paths = freshPaths()
    const toast = fakeToast()
    const deps = fakeDeps({
      candidates: [
        { sessionID: "ses_a", directory: "/p/alpha", title: "Alpha" },
        { sessionID: "ses_b", directory: "/p/beta" },
      ],
      context: {
        ses_a: [msg({ id: "a1" }), msg({ id: "a2", role: "assistant", ts: 2000 })],
        ses_b: [msg({ id: "b1" }), msg({ id: "b2", role: "assistant", ts: 2000 })],
      },
      mine: (_dir, wing) =>
        wing === "alpha"
          ? Promise.resolve({ ok: false, error: "boom" })
          : Promise.resolve({ ok: true, stdout: "Drawers filed: 2" }),
    })
    await runSync(deps, paths, opts(paths, toast.fn))

    // beta advanced and cleaned; alpha untouched with its file left behind
    const st = readSyncState(paths)
    expect(st.wings.alpha).toBeUndefined()
    expect(st.wings.beta).toBe(NOW)
    expect(st.last_sync_ms).toBe(NOW)
    expect(existsSync(join(paths.syncDir, "alpha"))).toBe(true)
    expect(readdirSync(join(paths.syncDir, "alpha"))).toHaveLength(1)
    expect(existsSync(join(paths.syncDir, "beta"))).toBe(false)

    // message-level ids committed ONLY for the successful wing
    expect(Object.keys(st.mined_ids).sort()).toEqual(["b1", "b2"])

    // toasts: wing progress for beta only, error for alpha, final summary
    expect(toast.calls).toContainEqual(["info", "MemPalace", "wing beta done (2/2)"])
    expect(toast.calls).toContainEqual(["error", "MemPalace", "mine failed (alpha): boom"])
    expect(toast.calls).toContainEqual([
      "success",
      "MemPalace",
      "mined 1 session(s) → beta (2 drawers), 2 message(s) still waiting",
    ])
  })

  it("a session with <2 exportable messages and nothing incomplete is skipped entirely (Focus #3)", async () => {
    const paths = freshPaths()
    const toast = fakeToast()
    const deps = fakeDeps({
      candidates: [
        { sessionID: "ses_solo", directory: "/p/solo" }, // 1 message → skipped
        { sessionID: "ses_real", directory: "/p/alpha" },
      ],
      context: {
        ses_solo: [msg({ id: "s1" })],
        ses_real: [msg({ id: "r1" }), msg({ id: "r2", ts: 2000 })],
      },
    })
    await runSync(deps, paths, opts(paths, toast.fn))

    expect(deps.mineCalls).toEqual([{ wingDir: join(paths.syncDir, "alpha"), wing: "alpha" }])
    expect(existsSync(join(paths.syncDir, "solo"))).toBe(false)
    expect(Object.keys(readSyncState(paths).mined_ids).sort()).toEqual(["r1", "r2"])
  })

  it("readContext throwing skips that session (registered for retry) and continues the rest", async () => {
    const paths = freshPaths()
    const toast = fakeToast()
    const deps = fakeDeps({
      candidates: [
        { sessionID: "ses_bad", directory: "/p/bad", title: "Bad" },
        { sessionID: "ses_good", directory: "/p/good" },
      ],
      context: {
        ses_good: [msg({ id: "g1" }), msg({ id: "g2", ts: 2000 })],
      },
      mine: () => Promise.resolve({ ok: true, stdout: "" }),
    })
    await runSync(deps, paths, opts(paths, toast.fn))

    const st = readSyncState(paths)
    expect(st.wings.good).toBe(NOW)
    expect(Object.keys(st.mined_ids)).toEqual(["g1", "g2"])
    // the failed session stays discoverable via the registry (design §7)
    expect(readSessions(paths)["ses_bad"]).toMatchObject({ directory: "/p/bad", title: "Bad" })
    expect(toast.calls).toContainEqual(["success", "MemPalace", "mined 1 session(s) → good, queue empty"])
  })

  it("writes the transcript into the right wing dir and cleans up after success", async () => {
    const paths = freshPaths()
    const toast = fakeToast()
    const messages = [msg({ id: "m1", text: "hello", ts: Date.UTC(2026, 8, 29, 1, 2, 3) }), msg({ id: "m2", role: "assistant", text: "hi", ts: Date.UTC(2026, 8, 29, 1, 2, 4) })]
    let seenFiles: string[] = []
    let seenContent = ""
    const deps = fakeDeps({
      candidates: [{ sessionID: "ses_x", directory: "/p/alpha", title: "My Title" }],
      context: { ses_x: messages },
      mine: (wingDir) => {
        seenFiles = readdirSync(wingDir)
        seenContent = readFileSync(join(wingDir, seenFiles[0]!), "utf8")
        return Promise.resolve({ ok: true, stdout: "" })
      },
    })
    await runSync(deps, paths, opts(paths, toast.fn))

    expect(seenFiles).toHaveLength(1)
    expect(seenFiles[0]).toMatch(/^sync_\d{4}-\d{2}-\d{2}_My Title_ses_x_[0-9a-f]{12}\.txt$/)
    const expected = buildTranscript("My Title", "ses_x", messages, new Date(NOW)) + "\n"
    expect(seenContent).toBe(expected)
    // wing dir and (now-empty) sync dir are removed
    expect(existsSync(join(paths.syncDir, "alpha"))).toBe(false)
    expect(existsSync(paths.syncDir)).toBe(false)
  })

  it("two sessions in the SAME wing are exported as two files and mined in one mine call", async () => {
    const paths = freshPaths()
    const toast = fakeToast()
    let filesAtMine: string[] = []
    const deps = fakeDeps({
      candidates: [
        { sessionID: "ses_1", directory: "/p/alpha" },
        { sessionID: "ses_2", directory: "D:\\other\\path\\alpha" }, // same wing via sanitized last segment
      ],
      context: {
        ses_1: [msg({ id: "m1" }), msg({ id: "m2", ts: 2000 })],
        ses_2: [msg({ id: "n1", text: "hey", ts: 3000 }), msg({ id: "n2", text: "yo", ts: 4000 })],
      },
      mine: (wingDir) => {
        filesAtMine = readdirSync(wingDir)
        return Promise.resolve({ ok: true, stdout: "Drawers filed: 1" })
      },
    })
    await runSync(deps, paths, opts(paths, toast.fn))

    expect(filesAtMine).toHaveLength(2)
    expect(deps.mineCalls).toEqual([{ wingDir: join(paths.syncDir, "alpha"), wing: "alpha" }])
    const st = readSyncState(paths)
    expect(Object.keys(st.mined_ids).sort()).toEqual(["m1", "m2", "n1", "n2"])
    expect(st.wings.alpha).toBe(NOW)
    expect(existsSync(paths.syncDir)).toBe(false)
    expect(toast.calls).toContainEqual(["success", "MemPalace", "mined 2 session(s) → alpha (1 drawers), queue empty"])
  })

  it("incomplete replies clamp the wing cursor below the in-flight message", async () => {
    const paths = freshPaths()
    const toast = fakeToast()
    const deps = fakeDeps({
      candidates: [{ sessionID: "ses_i", directory: "/p/alpha" }],
      context: {
        ses_i: [
          msg({ id: "i1" }),
          msg({ id: "i2", ts: 2000 }),
          msg({ id: "i3", role: "assistant", text: "partial", ts: 5000, complete: false }),
        ],
      },
    })
    await runSync(deps, paths, opts(paths, toast.fn))

    const st = readSyncState(paths)
    expect(st.wings.alpha).toBe(4999) // min(NOW, 5000-1)
    expect(Object.keys(st.mined_ids).sort()).toEqual(["i1", "i2"])
    expect(toast.calls).toContainEqual(["success", "MemPalace", "mined 1 session(s) → alpha, 1 message(s) still waiting"])
  })

  it("busy mine retries through the backoff sequence (fake timers) and succeeds", async () => {
    const paths = freshPaths()
    const toast = fakeToast()
    const deps = fakeDeps({
      candidates: [{ sessionID: "ses_z", directory: "/p/alpha" }],
      context: { ses_z: [msg({ id: "z1" }), msg({ id: "z2", ts: 2000 })] },
      mine: (_dir, _wing, call) =>
        call < 3
          ? Promise.resolve({ ok: false, error: "Error: palace lock is held by another instance" })
          : Promise.resolve({ ok: true, stdout: "" }),
      random: () => 0, // deterministic: delay = base + 0ms jitter
    })
    vi.useFakeTimers()
    const running = runSync(deps, paths, opts(paths, toast.fn))
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]!)
    expect(deps.mineCalls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1]!)
    await running
    expect(deps.mineCalls).toHaveLength(3)

    const st = readSyncState(paths)
    expect(st.wings.alpha).toBe(NOW)
    expect(Object.keys(st.mined_ids).sort()).toEqual(["z1", "z2"])
    expect(existsSync(join(paths.syncDir, "alpha"))).toBe(false)
    expect(toast.calls.some(([, , m]) => m === "palace busy (another instance mining?) — backing off, will retry")).toBe(true)
  })

  it("busy retries exhausted → wing abandoned, files kept, cursor untouched", async () => {
    const paths = freshPaths()
    const toast = fakeToast()
    const deps = fakeDeps({
      candidates: [{ sessionID: "ses_z", directory: "/p/alpha" }],
      context: { ses_z: [msg({ id: "z1" }), msg({ id: "z2", ts: 2000 })] },
      mine: () => Promise.resolve({ ok: false, error: "lock is held by someone" }),
      random: () => 0,
    })
    vi.useFakeTimers()
    const running = runSync(deps, paths, opts(paths, toast.fn))
    await vi.runAllTimersAsync()
    await running

    expect(deps.mineCalls).toHaveLength(RETRY_DELAYS_MS.length + 1)
    const st = readSyncState(paths)
    expect(st).toEqual({ last_sync_ms: 0, wings: {}, mined_ids: {} })
    expect(readdirSync(join(paths.syncDir, "alpha"))).toHaveLength(1)
    expect(toast.calls.some(([, , m]) => m.startsWith("palace busy"))).toBe(true)
    // no success summary: nothing was mined
    expect(toast.calls.some(([v]) => v === "success")).toBe(false)
  })

  it("5s debounce: a second start within the window is skipped", async () => {
    const paths = freshPaths()
    const toast = fakeToast()
    let clock = 100_000
    const deps = fakeDeps({
      candidates: [{ sessionID: "ses_d", directory: "/p/alpha" }],
      context: { ses_d: [msg({ id: "d1" }), msg({ id: "d2", ts: 2000 })] },
      now: () => clock,
    })
    await runSync(deps, paths, opts(paths, toast.fn))
    expect(deps.candidateCalls).toBe(1)

    clock += SYNC_DEBOUNCE_MS - 1
    await runSync(deps, paths, opts(paths, toast.fn))
    expect(deps.candidateCalls).toBe(1) // debounced

    clock += 1 // exactly SYNC_DEBOUNCE_MS since the last start
    await runSync(deps, paths, opts(paths, toast.fn))
    expect(deps.candidateCalls).toBe(2)
  })

  it("miningLock: a concurrent second run returns without starting (lock, not debounce)", async () => {
    const paths = freshPaths()
    const toast = fakeToast()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const deps = fakeDeps({
      candidates: [{ sessionID: "ses_c", directory: "/p/alpha" }],
    })
    deps.readContext = async () => {
      await gate
      return [msg({ id: "c1" }), msg({ id: "c2", ts: 2000 })]
    }
    // runSync sets its lock synchronously before the first await, so by the
    // time this expression yields, `mining` is already true.
    const first = runSync(deps, paths, opts(paths, toast.fn))
    // Second run with a clock PAST the debounce window: only the lock stops it.
    const deps2 = fakeDeps({ candidates: [], now: () => NOW + SYNC_DEBOUNCE_MS })
    await runSync(deps2, paths, opts(paths, toast.fn))
    expect(deps2.candidateCalls).toBe(0)

    release()
    await first
    expect(deps.candidateCalls).toBe(1)
    expect(deps.mineCalls).toHaveLength(1)
  })

  it("an unexpected internal error never rejects (logged instead)", async () => {
    const paths = freshPaths()
    const toast = fakeToast()
    const deps = fakeDeps({
      candidates: [{ sessionID: "ses_x", directory: "/p/alpha" }],
    })
    // readContext rejects with a non-Error; must be swallowed per-candidate
    deps.readContext = async () => {
      throw "kaboom"
    }
    await expect(runSync(deps, paths, opts(paths, toast.fn))).resolves.toBeUndefined()
    expect(deps.mineCalls).toEqual([])
  })

  it("empty wings (everything deduped by mined_ids) produce no mine and no cursor move", async () => {
    const paths = freshPaths()
    const toast = fakeToast()
    writeSyncState(paths, { last_sync_ms: 123, wings: { alpha: 123 }, mined_ids: { e1: 1, e2: 2 } })
    const deps = fakeDeps({
      candidates: [{ sessionID: "ses_e", directory: "/p/alpha" }],
      context: { ses_e: [msg({ id: "e1" }), msg({ id: "e2", ts: 2000 })] },
    })
    await runSync(deps, paths, opts(paths, toast.fn))
    expect(deps.mineCalls).toEqual([])
    expect(readSyncState(paths)).toEqual({ last_sync_ms: 123, wings: { alpha: 123 }, mined_ids: { e1: 1, e2: 2 } })
    expect(toast.calls).toEqual([])
  })
})

describe("loadMinedIds", () => {
  it("is the key set of sync_state.json's mined_ids (Ruling 1)", () => {
    const paths = freshPaths()
    writeSyncState(paths, { last_sync_ms: 5, wings: { w: 5 }, mined_ids: { a: 1, b: 2 } })
    expect(loadMinedIds(paths)).toEqual(new Set(["a", "b"]))
  })
})
