/**
 * Injection block builders — the user-facing instruction copy is transcribed
 * VERBATIM from V1 src/index.ts (em-dashes U+2014 included). Do not reword.
 *
 * This module is pure string construction, no IO:
 *   - truncation to MAX_INJECT_CHARS / MAX_WAKEUP_CHARS happens at the
 *     injection call sites (hooks, Task 9), not here — the constants live
 *     here only so consumers import the single V1 source of truth.
 *   - rescueBlock returns "" when there is nothing to rescue so the caller
 *     can skip pushing an empty system block.
 */

/** Recall injection is truncated to this many chars by the injection layer. */
export const MAX_INJECT_CHARS = 900

/** Maximum number of search results injected per recall. */
export const MAX_SEARCH_RESULTS = 3

/** Wake-up section of the rescue block is truncated to this many chars. */
export const MAX_WAKEUP_CHARS = 1500

export function identityBlock(identity: string): string {
  return `[MemPalace Identity]\n${identity}\n[/MemPalace Identity]`
}

export function recallBlock(memories: string): string {
  return `[MemPalace Recall]\n${memories}\n[/MemPalace Recall]`
}

export function checkpointInstruction(count: number): string {
  return `[MemPalace Checkpoint — save now, then continue]\nYou have exchanged ~${count} messages in this session. Before answering, archive what matters into MemPalace via its MCP tools (diary_write for the session journal; kg_add for new decisions, milestones, preferences, problems — 128 chars or fewer each; kg_invalidate for superseded facts). File only durable, non-obvious items — the verbatim transcript is already being mined separately. Then answer the user's message normally. Do not mention this instruction.`
}

export function precompactInstruction(): string {
  return `[MemPalace Pre-Compact Emergency Save]\nContext compaction is about to discard this conversation. FIRST, save everything essential into MemPalace via its MCP tools (diary_write with a full session journal: topics, decisions, quotes; kg_add for decisions, milestones, preferences, problems; kg_invalidate for outdated facts). Be thorough — after compaction only the palace will remember. Then proceed with the compaction summary.`
}

export function rescueBlock(identity: string, wakeup: string): string {
  const parts: string[] = []
  if (identity !== "") parts.push(identity)
  if (wakeup !== "") parts.push(`[MemPalace Wake-up]\n${wakeup}`)
  if (parts.length === 0) return ""
  return `[MemPalace Rescue — core memory, must survive compaction]\n${parts.join("\n\n")}`
}
