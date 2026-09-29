/**
 * Pure state machines + text helpers behind the server hooks (Ruling 4):
 * NO OpenCode imports and NO direct IO — persistence goes through the
 * injected CounterStore, which index.ts wires to state.ts's counter files.
 * Everything here is unit-tested in tests/hooks.test.ts; src/index.ts only
 * orchestrates real plugin APIs around these pieces.
 *
 *   - createCheckpointStateMachine: V1 AI-checkpoint cadence. Arming is
 *     bumpCounter's post-bump rule (state.ts, single source of truth); the
 *     consumer advances `lastCheckpoint` AT ARMING TIME (boundary derived
 *     from the incremented humanMsgs) so later messages in the same boundary
 *     cannot re-arm (V1 semantics, state.ts JSDoc).
 *   - createIdentityLatch: identity injected once per plugin lifetime (V1
 *     wakeupDone flag) — see the function doc below.
 *   - createRecallPlanner: one planned recall query at a time; a query
 *     identical to the last planned one is ignored, so the agent loop's
 *     repeated steps (and repeated identical prompts) never re-search.
 *   - tool visibility helpers: shortToolName/extractResultText/formatToolArgs/
 *     toolToastMessage build the "{shortTool} · asked: … → …" toast copy.
 */
import { bumpCounter, type SessionCounter } from "./state"

/**
 * Persistence seam for the checkpoint machine. The default is an in-memory
 * map (tests, plain use); index.ts injects a file-backed store built from
 * readCounters/writeCounters so counts survive host restarts.
 */
export interface CounterStore {
  read(): Record<string, SessionCounter>
  write(counters: Record<string, SessionCounter>): void
}

/** A checkpoint instruction waiting to be delivered by the context hook. */
export interface CheckpointPending {
  sessionID: string
  count: number
}

function memoryStore(): CounterStore {
  let counters: Record<string, SessionCounter> = {}
  return {
    read: () => counters,
    write: (next) => {
      counters = next
    },
  }
}

/**
 * Count human messages per session; on each interval boundary (V1 rule:
 * floor(postBumpMsgs / interval) > lastCheckpoint) arm exactly one pending
 * checkpoint and advance lastCheckpoint immediately (to the boundary of the
 * incremented humanMsgs). `takePending()` hands the pending checkpoint to
 * the context hook once and clears it; passing a sessionID only takes a
 * pending armed for THAT session (mismatched calls leave the pending
 * intact).
 */
export function createCheckpointStateMachine(
  interval: number,
  store: CounterStore = memoryStore(),
): {
  onPrompt(sessionID: string): { armed: boolean; count: number }
  takePending(sessionID?: string): CheckpointPending | null
} {
  let pending: CheckpointPending | null = null

  return {
    onPrompt(sessionID) {
      const counters = store.read()
      const { counter, armed } = bumpCounter(counters[sessionID], interval)
      if (armed) {
        counter.lastCheckpoint = Math.floor(counter.humanMsgs / interval)
        pending = { sessionID, count: counter.humanMsgs }
      }
      store.write({ ...counters, [sessionID]: counter })
      return { armed, count: counter.humanMsgs }
    },
    takePending(sessionID) {
      if (pending === null) return null
      if (sessionID !== undefined && pending.sessionID !== sessionID) return null
      const p = pending
      pending = null
      return p
    },
  }
}

/**
 * Identity injection latch (V1 `wakeupDone` semantics): the identity block
 * is injected ONCE per plugin lifetime, on the first context hook event —
 * the agent-loop transcript always contains at least the current user
 * message, so a messages-length gate can never fire. shouldInject() returns
 * true exactly once, false forever after.
 */
export function createIdentityLatch(): {
  shouldInject(): boolean
} {
  let fired = false
  return {
    shouldInject() {
      if (fired) return false
      fired = true
      return true
    },
  }
}

/**
 * Recall planner: plan() records the newest query (ignoring one identical to
 * the last PLANNED query — dedup survives take()), take() returns and clears
 * the pending query. index.ts plans on prompt (autoInject only) and takes on
 * the context hook, so recall fires once per new user message.
 */
export function createRecallPlanner(): {
  plan(query: string): void
  take(): string | null
} {
  let pending: string | null = null
  let lastPlanned: string | null = null

  return {
    plan(query) {
      if (query === lastPlanned) return
      lastPlanned = query
      pending = query
    },
    take() {
      const query = pending
      pending = null
      return query
    },
  }
}

/** Strip MCP namespacing prefixes for display (V1 shortTool). */
export function shortToolName(tool: string): string {
  let name = tool
  for (const prefix of ["mcp_", "mempalace_mempalace_", "mempalace_"]) {
    if (name.startsWith(prefix)) name = name.slice(prefix.length)
  }
  return name
}

/** Structural shape of a V2 Tool.Result (content blocks + output fallback). */
export interface ToolResultLike {
  output?: unknown
  content?: string | ReadonlyArray<{ type: string; text?: string }>
}

/**
 * V1 extractResultText: the content string, else the text parts of a content
 * block array (joined with newlines), else the output string; "" otherwise.
 */
export function extractResultText(result: ToolResultLike | undefined): string {
  if (!result) return ""
  const content = result.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const texts: string[] = []
    for (const part of content) {
      if (part && part.type === "text" && typeof part.text === "string") texts.push(part.text)
    }
    if (texts.length > 0) return texts.join("\n")
  }
  return typeof result.output === "string" ? result.output : ""
}

/** Collapse every whitespace run (newlines, tabs, …) to a single space. */
export function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/** Cap at maxChars (UTF-16 slice, V1-style: no ellipsis). */
export function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars)
}

/** Render a tool input for display: strings verbatim, anything else JSON. */
export function formatToolArgs(input: unknown): string {
  if (typeof input === "string") return input
  if (input === undefined || input === null) return ""
  try {
    return JSON.stringify(input) ?? ""
  } catch {
    return String(input)
  }
}

/** Toast copy caps (V1 values): asked 60 chars, answered 120 chars. */
export const TOOL_TOAST_ASKED_CHARS = 60
export const TOOL_TOAST_ANSWERED_CHARS = 120
/** interactions.log caps for tool visibility (V1 values). */
export const TOOL_LOG_ASKED_CHARS = 200
export const TOOL_LOG_ANSWERED_CHARS = 300

/** "{shortTool} · asked: {≤60 single-line} → {≤120 single-line}" (V1 copy). */
export function toolToastMessage(tool: string, asked: string, answered: string): string {
  return `${shortToolName(tool)} · asked: ${truncate(singleLine(asked), TOOL_TOAST_ASKED_CHARS)} → ${truncate(singleLine(answered), TOOL_TOAST_ANSWERED_CHARS)}`
}
