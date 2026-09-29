import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { buildPaths, type Paths } from "../src/paths"
import { INTERACTIONS_MAX_LINES, makeLoggers } from "../src/logs"

/** Fresh temp dir per test; never touch the real ~/.mempalace. */
let tmp = ""
afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true })
    tmp = ""
  }
})

const ISO_STAMP = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] /

describe("makeLoggers", () => {
  it("hook() appends timestamped lines to hook.log (creating hook_state)", () => {
    tmp = mkdtempSync(join(tmpdir(), "mp-logs-"))
    const paths: Paths = buildPaths(join(tmp, "base"))
    const loggers = makeLoggers(paths, false)

    loggers.hook("hello world")
    loggers.hook("second line")

    const content = readFileSync(paths.hookLog, "utf8")
    const lines = content.trimEnd().split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(ISO_STAMP)
    expect(lines[0].slice(lines[0].indexOf("] ") + 2)).toBe("hello world")
    expect(lines[1].endsWith("second line")).toBe(true)
  })

  it("ilog() appends JSON lines with ts/kind and the payload spread", () => {
    tmp = mkdtempSync(join(tmpdir(), "mp-logs-"))
    const paths: Paths = buildPaths(join(tmp, "base"))
    const loggers = makeLoggers(paths, false)

    loggers.ilog("search", { query: "wing naming", results: 3 })
    loggers.ilog("mine", { outcome: "ok" })

    const lines = readFileSync(paths.interactionsLog, "utf8").trimEnd().split("\n")
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0]) as Record<string, unknown>
    expect(typeof first.ts).toBe("string")
    expect(first.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(first.kind).toBe("search")
    expect(first.query).toBe("wing naming")
    expect(first.results).toBe(3)
    const second = JSON.parse(lines[1]) as Record<string, unknown>
    expect(second.kind).toBe("mine")
    expect(second.outcome).toBe("ok")
  })

  it("does not write debug.log when debug=false", () => {
    tmp = mkdtempSync(join(tmpdir(), "mp-logs-"))
    const paths: Paths = buildPaths(join(tmp, "base"))
    const loggers = makeLoggers(paths, false)

    loggers.debug("secret internals")
    loggers.hook("visible")
    loggers.err("boom")

    expect(existsSync(paths.debugLog)).toBe(false)
    expect(readFileSync(paths.hookLog, "utf8")).toContain("boom")
  })

  it("debug=true writes [ts] lines to debug.log; err() reaches both streams", () => {
    tmp = mkdtempSync(join(tmpdir(), "mp-logs-"))
    const paths: Paths = buildPaths(join(tmp, "base"))
    const loggers = makeLoggers(paths, true)

    loggers.debug("boot")
    loggers.err("mine failed")

    const debugLines = readFileSync(paths.debugLog, "utf8").trimEnd().split("\n")
    expect(debugLines).toHaveLength(2)
    expect(debugLines[0]).toMatch(ISO_STAMP)
    expect(debugLines[0].endsWith("boot")).toBe(true)
    expect(debugLines[1].endsWith("ERROR: mine failed")).toBe(true)

    const hookLines = readFileSync(paths.hookLog, "utf8").trimEnd().split("\n")
    expect(hookLines).toHaveLength(1)
    expect(hookLines[0].endsWith("ERROR: mine failed")).toBe(true)
  })

  it("never throws when the target location is unwritable", () => {
    tmp = mkdtempSync(join(tmpdir(), "mp-logs-"))
    // A regular file as baseDir: every mkdir/append under it fails (ENOTDIR),
    // which stands in for a read-only directory on Windows.
    const blocker = join(tmp, "blocker")
    writeFileSync(blocker, "not a directory", "utf8")
    const paths: Paths = buildPaths(blocker)
    const loggers = makeLoggers(paths, true)

    expect(() => {
      loggers.debug("d")
      loggers.hook("h")
      loggers.err("e")
      loggers.ilog("k", { a: 1 })
      loggers.ilog("k2", { a: 2 })
    }).not.toThrow()
  })

  it("keeps small interactions.log files untouched (no rotation below 600KB)", () => {
    tmp = mkdtempSync(join(tmpdir(), "mp-logs-"))
    const paths: Paths = buildPaths(join(tmp, "base"))
    const loggers = makeLoggers(paths, false)

    loggers.ilog("a", {})
    loggers.ilog("b", {})

    const lines = readFileSync(paths.interactionsLog, "utf8").trimEnd().split("\n")
    expect(lines).toHaveLength(2)
    expect((JSON.parse(lines[0]) as Record<string, unknown>).kind).toBe("a")
    expect((JSON.parse(lines[1]) as Record<string, unknown>).kind).toBe("b")
  })

  it("rotates interactions.log over 600KB down to the newest lines (V1 semantics)", () => {
    tmp = mkdtempSync(join(tmpdir(), "mp-logs-"))
    const paths: Paths = buildPaths(join(tmp, "base"))
    const loggers = makeLoggers(paths, false)

    // Seed >600KB: 2500 lines × ~270 bytes ≈ 675KB.
    const seed: string[] = []
    for (let i = 0; i < 2500; i++) seed.push(`seed-${i}-${"x".repeat(260)}`)
    mkdirSync(paths.hookStateDir, { recursive: true })
    writeFileSync(paths.interactionsLog, seed.map((s) => s + "\n").join(""), "utf8")

    loggers.ilog("rot", { marker: true })

    const content = readFileSync(paths.interactionsLog, "utf8").split("\n").filter((l) => l !== "")
    expect(content.length).toBeLessThanOrEqual(INTERACTIONS_MAX_LINES)
    // Oldest seed lines are dropped, newest entries survive, the fresh
    // ilog line is the last one.
    expect(content.some((l) => l.startsWith("seed-0-"))).toBe(false)
    expect(content.some((l) => l.startsWith("seed-2499-"))).toBe(true)
    const last = JSON.parse(content[content.length - 1]) as Record<string, unknown>
    expect(last.kind).toBe("rot")
    expect(last.marker).toBe(true)
  })

  it("exports INTERACTIONS_MAX_LINES as 2000 (V1 value)", () => {
    expect(INTERACTIONS_MAX_LINES).toBe(2000)
  })
})
