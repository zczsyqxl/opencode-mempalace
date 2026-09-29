import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  MEMORY_LOG_DEFAULT_N,
  MINE_LOG_TAIL_LINES,
  commandArgs,
  countPendingFiles,
  formatLocalDateTime,
  formatLocalTime,
  parseMemoryLogArgs,
  readLastLines,
  readLines,
  renderMemoryLog,
  renderMemoryStatus,
} from "../src/commands"
import type { SyncState } from "../src/state"

/** Fresh temp dir per test; never touch the real ~/.mempalace. */
let tmp = ""
afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true })
    tmp = ""
  }
})

// ---------------------------------------------------------------------------
// parseMemoryLogArgs — V1 usage `/memory-log [N] [filter]`
// ---------------------------------------------------------------------------

describe("parseMemoryLogArgs", () => {
  it("no args → default n=20, no filter", () => {
    expect(parseMemoryLogArgs("")).toEqual({ n: 20 })
    expect(parseMemoryLogArgs("   ")).toEqual({ n: 20 })
    expect(MEMORY_LOG_DEFAULT_N).toBe(20)
  })

  it('"5 search" → n=5, filter="search"', () => {
    expect(parseMemoryLogArgs("5 search")).toEqual({ n: 5, filter: "search" })
  })

  it('"5" → n=5, no filter', () => {
    expect(parseMemoryLogArgs("5")).toEqual({ n: 5 })
  })

  it('"search" → default n, filter="search"', () => {
    expect(parseMemoryLogArgs("search")).toEqual({ n: 20, filter: "search" })
  })

  it("n is clamped to 1..200", () => {
    expect(parseMemoryLogArgs("0").n).toBe(1)
    expect(parseMemoryLogArgs("999").n).toBe(200)
  })

  it("multi-token filter keeps its spaces", () => {
    expect(parseMemoryLogArgs("5 deep search")).toEqual({ n: 5, filter: "deep search" })
  })

  it("leading zeros parse as the number", () => {
    expect(parseMemoryLogArgs("007").n).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// commandArgs — strip an optional leading "/<command>" token
// ---------------------------------------------------------------------------

describe("commandArgs", () => {
  it('strips a leading "/memory-log" token', () => {
    expect(commandArgs("/memory-log 5 search", "memory-log")).toBe("5 search")
    expect(commandArgs("/memory-log", "memory-log")).toBe("")
  })

  it("passes bare args through untouched", () => {
    expect(commandArgs("5 search", "memory-log")).toBe("5 search")
    expect(commandArgs("  5 search  ", "memory-log")).toBe("5 search")
  })

  it("empty prompt → empty string", () => {
    expect(commandArgs("", "memory-log")).toBe("")
  })
})

// ---------------------------------------------------------------------------
// renderMemoryLog — newest n (newest LAST), kind filter, malformed skipped
// ---------------------------------------------------------------------------

/** One interactions.log line, exactly as ilog() writes it. */
function iline(ts: string, kind: string, data: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts, kind, ...data })
}

/** Expected display clock for a UTC ISO ts on THIS machine (property-pinning: matches whatever local timezone runs the suite). */
function localClock(ts: string): string {
  return formatLocalTime(new Date(ts).getTime())
}

describe("renderMemoryLog", () => {
  const THREE = [
    iline("2026-09-29T01:00:01.000Z", "mine", { wing: "alpha" }),
    iline("2026-09-29T01:00:02.000Z", "search", { query: "wing naming" }),
    iline("2026-09-29T01:00:03.000Z", "mine", { wing: "beta" }),
  ]

  it("renders the newest n entries with the NEWEST LAST (V1 order)", () => {
    const out = renderMemoryLog(THREE, 2)
    const lines = out.split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain(localClock("2026-09-29T01:00:02.000Z"))
    expect(lines[0]).toContain("search")
    expect(lines[1]).toContain(localClock("2026-09-29T01:00:03.000Z"))
    expect(lines[1]).toContain("mine")
  })

  it("one line per entry: [HH:MM:SS] kind — compact k=v fields (ts/kind excluded)", () => {
    const out = renderMemoryLog([iline("2026-09-29T01:02:03.456Z", "search", { query: "wing naming", results: 3 })], 20)
    expect(out).toBe(`[${localClock("2026-09-29T01:02:03.456Z")}] search — query=wing naming results=3`)
  })

  it("entry without extra fields renders without a trailing separator", () => {
    expect(renderMemoryLog([iline("2026-09-29T01:02:03.000Z", "mine")], 20)).toBe(`[${localClock("2026-09-29T01:02:03.000Z")}] mine`)
  })

  it("non-string field values render as JSON", () => {
    const out = renderMemoryLog([iline("2026-09-29T01:02:03.000Z", "tool", { input: { a: 1 }, ok: true })], 20)
    expect(out).toBe(`[${localClock("2026-09-29T01:02:03.000Z")}] tool — input={"a":1} ok=true`)
  })

  it("filter matches kind as a case-insensitive substring", () => {
    const out = renderMemoryLog(THREE, 20, "search")
    expect(out).toContain("search")
    expect(out).not.toContain("mine")
    const upper = renderMemoryLog(THREE, 20, "MINE")
    expect(upper.split("\n")).toHaveLength(2)
  })

  it("malformed lines (non-JSON, non-object, missing ts/kind, bad ts) are skipped", () => {
    const lines = [
      "not json",
      "42",
      JSON.stringify({ kind: "mine" }), // no ts
      JSON.stringify({ ts: "2026-09-29T01:00:01.000Z" }), // no kind
      JSON.stringify({ ts: "yesterday", kind: "mine" }), // unparsable ts
      iline("2026-09-29T01:00:02.000Z", "mine"),
    ]
    expect(renderMemoryLog(lines, 20)).toBe(`[${localClock("2026-09-29T01:00:02.000Z")}] mine`)
  })

  it("empty log → friendly no-entries message", () => {
    expect(renderMemoryLog([], 20)).toContain("No MemPalace interactions")
  })

  it("filter that matches nothing → friendly message naming the filter", () => {
    expect(renderMemoryLog(THREE, 20, "zzz")).toContain("zzz")
    expect(renderMemoryLog(THREE, 20, "zzz")).toContain("No MemPalace interactions")
  })
})

// ---------------------------------------------------------------------------
// renderMemoryStatus — markdown health report
// ---------------------------------------------------------------------------

describe("renderMemoryStatus", () => {
  const SYNC_STATE: SyncState = {
    last_sync_ms: Date.UTC(2026, 8, 29, 1, 2, 3),
    wings: {
      alpha: Date.UTC(2026, 8, 29, 1, 2, 3),
      beta: Date.UTC(2026, 8, 28, 9, 0, 0),
    },
    mined_ids: { a: 1, b: 2, c: 3 },
  }

  it("shows newest-wing last sync and dedup watermark separately", () => {
    const out = renderMemoryStatus({
      pendingFiles: 2,
      syncState: SYNC_STATE,
      lastMineLog: [],
      palaceStatus: "",
    })
    // newest wing cursor (alpha) drives "last sync"; last_sync_ms (min across wings) drives the watermark
    expect(out).toContain(`- Last sync (newest wing): ${formatLocalDateTime(Date.UTC(2026, 8, 29, 1, 2, 3))}`)
    expect(out).toContain(`- Dedup watermark (oldest wing): ${formatLocalDateTime(Date.UTC(2026, 8, 29, 1, 2, 3))}`)
    expect(out).toContain(`- alpha: ${formatLocalDateTime(Date.UTC(2026, 8, 29, 1, 2, 3))}`)
    expect(out).toContain(`- beta: ${formatLocalDateTime(Date.UTC(2026, 8, 28, 9, 0, 0))}`)
    expect(out).toContain("Mined messages: 3")
    expect(out).toContain("Pending export files: 2")
  })

  it("diverges when the watermark lags behind the newest wing", () => {
    const out = renderMemoryStatus({
      pendingFiles: 0,
      syncState: {
        last_sync_ms: Date.UTC(2026, 8, 28, 9, 0, 0),
        wings: { alpha: Date.UTC(2026, 8, 29, 12, 0, 0) },
        mined_ids: {},
      },
      lastMineLog: [],
      palaceStatus: "",
    })
    expect(out).toContain(`- Last sync (newest wing): ${formatLocalDateTime(Date.UTC(2026, 8, 29, 12, 0, 0))}`)
    expect(out).toContain(`- Dedup watermark (oldest wing): ${formatLocalDateTime(Date.UTC(2026, 8, 28, 9, 0, 0))}`)
  })

  it("notes that displayed times are local", () => {
    const out = renderMemoryStatus({ pendingFiles: 0, syncState: SYNC_STATE, lastMineLog: [], palaceStatus: "" })
    expect(out).toContain("local timezone")
  })

  it("local-time helpers convert with injectable offsets, incl. day rollover", () => {
    // UTC 2026-09-29T20:00:00Z + UTC+8 (offset -480) → 2026-09-30 04:00 local (next day)
    expect(formatLocalTime(Date.UTC(2026, 8, 29, 20, 0, 0), -480)).toBe("04:00:00")
    expect(formatLocalDateTime(Date.UTC(2026, 8, 29, 20, 0, 0), -480)).toBe("2026-09-30 04:00:00")
    // UTC 2026-09-29T02:00:00Z in UTC-5 (offset +300) → 2026-09-28 21:00 local (previous day)
    expect(formatLocalDateTime(Date.UTC(2026, 8, 29, 2, 0, 0), 300)).toBe("2026-09-28 21:00:00")
    // zero offset keeps UTC verbatim
    expect(formatLocalDateTime(Date.UTC(2026, 8, 29, 1, 2, 3), 0)).toBe("2026-09-29 01:02:03")
  })

  it("includes the mine-log tail and the mempalace status output verbatim", () => {
    const mineLog = ["[t] wing alpha done (2/2)", "[t] mine failed (beta): boom"]
    const out = renderMemoryStatus({
      pendingFiles: 0,
      syncState: SYNC_STATE,
      lastMineLog: mineLog,
      palaceStatus: "Drawers: 12\nWings: 2",
    })
    expect(out).toContain("[t] wing alpha done (2/2)")
    expect(out).toContain("[t] mine failed (beta): boom")
    expect(out).toContain("Drawers: 12")
    expect(out).toContain("Wings: 2")
    expect(MINE_LOG_TAIL_LINES).toBeGreaterThan(0)
  })

  it("fresh palace: never synced, no wings, no log, no CLI → friendly placeholders", () => {
    const out = renderMemoryStatus({
      pendingFiles: 0,
      syncState: { last_sync_ms: 0, wings: {}, mined_ids: {} },
      lastMineLog: [],
      palaceStatus: "",
    })
    expect(out).toContain("never")
    expect(out).toContain("no wings synced yet")
    expect(out).toContain("Mined messages: 0")
    expect(out).toContain("no mine log yet")
    expect(out).toContain("mempalace CLI unavailable")
  })
})

// ---------------------------------------------------------------------------
// IO helpers — best-effort, never throw
// ---------------------------------------------------------------------------

describe("readLastLines / readLines", () => {
  it("returns the newest n lines in file order", () => {
    tmp = mkdtempSync(join(tmpdir(), "mp-cmds-"))
    const file = join(tmp, "hook.log")
    writeFileSync(file, Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join("\n") + "\n")
    expect(readLastLines(file, 3)).toEqual(["L8", "L9", "L10"])
    expect(readLastLines(file, 99)).toHaveLength(10)
  })

  it("missing file → []", () => {
    expect(readLastLines(join(tmpdir(), "mp-cmds-nope", "x.log"), 5)).toEqual([])
    expect(readLines(join(tmpdir(), "mp-cmds-nope", "x.log"))).toEqual([])
  })

  it("readLines drops blank lines (trailing newline)", () => {
    tmp = mkdtempSync(join(tmpdir(), "mp-cmds-"))
    const file = join(tmp, "interactions.log")
    writeFileSync(file, '{"a":1}\n{"a":2}\n\n')
    expect(readLines(file)).toEqual(['{"a":1}', '{"a":2}'])
  })
})

describe("countPendingFiles", () => {
  it("counts files inside syncDir's per-wing subdirectories only", () => {
    tmp = mkdtempSync(join(tmpdir(), "mp-cmds-"))
    const syncDir = join(tmp, "oc-sessions")
    mkdirSync(syncDir)
    mkdirSync(join(syncDir, "alpha"))
    mkdirSync(join(syncDir, "beta"))
    writeFileSync(join(syncDir, "alpha", "sync_1.txt"), "x")
    writeFileSync(join(syncDir, "alpha", "sync_2.txt"), "x")
    writeFileSync(join(syncDir, "beta", "sync_3.txt"), "x")
    writeFileSync(join(syncDir, "README.txt"), "not a wing dir")
    expect(countPendingFiles(syncDir)).toBe(3)
  })

  it("missing syncDir → 0", () => {
    expect(countPendingFiles(join(tmp, "mp-cmds-nope"))).toBe(0)
  })
})
