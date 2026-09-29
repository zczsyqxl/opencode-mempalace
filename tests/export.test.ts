import { describe, expect, it } from "vitest"
import {
  buildTranscript,
  cursorClamp,
  exportFileName,
  filterExportable,
  wingFor,
  type ExportMessage,
} from "../src/export"

/** Fixed UTC timestamps: 2026-09-28 23:59:00 and 2026-09-29 00:01:02. */
const T1 = Date.UTC(2026, 8, 28, 23, 59, 0)
const T2 = Date.UTC(2026, 8, 29, 0, 1, 2)

function msg(partial: Partial<ExportMessage> & Pick<ExportMessage, "id">): ExportMessage {
  return { role: "user", text: "text", ts: 1000, complete: true, ...partial }
}

describe("wingFor", () => {
  it("normalizes backslashes BEFORE the last segment (Review Focus #1)", () => {
    // "D:\a\my proj!" -> "D:/a/my proj!" -> "my proj!" -> sanitize -> "my_proj_"
    expect(wingFor("D:\\a\\my proj!")).toBe("my_proj_")
  })

  it("windows and posix spellings of the same directory map to one wing", () => {
    expect(wingFor("D:\\a\\my proj!")).toBe(wingFor("D:/a/my proj!"))
  })

  it("trailing slashes fall back to the last NON-EMPTY segment", () => {
    expect(wingFor("/a/b/")).toBe("b")
    expect(wingFor("/a/b")).toBe("b")
  })

  it("null/undefined/empty/separator-only directories become global", () => {
    expect(wingFor(null)).toBe("global")
    expect(wingFor(undefined)).toBe("global")
    expect(wingFor("")).toBe("global")
    expect(wingFor("/")).toBe("global")
    expect(wingFor("\\")).toBe("global")
    expect(wingFor("///")).toBe("global")
  })

  it("sanitizes every character outside [a-zA-Z0-9_-] to _", () => {
    expect(wingFor("/a/h llo!")).toBe("h_llo_")
    expect(wingFor("/a/héllo")).toBe("h_llo")
  })

  it("truncates the sanitized wing to 40 characters", () => {
    expect(wingFor("/" + "y".repeat(45) + "!")).toBe("y".repeat(40))
  })
})

describe("buildTranscript", () => {
  it("renders the V1-verbatim header + per-message blocks, line by line", () => {
    const out = buildTranscript("Test Title", "ses_xyz", [
      msg({ id: "m1", role: "user", text: "hello", ts: T1 }),
      msg({ id: "m2", role: "assistant", text: "hi\nthere", ts: T2, complete: false }),
    ])

    expect(out.split("\n")).toEqual([
      "# Test Title",
      "Date: 2026-09-29",
      "Session: ses_xyz",
      "",
      "## USER \u2014 23:59:00",
      "",
      "hello",
      "",
      "## ASSISTANT \u2014 00:01:02",
      "",
      "hi",
      "there",
    ])
  })

  it("Date line follows the LAST message (UTC), not the first", () => {
    const out = buildTranscript("t", "s", [
      msg({ id: "a", text: "one", ts: Date.UTC(2026, 8, 28, 12, 0, 0) }),
      msg({ id: "b", text: "two", ts: Date.UTC(2026, 8, 29, 12, 0, 0) }),
    ])
    expect(out.split("\n")[1]).toBe("Date: 2026-09-29")
  })

  it("uppercases the role and uses UTC HH:MM:SS from ts", () => {
    const out = buildTranscript("t", "s", [msg({ id: "a", role: "assistant", text: "x", ts: T2 })])
    expect(out).toContain("## ASSISTANT \u2014 00:01:02")
  })

  it("is trimmed: no leading/trailing blank line, no trailing newline", () => {
    const out = buildTranscript("t", "s", [msg({ id: "a", text: "x", ts: T1 })])
    expect(out.startsWith("# t\n")).toBe(true)
    expect(out.endsWith("x")).toBe(true)
    expect(out.endsWith("\n")).toBe(false)
  })

  it("never throws on an empty message list (pipeline skips those, not this fn)", () => {
    const out = buildTranscript("t", "s", [])
    expect(out.split("\n").slice(0, 3)).toEqual(["# t", "Date: ", "Session: s"])
  })
})

describe("exportFileName", () => {
  const NOW = new Date("2026-09-29T12:34:56Z")

  it("matches the V1 filename shape", () => {
    const name = exportFileName(NOW, "Fix login bug!", "ses_1234567890abcdef", "hello")
    expect(name).toMatch(/^sync_\d{4}-\d{2}-\d{2}_.{1,30}_.{8}_[0-9a-f]{12}\.txt$/)
  })

  it("composes date, sanitized label, session prefix and content hash exactly", () => {
    // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e...; "!" is the only
    // char outside [a-zA-Z0-9 _-], so the label keeps its spaces.
    const name = exportFileName(NOW, "Fix login bug!", "ses_1234567890abcdef", "hello")
    expect(name).toBe("sync_2026-09-29_Fix login bug__ses_1234_2cf24dba5fb0.txt")
  })

  it("sanitizes label chars outside [a-zA-Z0-9 _-] (spaces survive, unlike wings)", () => {
    // "?"/"#" -> "_": label "a_b_c", then the separator + id8 prefix.
    const name = exportFileName(NOW, "a?b#c", "sess12345678", "x")
    expect(name.startsWith("sync_2026-09-29_a_b_c_sess1234_")).toBe(true)
  })

  it("truncates the label to 30 characters", () => {
    const name = exportFileName(NOW, "L".repeat(50), "sess12345678", "x")
    // sync_<day>_<label30>_<id8>_<hash12>.txt
    expect(name.split("_")[2]).toBe("L".repeat(30))
  })

  it("falls back to the first 8 chars of the session id for an empty title", () => {
    const name = exportFileName(NOW, "", "abcdefgh1234", "x")
    expect(name).toBe(exportFileName(NOW, "abcdefgh", "abcdefgh1234", "x"))
  })

  it("is deterministic for identical content and differs when content differs", () => {
    const a = exportFileName(NOW, "t", "sess12345678", "same")
    const b = exportFileName(NOW, "t", "sess12345678", "same")
    const c = exportFileName(NOW, "t", "sess12345678", "other")
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

describe("filterExportable", () => {
  it("drops seen ids, empty/whitespace text; routes complete:false to incompleteTs", () => {
    const m1 = msg({ id: "a", text: "hello", ts: 1000 })
    const m2 = msg({ id: "b", text: "", ts: 2000 }) // empty text -> nowhere
    const m3 = msg({ id: "c", text: "   ", ts: 3000 }) // whitespace -> nowhere
    const m4 = msg({ id: "d", role: "assistant", text: "partial", ts: 4000, complete: false })
    const m5 = msg({ id: "e", text: "dupe", ts: 5000 }) // seen -> nowhere
    const seen = new Set(["e"])

    const { exportable, incompleteTs } = filterExportable([m1, m2, m3, m4, m5], seen)
    expect(exportable).toEqual([m1])
    expect(incompleteTs).toEqual([4000])
  })

  it("a seen incomplete message clamps nothing (seen wins, V2 filter order)", () => {
    const m = msg({ id: "x", text: "partial", ts: 7000, complete: false })
    const { exportable, incompleteTs } = filterExportable([m], new Set(["x"]))
    expect(exportable).toEqual([])
    expect(incompleteTs).toEqual([])
  })

  it("keeps a single exportable message — the <2 skip is the pipeline's call (Focus #3)", () => {
    const m = msg({ id: "solo", text: "only", ts: 1000 })
    const { exportable, incompleteTs } = filterExportable([m], new Set())
    expect(exportable).toEqual([m])
    expect(incompleteTs).toEqual([])
  })

  it("empty in, empty out", () => {
    expect(filterExportable([], new Set())).toEqual({ exportable: [], incompleteTs: [] })
  })
})

describe("cursorClamp", () => {
  it("returns the fallback when nothing is incomplete", () => {
    expect(cursorClamp([], 12345)).toBe(12345)
  })

  it("clamps to min(incompleteTs) - 1 so the reply is revisited next sync", () => {
    expect(cursorClamp([5000, 4000, 6000], 9999)).toBe(3999)
  })
})
