/**
 * MemPalace V2 API probe plugin (Task 1).
 *
 * Verifies the three assumptions the V2 port depends on:
 *   A1  `ctx.session.list` availability in the plugin context
 *   A2  `node:sqlite` availability in the plugin runtime
 *   A3  session message shape via `ctx.session.context()` (fresh + live session)
 *
 * Findings are written to `~/.mempalace/hook_state/v2-probe-findings.json`.
 * Every capture and write is wrapped in try/catch: the probe must never
 * crash, block, or otherwise disturb the host opencode process.
 *
 * This file is intentionally self-contained so it can be copied verbatim to
 * a scratch project's `.opencode/plugins/probe/index.ts`.
 */
import { Plugin } from "@opencode/plugin"
import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const FINDINGS_PATH = join(homedir(), ".mempalace", "hook_state", "v2-probe-findings.json")

/** Max serialized length kept for any captured object (guards huge payloads). */
const MAX_CAPTURE_CHARS = 50_000
/** Cap on live-context re-captures so streaming events cannot hammer the file. */
const MAX_CONTEXT_CAPTURES = 20

type Captured = { truncated: boolean; value: unknown }

interface SessionListFinding {
  typeof: string
  called: boolean
  ok?: boolean
  count?: number
  firstItemKeys?: string[]
  sampleFirstItem?: Captured | null
  error?: string
}

interface ContextShape {
  sessionID?: string
  count?: number
  firstElementKeys?: string[] | null
  infoKeys?: string[] | null
  full?: Captured | null
  error?: string
}

interface Findings {
  pluginVersion: string | null
  capturedAt: string
  runtime: { node?: string; bun?: string; provider: string }
  sessionList: SessionListFinding
  nodeSqlite: { ok: boolean; exportKeys?: string[]; error?: string }
  contextShape: { freshSession: ContextShape | null; liveSession: ContextShape | null }
  messageEventShape: {
    matcher: string
    observedEventTypes: string[]
    messageEventTypes: string[]
    messageEventCount: number
    firstMessageEvent: { type: string; full: Captured } | null
    lastMessageEvent: { type: string; full: Captured } | null
  }
}

/**
 * Event types that carry message lifecycle/content. V2 has no event type
 * literally containing "message"; the closest are session.step.* (assistant
 * turn lifecycle) and session.text.* (streamed text), plus prompt admission
 * via session.inbox.delivered. The literal "message" substring is still
 * matched in case rpc/message events appear.
 */
const MESSAGE_EVENT_PATTERN = /message|^session\.(step|text)\.|^session\.inbox\.delivered$|^session\.synthetic$/

const findings: Findings = {
  pluginVersion: null,
  capturedAt: "",
  runtime: { provider: "unknown" },
  sessionList: { typeof: "unknown", called: false },
  nodeSqlite: { ok: false },
  contextShape: { freshSession: null, liveSession: null },
  messageEventShape: {
    matcher: MESSAGE_EVENT_PATTERN.source,
    observedEventTypes: [],
    messageEventTypes: [],
    messageEventCount: 0,
    firstMessageEvent: null,
    lastMessageEvent: null,
  },
}

/** Serialize a captured object defensively; truncate oversized payloads. */
function capture(value: unknown): Captured {
  let text: string
  try {
    text = JSON.stringify(value, null, 2) ?? String(value)
  } catch (err) {
    text = `<unserializable: ${String(err)}>`
  }
  if (text.length > MAX_CAPTURE_CHARS) {
    return { truncated: true, value: text.slice(0, MAX_CAPTURE_CHARS) + "\n…<truncated>" }
  }
  return { truncated: false, value: JSON.parse(text) }
}

/** Extract sessionID from an event, trying the plausible shapes. */
function sessionIDOf(event: any): string | undefined {
  return (
    event?.data?.sessionID ??
    event?.properties?.sessionID ??
    event?.sessionID ??
    event?.properties?.info?.sessionID ??
    undefined
  )
}

function contextFinding(messages: unknown, sessionID?: string): ContextShape {
  const list = Array.isArray(messages) ? messages : []
  const first = list[0] as Record<string, unknown> | undefined
  const info = first?.info as Record<string, unknown> | undefined
  return {
    sessionID,
    count: list.length,
    firstElementKeys: first ? Object.keys(first) : null,
    infoKeys: info ? Object.keys(info) : null,
    full: capture(list),
  }
}

function writeFindings(): void {
  try {
    findings.capturedAt = new Date().toISOString()
    mkdirSync(dirname(FINDINGS_PATH), { recursive: true })
    writeFileSync(FINDINGS_PATH, JSON.stringify(findings, null, 2) + "\n", "utf8")
  } catch {
    // Swallow: the probe must never crash the host.
  }
}

export default Plugin.define({
  id: "mempalace-probe",
  async setup(ctx) {
    try {
      findings.pluginVersion = ctx.app.version
      findings.runtime = {
        node: process.versions.node,
        bun: process.versions.bun,
        provider: process.versions.bun ? "bun" : "node",
      }

      // A2: node:sqlite availability (module import only; no DB is opened).
      try {
        const sqlite = await import("node:sqlite")
        findings.nodeSqlite = { ok: true, exportKeys: Object.keys(sqlite).sort() }
      } catch (err) {
        findings.nodeSqlite = { ok: false, error: String(err) }
      }

      // A1: ctx.session.list availability.
      try {
        const listType = typeof (ctx.session as any).list
        if (listType === "function") {
          const response = await (ctx.session as any).list()
          // SessionsResponse is { data: SessionInfo[], cursor }; be defensive.
          const list: unknown[] = Array.isArray(response)
            ? response
            : Array.isArray(response?.data)
              ? response.data
              : []
          findings.sessionList = {
            typeof: listType,
            called: true,
            ok: true,
            count: list.length,
            firstItemKeys: list.length > 0 ? Object.keys(list[0] as object) : [],
            sampleFirstItem: list.length > 0 ? capture(list[0]) : null,
          }
        } else {
          findings.sessionList = { typeof: listType, called: false }
        }
      } catch (err) {
        findings.sessionList = {
          typeof: typeof (ctx.session as any).list,
          called: true,
          ok: false,
          error: String(err),
        }
      }

      // A3 (part 1): context shape of a freshly created session.
      try {
        const created = await ctx.session.create({ title: "probe" })
        const sessionID = (created as any).id ?? (created as any).sessionID
        const messages = await ctx.session.context({ sessionID })
        findings.contextShape.freshSession = contextFinding(messages, sessionID)
      } catch (err) {
        findings.contextShape.freshSession = { error: String(err) }
      }

      writeFindings()
    } catch (err) {
      // Record and continue: partial findings beat none, and setup must not throw.
      try {
        ;(findings as any).setupError = String(err)
      } catch {}
    }

    // A3 (part 2): capture the first/last message-bearing events and the
    // live session's context shape as they stream in.
    const controller = new AbortController()
    let contextCaptures = 0
    const shape = findings.messageEventShape

    const captureLiveContext = (sessionID: string) => {
      if (contextCaptures >= MAX_CONTEXT_CAPTURES) return
      contextCaptures++
      void ctx.session
        .context({ sessionID })
        .then((messages) => {
          findings.contextShape.liveSession = contextFinding(messages, sessionID)
          writeFindings()
        })
        .catch(() => {})
    }

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal }) as AsyncIterable<any>) {
          try {
            const type = String(event?.type ?? "unknown")
            if (!shape.observedEventTypes.includes(type)) shape.observedEventTypes.push(type)
            if (!MESSAGE_EVENT_PATTERN.test(type)) continue

            shape.messageEventCount++
            if (!shape.messageEventTypes.includes(type)) shape.messageEventTypes.push(type)
            const captured = { type, full: capture(event) }
            if (!shape.firstMessageEvent) shape.firstMessageEvent = captured
            shape.lastMessageEvent = captured

            const sessionID = sessionIDOf(event)
            if (sessionID) captureLiveContext(sessionID)
            writeFindings()
          } catch {
            // Ignore individual event handling failures.
          }
        }
      } catch {
        // Aborted or stream ended: nothing to do.
      }
    })()

    return () => controller.abort()
  },
})
