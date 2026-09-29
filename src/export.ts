/**
 * Pure transcript-export helpers, ported verbatim from V1's
 * exportNewSessions (src/index.ts of opencode-mempalace-persistence):
 *
 *   wingFor          directory -> wing name (sanitize + truncate)
 *   buildTranscript  flat transcript format (`# title` / `Date:` / `Session:` /
 *                    `## ROLE — HH:MM:SS` blocks)
 *   exportFileName   sync_{date}_{label}_{id8}_{sha256^12}.txt
 *   filterExportable message-level dedup + incomplete-reply separation
 *   cursorClamp      never advance a wing cursor past an in-flight reply
 *
 * NO IO in this module — Task 10's pipeline owns file writing, mining and
 * state. Everything here is deterministic and side-effect free, so re-exports
 * are naturally idempotent (the filename embeds a content hash).
 */
import { createHash } from "node:crypto"

/**
 * Map a session working directory to its wing name (one wing per project,
 * V1 semantics):
 *
 * 1. normalize `\` to `/` BEFORE splitting — on Windows the session
 *    directory arrives as `D:\a\my proj`, and V1's forward-slash-only
 *    split would use the whole path as one segment, mapping every
 *    project to a different broken wing (Review Focus #1);
 * 2. take the last NON-EMPTY path segment (trailing slashes collapse);
 * 3. sanitize every character outside [a-zA-Z0-9_-] to `_`;
 * 4. truncate to 40 characters; no usable segment -> "global".
 */
export function wingFor(directory: string | null | undefined): string {
  const last = (directory ?? "").replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? ""
  return last.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "global"
}

/** One message in a session export, as read by the pipeline from session context. */
export interface ExportMessage {
  /** Message id — the message-level dedup key (mined_ids entry). */
  id: string
  /** Source role ("user" / "assistant"); uppercased in the transcript header. */
  role: string
  /** Text parts joined; empty/whitespace-only messages are not exported. */
  text: string
  /** Created-at ms epoch (drives the HH:MM:SS timestamps). */
  ts: number
  /** False while a reply is still streaming — never export those. */
  complete: boolean
}

/**
 * Render the V1-verbatim flat transcript:
 *
 *     # {title}
 *     Date: {YYYY-MM-DD}
 *     Session: {sessionId}
 *
 *     ## {ROLE} — {HH:MM:SS}
 *
 *     {text}
 *
 * Timestamps are UTC (`toISOString()`), exactly like V1. The `Date:` line
 * follows the LAST message (V1 stamped export time, which on idle/exit is
 * the moment right after the newest message; this fn takes no clock — the
 * export date itself lives in the filename via `exportFileName`).
 *
 * Returns V1's `content`: lines joined and trimmed, NO trailing newline —
 * the caller writes `content + "\n"` and hashes `content` verbatim.
 */
export function buildTranscript(title: string, sessionId: string, msgs: ExportMessage[]): string {
  const date = msgs.length > 0 ? new Date(msgs[msgs.length - 1].ts).toISOString().slice(0, 10) : ""
  const lines: string[] = [`# ${title}`, `Date: ${date}`, `Session: ${sessionId}`, ""]
  for (const m of msgs) {
    const hhmmss = new Date(m.ts).toISOString().slice(11, 19)
    lines.push(`## ${m.role.toUpperCase()} \u2014 ${hhmmss}`, "", m.text, "")
  }
  return lines.join("\n").trim()
}

/**
 * V1 export filename: `sync_{YYYY-MM-DD}_{label≤30}_{sessionId^8}_{sha256(content)^12}.txt`.
 *
 * The label sanitizes `[^a-zA-Z0-9 _-]` to `_` (spaces SURVIVE here, unlike
 * wing names) and falls back to the first 8 chars of the session id when the
 * title is empty. The content hash makes re-exports of identical content
 * land on the identical filename — naturally idempotent.
 */
export function exportFileName(now: Date, title: string, sessionId: string, content: string): string {
  const day = now.toISOString().slice(0, 10)
  const label = (title.replace(/[^a-zA-Z0-9 _-]/g, "_") || sessionId.slice(0, 8)).slice(0, 30)
  const id8 = sessionId.slice(0, 8)
  const hash12 = createHash("sha256").update(content).digest("hex").slice(0, 12)
  return `sync_${day}_${label}_${id8}_${hash12}.txt`
}

/**
 * Split session messages into exportable text and incomplete timestamps
 * (V1 message-level dedup, adapted to V2's `complete` flag):
 *
 * 1. drop messages whose id is already in `seen` (mined in a previous
 *    export — each message is exported exactly once, ever);
 * 2. drop empty/whitespace-only text;
 * 3. `complete: false` (streaming reply) never exports — its ts goes to
 *    `incompleteTs` so the wing cursor can be clamped below it and the
 *    reply revisited complete on the next sync.
 *
 * Whether fewer than 2 exportable messages justify skipping the whole
 * session is the PIPELINE's decision (Review Focus #3), not this filter's.
 */
export function filterExportable(
  msgs: ExportMessage[],
  seen: Set<string>,
): { exportable: ExportMessage[]; incompleteTs: number[] } {
  const exportable: ExportMessage[] = []
  const incompleteTs: number[] = []
  for (const m of msgs) {
    if (seen.has(m.id)) continue
    if (!m.text.trim()) continue
    if (!m.complete) {
      incompleteTs.push(m.ts)
      continue
    }
    exportable.push(m)
  }
  return { exportable, incompleteTs }
}

/**
 * Cursor for `markWingSynced` after one wing's export: when anything was
 * skipped as incomplete, clamp to min(incompleteTs) - 1 so the in-flight
 * reply is re-read by the next sync (idle/exit/startup); otherwise the
 * wing may advance to `fallbackNow`.
 */
export function cursorClamp(incompleteTs: number[], fallbackNow: number): number {
  return incompleteTs.length > 0 ? Math.min(...incompleteTs) - 1 : fallbackNow
}
