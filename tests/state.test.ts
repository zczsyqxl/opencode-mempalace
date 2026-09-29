import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { buildPaths, type Paths } from "../src/paths"
import {
  MINED_IDS_MAX_AGE_MS,
  MINED_IDS_MAX_ENTRIES,
  bumpCounter,
  markWingSynced,
  mergeExportedIds,
  mergeSession,
  parseSyncState,
  readCounters,
  readSessions,
  readSyncState,
  writeCounters,
  writeSessions,
  writeSyncState,
} from "../src/state"

/** Fresh temp dir per test; never touch the real ~/.mempalace. */
let tmp = ""
afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true })
    tmp = ""
  }
})

function freshPaths(): Paths {
  tmp = mkdtempSync(join(tmpdir(), "mp-state-"))
  return buildPaths(join(tmp, "base"))
}

/** Seed a raw file (corrupted/malformed fixtures) creating its parent dir. */
function seedFile(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, "utf8")
}

const EMPTY = { last_sync_ms: 0, wings: {}, mined_ids: {} }

describe("parseSyncState", () => {
  it("null (no file) → {0, {}, {}}", () => {
    expect(parseSyncState(null)).toEqual(EMPTY)
  })

  it("garbage JSON, non-object JSON, and empty string → {0, {}, {}}", () => {
    for (const raw of ["not json at all", "", "{", "123", '"a string"', "true", "[1,2,3]", "null"]) {
      expect(parseSyncState(raw)).toEqual(EMPTY)
    }
  })

  it("passes valid state through untouched", () => {
    const raw = JSON.stringify({
      last_sync_ms: 1234,
      wings: { "my-proj": 1234, other: 999 },
      mined_ids: { msg_a: 1000, msg_b: 1234 },
    })
    expect(parseSyncState(raw)).toEqual({
      last_sync_ms: 1234,
      wings: { "my-proj": 1234, other: 999 },
      mined_ids: { msg_a: 1000, msg_b: 1234 },
    })
  })

  it("filters non-numeric mined_ids entries instead of crashing (Review Focus #4)", () => {
    const raw = JSON.stringify({
      last_sync_ms: 5,
      wings: { w: 5 },
      mined_ids: {
        good: 7,
        str: "x",
        nul: null,
        bool: true,
        obj: { ts: 1 },
        arr: [1],
      },
    })
    expect(parseSyncState(raw).mined_ids).toEqual({ good: 7 })
  })

  it("applies the same numeric filter to wings and defaults a bad last_sync_ms", () => {
    const raw = JSON.stringify({
      last_sync_ms: "not-a-number",
      wings: { ok: 10, bad: "x", worse: null },
      mined_ids: {},
    })
    expect(parseSyncState(raw)).toEqual({ last_sync_ms: 0, wings: { ok: 10 }, mined_ids: {} })
  })

  it("treats non-object wings/mined_ids values as empty", () => {
    const raw = JSON.stringify({ last_sync_ms: 3, wings: 42, mined_ids: [1, 2] })
    expect(parseSyncState(raw)).toEqual({ last_sync_ms: 3, wings: {}, mined_ids: {} })
  })
})

describe("readSyncState / writeSyncState", () => {
  it("missing file → {0, {}, {}}", () => {
    const paths = freshPaths()
    expect(readSyncState(paths)).toEqual(EMPTY)
  })

  it("corrupted file → {0, {}, {}}", () => {
    const paths = freshPaths()
    seedFile(paths.stateFile, "}}}garbage{{{")
    expect(readSyncState(paths)).toEqual(EMPTY)
  })

  it("round-trips a full state through sync_state.json (creating baseDir)", () => {
    const paths = freshPaths()
    const st = {
      last_sync_ms: 77,
      wings: { alpha: 77, beta: 12 },
      mined_ids: { m1: 77, m2: 12 },
    }
    writeSyncState(paths, st)

    expect(existsSync(paths.stateFile)).toBe(true)
    expect(readSyncState(paths)).toEqual(st)
    // The persisted file is JSON matching the V1 field names.
    const onDisk = JSON.parse(readFileSync(paths.stateFile, "utf8")) as Record<string, unknown>
    expect(onDisk.last_sync_ms).toBe(77)
    expect(onDisk.wings).toEqual({ alpha: 77, beta: 12 })
    expect(onDisk.mined_ids).toEqual({ m1: 77, m2: 12 })
  })

  it("never throws when the target location is unwritable", () => {
    tmp = mkdtempSync(join(tmpdir(), "mp-state-"))
    // A regular file as baseDir: every mkdir/write under it fails (ENOTDIR),
    // which stands in for a read-only directory on Windows.
    const blocker = join(tmp, "blocker")
    writeFileSync(blocker, "not a directory", "utf8")
    const paths = buildPaths(blocker)

    expect(() => writeSyncState(paths, EMPTY)).not.toThrow()
    expect(readSyncState(paths)).toEqual(EMPTY)
  })
})

describe("markWingSynced", () => {
  it("sets the wing cursor and last_sync_ms = ts for a single wing", () => {
    const st = markWingSynced(EMPTY, "my-proj", 500)
    expect(st).toEqual({ last_sync_ms: 500, wings: { "my-proj": 500 }, mined_ids: {} })
  })

  it("last_sync_ms = min across all wings after marking", () => {
    let st = markWingSynced(EMPTY, "a", 100)
    st = markWingSynced(st, "b", 50)
    expect(st.last_sync_ms).toBe(50)
  })

  it("a lagging wing pins last_sync_ms even as another wing advances (one wing never stalls the field for others' cursors)", () => {
    let st = markWingSynced(EMPTY, "a", 100)
    st = markWingSynced(st, "b", 50)
    st = markWingSynced(st, "a", 200)
    expect(st.wings).toEqual({ a: 200, b: 50 })
    expect(st.last_sync_ms).toBe(50)
    // Once the laggard catches up, the min advances.
    st = markWingSynced(st, "b", 300)
    expect(st.last_sync_ms).toBe(200)
  })

  it("is pure: the input state is not mutated", () => {
    const original = { last_sync_ms: 10, wings: { a: 10 }, mined_ids: { m: 10 } }
    const next = markWingSynced(original, "b", 5)

    expect(original).toEqual({ last_sync_ms: 10, wings: { a: 10 }, mined_ids: { m: 10 } })
    expect(next).not.toBe(original)
    expect(next.wings).not.toBe(original.wings)
    expect(next.mined_ids).not.toBe(original.mined_ids)
  })
})

describe("mergeExportedIds", () => {
  const now = 1_800_000_000_000

  it("exports the retention constants with the exact V1 values", () => {
    expect(MINED_IDS_MAX_AGE_MS).toBe(90 * 24 * 60 * 60 * 1000)
    expect(MINED_IDS_MAX_ENTRIES).toBe(200_000)
  })

  it("merges per-wing exported IDs into the existing mined set", () => {
    const byWing = new Map<string, Map<string, number>>([
      ["a", new Map([["id1", now - 10], ["id2", now - 20]])],
      ["b", new Map([["id3", now - 5]])],
    ])
    const merged = mergeExportedIds({ old1: now - 30 }, byWing, now)

    expect(merged).toEqual({ old1: now - 30, id1: now - 10, id2: now - 20, id3: now - 5 })
  })

  it("keeps the newest timestamp when an ID is already mined", () => {
    const byWing = new Map([["a", new Map([["dup", now - 100]])]])
    expect(mergeExportedIds({ dup: now - 1 }, byWing, now).dup).toBe(now - 1)
    expect(mergeExportedIds({ dup: now - 500 }, byWing, now).dup).toBe(now - 100)
  })

  it("prunes entries older than 90 days (age retention), keeps the exact-90d boundary", () => {
    const mined = {
      ancient: now - MINED_IDS_MAX_AGE_MS - 1,
      exactly90: now - MINED_IDS_MAX_AGE_MS,
      fresh: now - 1000,
    }
    const byWing = new Map([["a", new Map([["new-export", now - 50]])]])

    expect(mergeExportedIds(mined, byWing, now)).toEqual({
      exactly90: now - MINED_IDS_MAX_AGE_MS,
      fresh: now - 1000,
      "new-export": now - 50,
    })
  })

  it("prunes aged-out entries even when they arrive via byWing (retention is by age, not origin)", () => {
    const byWing = new Map([["a", new Map([["stale-export", now - MINED_IDS_MAX_AGE_MS - 5]])]])
    expect(mergeExportedIds({}, byWing, now)).toEqual({})
  })

  it("caps at 200k entries, keeping the NEWEST by timestamp (count retention)", () => {
    // 200_500 candidates: id-i has ts = now - i, so larger i = older.
    const entries = new Map<string, number>()
    for (let i = 0; i < 200_500; i++) entries.set(`id-${i}`, now - i)
    const byWing = new Map([["a", entries]])

    const merged = mergeExportedIds({}, byWing, now)

    const keys = Object.keys(merged)
    expect(keys.length).toBe(MINED_IDS_MAX_ENTRIES)
    expect(merged["id-0"]).toBe(now)
    expect(merged["id-199999"]).toBe(now - 199_999)
    expect(merged["id-200000"]).toBeUndefined()
    expect(merged["id-200499"]).toBeUndefined()
  })

  it("applies age pruning before the count cap (a capped set is already age-fresh)", () => {
    // 100 entries, half ancient: only the fresh half survives regardless of count.
    const mined: Record<string, number> = {}
    for (let i = 0; i < 50; i++) mined[`old-${i}`] = now - MINED_IDS_MAX_AGE_MS - 1000 - i
    for (let i = 0; i < 50; i++) mined[`new-${i}`] = now - i

    const merged = mergeExportedIds(mined, new Map(), now)

    expect(Object.keys(merged).length).toBe(50)
    expect(merged["new-0"]).toBe(now)
    expect(merged["old-0"]).toBeUndefined()
  })

  it("is pure: the input mined record is not mutated", () => {
    const mined = { a: now - 1 }
    mergeExportedIds(mined, new Map([["w", new Map([["b", now]])]]), now)
    expect(mined).toEqual({ a: now - 1 })
  })
})

describe("bumpCounter", () => {
  it("undefined counter starts at {1, 0}, unarmed", () => {
    expect(bumpCounter(undefined, 15)).toEqual({
      counter: { humanMsgs: 1, lastCheckpoint: 0 },
      armed: false,
    })
  })

  it("increments humanMsgs and keeps lastCheckpoint untouched", () => {
    expect(bumpCounter({ humanMsgs: 3, lastCheckpoint: 0 }, 15)).toEqual({
      counter: { humanMsgs: 4, lastCheckpoint: 0 },
      armed: false,
    })
  })

  it("brief examples: from {15,0} armed, from {14,0} not (V1 boundary)", () => {
    expect(bumpCounter({ humanMsgs: 15, lastCheckpoint: 0 }, 15).armed).toBe(true)
    expect(bumpCounter({ humanMsgs: 14, lastCheckpoint: 0 }, 15).armed).toBe(false)
  })

  it("fires exactly once per boundary crossing", () => {
    // 15th message: counter {14,0} → {15,0}, still unarmed…
    expect(bumpCounter({ humanMsgs: 14, lastCheckpoint: 0 }, 15).armed).toBe(false)
    // …16th message sees the crossed boundary (floor(15/15)=1 > 0) and arms;
    // the consumer then persists lastCheckpoint = floor(16/15) = 1.
    expect(bumpCounter({ humanMsgs: 15, lastCheckpoint: 0 }, 15).armed).toBe(true)
    expect(bumpCounter({ humanMsgs: 16, lastCheckpoint: 1 }, 15).armed).toBe(false)
    expect(bumpCounter({ humanMsgs: 29, lastCheckpoint: 1 }, 15).armed).toBe(false)
    // Next boundary (floor(30/15)=2 > 1) arms again — once.
    expect(bumpCounter({ humanMsgs: 30, lastCheckpoint: 1 }, 15).armed).toBe(true)
  })

  it("honours non-default intervals", () => {
    expect(bumpCounter({ humanMsgs: 4, lastCheckpoint: 0 }, 5).armed).toBe(false)
    expect(bumpCounter({ humanMsgs: 5, lastCheckpoint: 0 }, 5).armed).toBe(true)
    expect(bumpCounter({ humanMsgs: 5, lastCheckpoint: 1 }, 5).armed).toBe(false)
  })
})

describe("readCounters / writeCounters", () => {
  it("missing file → {}", () => {
    expect(readCounters(freshPaths())).toEqual({})
  })

  it("round-trips counters through hook_state/opencode_counters.json (creating the dir)", () => {
    const paths = freshPaths()
    writeCounters(paths, {
      "ses_1": { humanMsgs: 16, lastCheckpoint: 1 },
      "ses_2": { humanMsgs: 3, lastCheckpoint: 0 },
    })

    expect(existsSync(paths.countersFile)).toBe(true)
    expect(readCounters(paths)).toEqual({
      ses_1: { humanMsgs: 16, lastCheckpoint: 1 },
      ses_2: { humanMsgs: 3, lastCheckpoint: 0 },
    })
  })

  it("corrupted file → {}", () => {
    const paths = freshPaths()
    seedFile(paths.countersFile, "{{{nope")
    expect(readCounters(paths)).toEqual({})
  })

  it("drops malformed entries, keeps valid ones", () => {
    const paths = freshPaths()
    seedFile(
      paths.countersFile,
      JSON.stringify({
        good: { humanMsgs: 2, lastCheckpoint: 0 },
        strMsgs: { humanMsgs: "x", lastCheckpoint: 0 },
        missingTs: { humanMsgs: 5 },
        notAnObject: 42,
      }),
    )
    expect(readCounters(paths)).toEqual({ good: { humanMsgs: 2, lastCheckpoint: 0 } })
  })

  it("never throws when the target location is unwritable", () => {
    tmp = mkdtempSync(join(tmpdir(), "mp-state-"))
    const blocker = join(tmp, "blocker")
    writeFileSync(blocker, "not a directory", "utf8")
    const paths = buildPaths(blocker)

    expect(() => writeCounters(paths, { s: { humanMsgs: 1, lastCheckpoint: 0 } })).not.toThrow()
    expect(readCounters(paths)).toEqual({})
  })
})

describe("mergeSession", () => {
  it("registers a new session", () => {
    const reg = mergeSession({}, "ses_1", { directory: "D:/p", title: "My chat", lastSeenMs: 42 })
    expect(reg).toEqual({ ses_1: { directory: "D:/p", title: "My chat", lastSeenMs: 42 } })
  })

  it("upserts: an existing id is replaced by the newer meta", () => {
    const initial = mergeSession({}, "ses_1", { directory: "D:/old", lastSeenMs: 1 })
    const updated = mergeSession(initial, "ses_1", { directory: "D:/new", lastSeenMs: 9 })

    expect(updated).toEqual({ ses_1: { directory: "D:/new", lastSeenMs: 9 } })
    // Other sessions survive.
    const both = mergeSession(updated, "ses_2", { directory: "D:/x", lastSeenMs: 5 })
    expect(Object.keys(both).sort()).toEqual(["ses_1", "ses_2"])
  })

  it("stores meta without a title when none is given", () => {
    const reg = mergeSession({}, "ses_1", { directory: "D:/p", lastSeenMs: 3 })
    expect(reg["ses_1"]).toEqual({ directory: "D:/p", lastSeenMs: 3 })
  })

  it("is pure: the input registry is not mutated", () => {
    const original = { ses_1: { directory: "D:/a", lastSeenMs: 1 } }
    mergeSession(original, "ses_2", { directory: "D:/b", lastSeenMs: 2 })
    expect(original).toEqual({ ses_1: { directory: "D:/a", lastSeenMs: 1 } })
  })
})

describe("readSessions / writeSessions", () => {
  it("missing file → {}", () => {
    expect(readSessions(freshPaths())).toEqual({})
  })

  it("round-trips sessions through hook_state/oc_sessions.json (creating the dir)", () => {
    const paths = freshPaths()
    writeSessions(paths, {
      "ses_1": { directory: "D:/p", title: "Chat", lastSeenMs: 10 },
      "ses_2": { directory: "D:/q", lastSeenMs: 20 },
    })

    expect(existsSync(paths.sessionsRegistry)).toBe(true)
    expect(readSessions(paths)).toEqual({
      ses_1: { directory: "D:/p", title: "Chat", lastSeenMs: 10 },
      ses_2: { directory: "D:/q", lastSeenMs: 20 },
    })
  })

  it("corrupted file → {}", () => {
    const paths = freshPaths()
    seedFile(paths.sessionsRegistry, "not json")
    expect(readSessions(paths)).toEqual({})
  })

  it("drops malformed entries, keeps valid ones; a non-string title is omitted, not fatal", () => {
    const paths = freshPaths()
    seedFile(
      paths.sessionsRegistry,
      JSON.stringify({
        ok: { directory: "D:/p", title: "T", lastSeenMs: 5 },
        noDirectory: { lastSeenMs: 5 },
        badSeen: { directory: "D:/q", lastSeenMs: "x" },
        badTitle: { directory: "D:/r", lastSeenMs: 7, title: 9 },
        scalar: "nope",
      }),
    )
    expect(readSessions(paths)).toEqual({
      ok: { directory: "D:/p", title: "T", lastSeenMs: 5 },
      badTitle: { directory: "D:/r", lastSeenMs: 7 },
    })
  })

  it("never throws when the target location is unwritable", () => {
    tmp = mkdtempSync(join(tmpdir(), "mp-state-"))
    const blocker = join(tmp, "blocker")
    writeFileSync(blocker, "not a directory", "utf8")
    const paths = buildPaths(blocker)

    expect(() => writeSessions(paths, { s: { directory: "D:/p", lastSeenMs: 1 } })).not.toThrow()
    expect(readSessions(paths)).toEqual({})
  })
})
