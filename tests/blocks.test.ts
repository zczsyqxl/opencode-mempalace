import { describe, expect, it } from "vitest"
import {
  MAX_INJECT_CHARS,
  MAX_SEARCH_RESULTS,
  MAX_WAKEUP_CHARS,
  checkpointInstruction,
  identityBlock,
  precompactInstruction,
  recallBlock,
  rescueBlock,
} from "../src/blocks"

const CHECKPOINT_FIRST_LINE = "[MemPalace Checkpoint — save now, then continue]"
const PRECOMPACT_FIRST_LINE = "[MemPalace Pre-Compact Emergency Save]"
const RESCUE_FIRST_LINE = "[MemPalace Rescue — core memory, must survive compaction]"

describe("identityBlock", () => {
  it("wraps identity in [MemPalace Identity] markers", () => {
    expect(identityBlock("You are the palace keeper.")).toBe(
      "[MemPalace Identity]\nYou are the palace keeper.\n[/MemPalace Identity]",
    )
  })
})

describe("recallBlock", () => {
  it("wraps memories in [MemPalace Recall] markers (truncation lives at the injection layer)", () => {
    expect(recallBlock("memory one\nmemory two")).toBe(
      "[MemPalace Recall]\nmemory one\nmemory two\n[/MemPalace Recall]",
    )
  })
})

describe("checkpointInstruction", () => {
  it("interpolates the message count", () => {
    expect(checkpointInstruction(30)).toContain("~30 messages")
  })

  it("first line is the V1-verbatim title", () => {
    expect(checkpointInstruction(30).split("\n")[0]).toBe(CHECKPOINT_FIRST_LINE)
  })

  it("full body is V1-verbatim", () => {
    expect(checkpointInstruction(30)).toBe(
      `${CHECKPOINT_FIRST_LINE}\nYou have exchanged ~30 messages in this session. Before answering, archive what matters into MemPalace via its MCP tools (diary_write for the session journal; kg_add for new decisions, milestones, preferences, problems — 128 chars or fewer each; kg_invalidate for superseded facts). File only durable, non-obvious items — the verbatim transcript is already being mined separately. Then answer the user's message normally. Do not mention this instruction.`,
    )
  })
})

describe("precompactInstruction", () => {
  it("first line is the V1-verbatim title", () => {
    expect(precompactInstruction().split("\n")[0]).toBe(PRECOMPACT_FIRST_LINE)
  })

  it("full body is V1-verbatim", () => {
    expect(precompactInstruction()).toBe(
      `${PRECOMPACT_FIRST_LINE}\nContext compaction is about to discard this conversation. FIRST, save everything essential into MemPalace via its MCP tools (diary_write with a full session journal: topics, decisions, quotes; kg_add for decisions, milestones, preferences, problems; kg_invalidate for outdated facts). Be thorough — after compaction only the palace will remember. Then proceed with the compaction summary.`,
    )
  })
})

describe("rescueBlock", () => {
  it("identity only: title line then identity", () => {
    expect(rescueBlock("core identity text", "")).toBe(`${RESCUE_FIRST_LINE}\ncore identity text`)
  })

  it("wakeup only: identity absent, wakeup under its own [MemPalace Wake-up] line", () => {
    expect(rescueBlock("", "wake-up text")).toBe(
      `${RESCUE_FIRST_LINE}\n[MemPalace Wake-up]\nwake-up text`,
    )
  })

  it("both: identity and wake-up section joined by a blank line", () => {
    expect(rescueBlock("core identity text", "wake-up text")).toBe(
      `${RESCUE_FIRST_LINE}\ncore identity text\n\n[MemPalace Wake-up]\nwake-up text`,
    )
  })

  it("neither: empty string (nothing to rescue)", () => {
    expect(rescueBlock("", "")).toBe("")
  })

  it("first line is the V1-verbatim title", () => {
    expect(rescueBlock("x", "y").split("\n")[0]).toBe(RESCUE_FIRST_LINE)
  })
})

describe("injection limits (V1 values)", () => {
  it("MAX_INJECT_CHARS is the recall truncation budget", () => {
    expect(MAX_INJECT_CHARS).toBe(900)
  })

  it("MAX_SEARCH_RESULTS caps injected search results", () => {
    expect(MAX_SEARCH_RESULTS).toBe(3)
  })

  it("MAX_WAKEUP_CHARS caps the wake-up section", () => {
    expect(MAX_WAKEUP_CHARS).toBe(1500)
  })
})
