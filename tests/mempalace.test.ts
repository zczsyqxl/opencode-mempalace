import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  CHILD_MAX_BUFFER,
  classifyMineError,
  findMempalaceBin,
  mineArgs,
  parseDrawers,
  resolveMempalaceBin,
  runMempalace,
  runMempalaceSync,
  searchArgs,
  wakeUpArgs,
} from "../src/mempalace"

/** A path that is guaranteed not to exist, for the deterministic failure path. */
const MISSING_BIN = join(tmpdir(), `mempalace-definitely-missing-${process.pid}`)

describe("resolveMempalaceBin (pure — no real process)", () => {
  /** exists() backed by an explicit set: tests need no filesystem. */
  const makeExists = (...present: string[]) => (p: string) => present.includes(p)
  const boomLookup = (): string => {
    throw new Error("lookup must not be called")
  }

  it("returns MEMPALACE_BIN verbatim when it exists (highest priority, no PATH lookup)", () => {
    const env = { MEMPALACE_BIN: "C:\\tools\\mempalace.exe" }
    const bin = resolveMempalaceBin(env, makeExists("C:\\tools\\mempalace.exe"), "win32", boomLookup)
    expect(bin).toBe("C:\\tools\\mempalace.exe")
  })

  it("skips an empty MEMPALACE_BIN and moves on to the PATH lookup", () => {
    const env = { MEMPALACE_BIN: "" }
    const bin = resolveMempalaceBin(env, makeExists(), "win32", () => "C:\\onpath\\mempalace.exe")
    expect(bin).toBe("C:\\onpath\\mempalace.exe")
  })

  it("falls through when MEMPALACE_BIN is set but the file does not exist", () => {
    const env = { MEMPALACE_BIN: "C:\\gone\\mempalace.exe" }
    const bin = resolveMempalaceBin(env, makeExists(), "win32", () => "C:\\onpath\\mempalace.exe")
    expect(bin).toBe("C:\\onpath\\mempalace.exe")
  })

  it("uses the FIRST line of `where` output when several candidates are listed", () => {
    // `where mempalace` prints one hit per line; lookup returns trimmed output.
    const out = "C:\\a\\mempalace.exe\r\nC:\\b\\mempalace.exe"
    const bin = resolveMempalaceBin({}, makeExists(), "win32", () => out)
    expect(bin).toBe("C:\\a\\mempalace.exe")
  })

  it("falls back to ~/.local/bin/mempalace when the lookup throws (POSIX home from HOME)", () => {
    const expected = join("/home/u", ".local", "bin", "mempalace")
    const bin = resolveMempalaceBin({ HOME: "/home/u" }, makeExists(expected), "linux", () => {
      throw new Error("not on PATH")
    })
    expect(bin).toBe(expected)
  })

  it("derives the fallback home from USERPROFILE on win32", () => {
    const expected = join("C:\\Users\\u", ".local", "bin", "mempalace")
    const bin = resolveMempalaceBin(
      { USERPROFILE: "C:\\Users\\u" },
      makeExists(expected),
      "win32",
      () => {
        throw new Error("not on PATH")
      },
    )
    expect(bin).toBe(expected)
  })

  it("treats empty lookup output as a miss and continues to the fallback", () => {
    const expected = join("/home/u", ".local", "bin", "mempalace")
    const bin = resolveMempalaceBin({ HOME: "/home/u" }, makeExists(expected), "linux", () => "")
    expect(bin).toBe(expected)
  })

  it("returns null — never throws — when every strategy fails (Review Focus #5)", () => {
    const bin = resolveMempalaceBin({ HOME: "/home/u" }, makeExists(), "linux", () => {
      throw new Error("not on PATH")
    })
    expect(bin).toBeNull()
  })
})

describe("args builders (exact argv arrays — never shell strings)", () => {
  it("searchArgs defaults to 3 results", () => {
    expect(searchArgs("wing naming")).toEqual(["search", "wing naming", "--results", "3"])
  })

  it("searchArgs honours an explicit results count", () => {
    expect(searchArgs("q", 5)).toEqual(["search", "q", "--results", "5"])
  })

  it("wakeUpArgs is exactly [\"wake-up\"]", () => {
    expect(wakeUpArgs()).toEqual(["wake-up"])
  })

  it("mineArgs pins mode=convos, agent=opencode, and the wing", () => {
    expect(mineArgs("/base/oc-sessions/wing-foo", "记忆宫殿")).toEqual([
      "mine",
      "/base/oc-sessions/wing-foo",
      "--mode",
      "convos",
      "--agent",
      "opencode",
      "--wing",
      "记忆宫殿",
    ])
  })
})

describe("classifyMineError (lock contention vs everything else)", () => {
  it("classifies lock contention as busy", () => {
    expect(classifyMineError("lock file /x/y.lock is held by another process")).toBe("busy")
  })

  it("matches case-insensitively", () => {
    expect(classifyMineError("Lock IS HELD BY pid 42")).toBe("busy")
  })

  it("classifies every other failure as error", () => {
    expect(classifyMineError("connection refused")).toBe("error")
    expect(classifyMineError("")).toBe("error")
  })
})

describe("parseDrawers", () => {
  it("extracts the count from V1-style mine output", () => {
    expect(parseDrawers("Mined 3 conversations.\nDrawers filed: 7\n")).toBe(7)
  })

  it("is case-insensitive and tolerates extra whitespace", () => {
    expect(parseDrawers("drawers filed:   12")).toBe(12)
  })

  it("keeps scanning past trailing words", () => {
    expect(parseDrawers("Drawers filed: 4 drawers into wing")).toBe(4)
  })

  it("returns 0 when there is no match or the digits are absent", () => {
    expect(parseDrawers("nothing here")).toBe(0)
    expect(parseDrawers("Drawers filed: many")).toBe(0)
    expect(parseDrawers("")).toBe(0)
  })
})

describe("runMempalace / runMempalaceSync (deterministic, no real binary needed)", () => {
  it("runMempalace reports ok:false with an error string for a missing binary", async () => {
    const r = await runMempalace(MISSING_BIN, ["--version"], 10_000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0)
  })

  it("runMempalaceSync reports ok:false with an error string for a missing binary", () => {
    const r = runMempalaceSync(MISSING_BIN, ["--version"], 10_000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0)
  })
})

// Light smoke test: runs a real `mempalace --version` ONLY when the binary
// resolves on this machine; CI without mempalace skips silently.
const BIN = findMempalaceBin()
const maybeIt = BIN ? it : it.skip

describe("runMempalace smoke (skipped when mempalace is not installed)", () => {
  maybeIt("runs `mempalace --version` asynchronously via execFile (no shell)", async () => {
    const r = await runMempalace(BIN as string, ["--version"], 15_000)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.stdout).toContain("MemPalace")
  })

  maybeIt("runs `mempalace --version` synchronously via spawnSync", () => {
    const r = runMempalaceSync(BIN as string, ["--version"], 15_000)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.stdout).toContain("MemPalace")
  })

  maybeIt("resolved bin actually exists on disk", () => {
    expect(existsSync(BIN as string)).toBe(true)
  })
})

describe("constants", () => {
  it("CHILD_MAX_BUFFER is 64 MiB (V1: large mine outputs, ENOBUFS protection)", () => {
    expect(CHILD_MAX_BUFFER).toBe(64 * 1024 * 1024)
  })
})
