import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildPaths, type Paths } from "../src/paths"
import type { SessionCounter } from "../src/state"
import {
  BUSY_TOAST_WINDOW_MS,
  makeToastEmitter,
  startupToastMessage,
} from "../src/toast"
import {
  createCheckpointStateMachine,
  createIdentityLatch,
  createRecallPlanner,
  extractResultText,
  formatToolArgs,
  shortToolName,
  singleLine,
  toolToastMessage,
  truncate,
  type CounterStore,
} from "../src/hooks"

/** Fresh temp dir per test; never touch the real ~/.mempalace. */
let tmp = ""
afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true })
    tmp = ""
  }
})

function freshPaths(): Paths {
  tmp = mkdtempSync(join(tmpdir(), "mp-hooks-"))
  return buildPaths(join(tmp, "base"))
}

/** In-memory counter store capturing every write (wired to state.ts in index.ts). */
function recordingStore(seed: Record<string, SessionCounter> = {}): CounterStore & {
  snapshot(): Record<string, SessionCounter>
  writes: Array<Record<string, SessionCounter>>
} {
  let current = seed
  const writes: Array<Record<string, SessionCounter>> = []
  return {
    read: () => current,
    write: (counters) => {
      current = counters
      writes.push(counters)
    },
    snapshot: () => current,
    writes,
  }
}

describe("createCheckpointStateMachine", () => {
  it("arms exactly at each interval boundary: 15 prompts silent, 16th arms, 17–30 silent, 31st arms", () => {
    const machine = createCheckpointStateMachine(15)
    const armedAt: number[] = []
    for (let i = 1; i <= 31; i++) {
      const r = machine.onPrompt("s1")
      expect(r.count).toBe(i)
      if (r.armed) armedAt.push(i)
    }
    expect(armedAt).toEqual([16, 31])
  })

  it("takePending returns the armed checkpoint once, then null (cleared)", () => {
    const machine = createCheckpointStateMachine(15)
    for (let i = 1; i <= 16; i++) machine.onPrompt("s1")
    expect(machine.takePending()).toEqual({ sessionID: "s1", count: 16 })
    expect(machine.takePending()).toBeNull()
  })

  it("advances lastCheckpoint at arming time (V1 semantics) via the injected store", () => {
    const store = recordingStore()
    const machine = createCheckpointStateMachine(15, store)
    for (let i = 1; i <= 15; i++) machine.onPrompt("s1")
    expect(store.snapshot()["s1"]).toEqual({ humanMsgs: 15, lastCheckpoint: 0 })

    const r = machine.onPrompt("s1") // arms; boundary floor(15/15)=1 must be recorded NOW
    expect(r.armed).toBe(true)
    expect(store.snapshot()["s1"]).toEqual({ humanMsgs: 16, lastCheckpoint: 1 })

    machine.onPrompt("s1") // 17: would re-arm if lastCheckpoint had not advanced
    expect(store.snapshot()["s1"]).toEqual({ humanMsgs: 17, lastCheckpoint: 1 })
  })

  it("continues from persisted counters: seeded {15, 0} arms on the first prompt", () => {
    const store = recordingStore({ old: { humanMsgs: 15, lastCheckpoint: 0 } })
    const machine = createCheckpointStateMachine(15, store)
    expect(machine.onPrompt("old")).toEqual({ armed: true, count: 16 })
  })

  it("counts sessions independently", () => {
    const machine = createCheckpointStateMachine(15)
    for (let i = 1; i <= 16; i++) machine.onPrompt("a")
    for (let i = 1; i <= 15; i++) expect(machine.onPrompt("b").armed).toBe(false)
    expect(machine.onPrompt("b").armed).toBe(true)
    expect(machine.takePending("b")).toEqual({ sessionID: "b", count: 16 })
  })

  it("takePending(sessionID) does not steal another session's pending checkpoint", () => {
    const machine = createCheckpointStateMachine(15)
    for (let i = 1; i <= 16; i++) machine.onPrompt("a")
    expect(machine.takePending("b")).toBeNull() // mismatch: leave the pending intact
    expect(machine.takePending("a")).toEqual({ sessionID: "a", count: 16 })
  })

  it("a non-positive interval never arms but still counts", () => {
    const store = recordingStore()
    const machine = createCheckpointStateMachine(0, store)
    for (let i = 1; i <= 100; i++) expect(machine.onPrompt("s").armed).toBe(false)
    expect(store.snapshot()["s"]?.humanMsgs).toBe(100)
    expect(machine.takePending()).toBeNull()
  })
})

describe("createIdentityLatch", () => {
  it("shouldInject() returns true exactly once, then false forever", () => {
    const latch = createIdentityLatch()
    expect(latch.shouldInject()).toBe(true)
    expect(latch.shouldInject()).toBe(false)
    expect(latch.shouldInject()).toBe(false)
  })

  it("instances are independent (each fires once)", () => {
    const a = createIdentityLatch()
    const b = createIdentityLatch()
    expect(a.shouldInject()).toBe(true)
    expect(b.shouldInject()).toBe(true)
    expect(a.shouldInject()).toBe(false)
    expect(b.shouldInject()).toBe(false)
  })
})

describe("createRecallPlanner", () => {
  it("take() returns the planned query once and clears it", () => {
    const planner = createRecallPlanner()
    planner.plan("wing naming scheme")
    expect(planner.take()).toBe("wing naming scheme")
    expect(planner.take()).toBeNull()
  })

  it("dedups: same query as last planned does not re-plan", () => {
    const planner = createRecallPlanner()
    planner.plan("q1")
    expect(planner.take()).toBe("q1")
    planner.plan("q1") // identical to last planned → ignored
    expect(planner.take()).toBeNull()
    planner.plan("q2") // different → planned again
    expect(planner.take()).toBe("q2")
  })

  it("overwrites a still-pending query with a newer different one", () => {
    const planner = createRecallPlanner()
    planner.plan("q1")
    planner.plan("q2") // q1 never consumed; newest query wins
    expect(planner.take()).toBe("q2")
  })
})

describe("shortToolName", () => {
  it("strips mcp_/mempalace_mempalace_/mempalace_ prefixes", () => {
    expect(shortToolName("mcp_mempalace_mempalace_search")).toBe("search")
    expect(shortToolName("mempalace_mempalace_search")).toBe("search")
    expect(shortToolName("mempalace_search")).toBe("search")
    expect(shortToolName("mcp_mempalace_search")).toBe("search")
  })

  it("leaves unnamespaced tool names untouched", () => {
    expect(shortToolName("read")).toBe("read")
    expect(shortToolName("edit")).toBe("edit")
  })
})

describe("extractResultText", () => {
  it("uses content string verbatim", () => {
    expect(extractResultText({ content: "plain output" })).toBe("plain output")
  })

  it("joins text parts of a content block array, skipping non-text parts", () => {
    expect(
      extractResultText({
        content: [
          { type: "text", text: "first" },
          { type: "file", uri: "file:///x", mime: "text/plain" },
          { type: "text", text: "second" },
        ],
      }),
    ).toBe("first\nsecond")
  })

  it("falls back to the output string when content has no text parts", () => {
    expect(extractResultText({ content: [{ type: "file", uri: "file:///x", mime: "text/plain" }], output: "fallback" })).toBe("fallback")
    expect(extractResultText({ output: "only output" })).toBe("only output")
  })

  it("returns empty string for missing/non-string output and missing results", () => {
    expect(extractResultText({ output: { deep: true } })).toBe("")
    expect(extractResultText({})).toBe("")
    expect(extractResultText(undefined)).toBe("")
  })
})

describe("formatToolArgs / singleLine / truncate", () => {
  it("formatToolArgs: strings verbatim, objects JSON, undefined/null empty", () => {
    expect(formatToolArgs("literal query")).toBe("literal query")
    expect(formatToolArgs({ wing: "my-proj", query: "x" })).toBe('{"wing":"my-proj","query":"x"}')
    expect(formatToolArgs(undefined)).toBe("")
    expect(formatToolArgs(null)).toBe("")
  })

  it("singleLine collapses whitespace runs (newlines, tabs) to single spaces", () => {
    expect(singleLine("  a\n\nb \t c  ")).toBe("a b c")
  })

  it("truncate caps at maxChars, keeps shorter strings untouched", () => {
    expect(truncate("abc", 5)).toBe("abc")
    expect(truncate("abcdef", 5)).toBe("abcde")
  })
})

describe("toolToastMessage", () => {
  it("formats {shortTool} · asked: {≤60 single-line} → {≤120 single-line}", () => {
    expect(toolToastMessage("mcp_mempalace_mempalace_search", "x".repeat(100), "y".repeat(200))).toBe(
      `search · asked: ${"x".repeat(60)} → ${"y".repeat(120)}`,
    )
  })

  it("single-lines multi-line asked/answered before truncating", () => {
    expect(toolToastMessage("mempalace_search", "line1\nline2", "done")).toBe("search · asked: line1 line2 → done")
  })

  it("keeps empty asked/answered slots in the format", () => {
    expect(toolToastMessage("mempalace_search", "", "")).toBe("search · asked:  → ")
  })
})

describe("makeToastEmitter", () => {
  it("toasts:false → emit is never called", () => {
    const paths = freshPaths()
    mkdirSync(paths.baseDir, { recursive: true })
    writeFileSync(paths.pluginConfig, JSON.stringify({ toasts: false }), "utf8")
    const emit = vi.fn()
    const toast = makeToastEmitter(paths, emit)
    toast("info", "MemPalace", "hello")
    toast("error", "MemPalace", "boom")
    expect(emit).not.toHaveBeenCalled()
  })

  it("emits the payload verbatim when toasts is enabled (default config)", () => {
    const paths = freshPaths() // no config file → defaults → toasts on
    const emit = vi.fn()
    const toast = makeToastEmitter(paths, emit)
    toast("info", "MemPalace", "hello")
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith({ variant: "info", title: "MemPalace", message: "hello" })
  })

  it("reads the toasts flag ONCE at construction (later config flips do not apply)", () => {
    const paths = freshPaths()
    const emit = vi.fn()
    const toast = makeToastEmitter(paths, emit)
    mkdirSync(paths.baseDir, { recursive: true })
    writeFileSync(paths.pluginConfig, JSON.stringify({ toasts: false }), "utf8")
    toast("info", "MemPalace", "still on")
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it("busy throttle: at most one info 'palace busy…' toast per 5-minute window", () => {
    const paths = freshPaths()
    const emit = vi.fn()
    let clock = 1_000_000
    const toast = makeToastEmitter(paths, emit, () => clock)

    toast("info", "MemPalace", "palace busy mining — will retry")
    expect(emit).toHaveBeenCalledTimes(1)

    toast("info", "MemPalace", "palace busy still") // within window → suppressed
    toast("info", "MemPalace", "palace busy again") // within window → suppressed
    expect(emit).toHaveBeenCalledTimes(1)

    toast("info", "MemPalace", "unrelated message") // not a busy notice → passes
    expect(emit).toHaveBeenCalledTimes(2)

    toast("error", "MemPalace", "palace busy but error variant") // only info is throttled
    expect(emit).toHaveBeenCalledTimes(3)

    clock += BUSY_TOAST_WINDOW_MS // window elapsed → next busy notice passes
    toast("info", "MemPalace", "palace busy after window")
    expect(emit).toHaveBeenCalledTimes(4)
  })
})

describe("startupToastMessage", () => {
  it("no pending files → \", queue empty\" suffix", () => {
    expect(startupToastMessage("opencode-mempalace", "0.0.0", 0)).toBe(
      "opencode-mempalace v0.0.0 loaded, queue empty",
    )
  })

  it("pending files → \", N file(s) waiting to mine\" suffix", () => {
    expect(startupToastMessage("opencode-mempalace", "1.2.3", 7)).toBe(
      "opencode-mempalace v1.2.3 loaded, 7 file(s) waiting to mine",
    )
  })

  it("negative counts are treated as empty (countPendingFiles floors at 0)", () => {
    expect(startupToastMessage("x", "9", -1)).toBe("x v9 loaded, queue empty")
  })
})
