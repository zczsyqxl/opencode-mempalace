/**
 * MemPalace server plugin (V2) — hook wiring, Task 9.
 *
 * This file is deliberately thin orchestration (Ruling 4): every piece of
 * logic lives in a tested module — cadence/recall state machines and tool
 * visibility copy in ./hooks, toast gating/throttling in ./toast, block copy
 * in ./blocks, persistence in ./state, CLI calls in ./mempalace. Here we only
 * bind them to the OpenCode V2 plugin APIs:
 *
 *   session.hook("prompt")      count human messages (persist counters),
 *                               arm checkpoints, register the session,
 *                               plan recall (autoInject only)
 *   session.hook("context")     deliver armed checkpoint instructions,
 *                               inject identity (once per plugin lifetime)
 *                               + recall search results (autoInject only)
 *   session.hook("compaction")  pre-compact save instruction + rescue block
 *                               (identity + synchronous `mempalace wake-up`)
 *   tool.hook("execute.after")  toast + ilog for every mempalace tool call
 *
 * Failure discipline (V1): a hook must never break the host model call —
 * every handler is wrapped in try/catch and logs via ./logs.
 */
import { Plugin } from "@opencode/plugin"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  MAX_INJECT_CHARS,
  MAX_SEARCH_RESULTS,
  MAX_WAKEUP_CHARS,
  checkpointInstruction,
  identityBlock,
  precompactInstruction,
  recallBlock,
  rescueBlock,
} from "./blocks"
import { readConfig, readIdentity } from "./config"
import {
  TOOL_LOG_ASKED_CHARS,
  TOOL_LOG_ANSWERED_CHARS,
  createCheckpointStateMachine,
  createIdentityLatch,
  createRecallPlanner,
  extractResultText,
  formatToolArgs,
  toolToastMessage,
  truncate,
  type ToolResultLike,
} from "./hooks"
import { makeLoggers } from "./logs"
import { findMempalaceBin, runMempalace, runMempalaceSync, searchArgs, wakeUpArgs } from "./mempalace"
import { buildPaths } from "./paths"
import { MemPalaceUI, type ToastPayload } from "./rpc"
import { mergeSession, readCounters, readSessions, writeCounters, writeSessions } from "./state"
import { makeToastEmitter } from "./toast"

/** `mempalace search` budget at the context hook; a recall may never stall the model call. */
const SEARCH_TIMEOUT_MS = 15_000
/** `mempalace wake-up` budget at the compaction hook (V1: synchronous 15s salvage). */
const WAKEUP_TIMEOUT_MS = 15_000

/** Exit signals the save skeleton hooks into (Task 13 fills the body). */
const EXIT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "exit"] as const

export default Plugin.define({
  id: "mempalace",
  async setup(ctx) {
    const paths = buildPaths(join(homedir(), ".mempalace"))
    const debug = (process.env.OPENCODE_MEMPALACE_DEBUG ?? "").trim() !== ""
    const log = makeLoggers(paths, debug)
    const config = readConfig(paths)
    const bin = findMempalaceBin()
    const checkpoints = createCheckpointStateMachine(config.saveInterval, {
      read: () => readCounters(paths),
      write: (counters) => writeCounters(paths, counters),
    })
    const recall = createRecallPlanner()
    // V1 `wakeupDone` semantics: the identity block is injected on the FIRST
    // context hook event of this plugin's lifetime. The agent loop always
    // assembles a transcript with at least the current user message, so a
    // messages-length gate would be dead code.
    const identityLatch = createIdentityLatch()

    const rpc = await ctx.rpc.register(MemPalaceUI, {})
    const toast = makeToastEmitter(paths, (payload: ToastPayload) => {
      // JSON-Schema-typed RPC events are Record<string, unknown> at the type
      // level; the payload shape is guaranteed by the shared ToastPayload.
      void rpc.events.emit("toast", payload as unknown as Record<string, unknown>).catch(() => {})
    })

    log.hook(
      `mempalace plugin loaded (saveInterval=${config.saveInterval}, autoInjectContext=${config.autoInjectContext}, toasts=${config.toasts}, bin=${bin ?? "not found"})`,
    )

    const onPrompt = async (event: { sessionID: string; prompt: { text: string }; metadata?: Record<string, unknown> }) => {
      try {
        const text = event.prompt.text ?? ""
        if (text.trim() === "") return
        const sessionID = event.sessionID

        const { armed, count } = checkpoints.onPrompt(sessionID)
        log.debug(`prompt ${sessionID}: humanMsgs=${count} armed=${armed}`)

        // Register/refresh the session for the discovery chain (Task 10):
        // directory prefers event metadata, then the session record, then the
        // plugin's own location; title only when the session record has one.
        let directory: string = ctx.location.directory
        const metaDir = event.metadata?.directory
        if (typeof metaDir === "string" && metaDir !== "") directory = metaDir
        let title: string | undefined
        try {
          const info = await ctx.session.get({ sessionID })
          const sessionDir = info.location?.directory
          if (directory === ctx.location.directory && typeof sessionDir === "string" && sessionDir !== "") {
            directory = sessionDir
          }
          if (typeof info.title === "string" && info.title !== "") title = info.title
        } catch {
          // Session lookup is best-effort; ctx.location.directory still works.
        }
        writeSessions(paths, mergeSession(readSessions(paths), sessionID, { directory, title, lastSeenMs: Date.now() }))

        if (config.autoInjectContext) recall.plan(text)
      } catch (err) {
        log.err(`prompt hook failed: ${String(err)}`)
      }
    }

    const onContext = async (event: { sessionID: string; system: Array<{ type: "text"; text: string }> }) => {
      try {
        const pending = checkpoints.takePending(event.sessionID)
        if (pending) {
          event.system.push({ type: "text", text: checkpointInstruction(pending.count) })
          log.hook(`checkpoint instruction delivered (session ${pending.sessionID}, ~${pending.count} messages)`)
        }

        if (!config.autoInjectContext) return

        // Identity once per plugin lifetime (see identityLatch above), skipped
        // when the trimmed identity is empty (Ruling 8: trim at the consumer).
        // Stays before the recall block below.
        if (identityLatch.shouldInject()) {
          const identity = readIdentity(paths).trim()
          if (identity !== "") event.system.push({ type: "text", text: identityBlock(identity) })
        }

        // Recall: one search per planned query; "No results" counts as empty;
        // any failure is swallowed — recall must never break the model call.
        const query = recall.take()
        if (query !== null && bin !== null) {
          try {
            const result = await runMempalace(bin, searchArgs(query, MAX_SEARCH_RESULTS), SEARCH_TIMEOUT_MS)
            if (result.ok) {
              const memories = result.stdout.trim()
              if (memories !== "" && !memories.includes("No results")) {
                event.system.push({ type: "text", text: recallBlock(memories.slice(0, MAX_INJECT_CHARS)) })
              }
            } else {
              log.debug(`recall search failed: ${result.error}`)
            }
          } catch (err) {
            log.debug(`recall search threw: ${String(err)}`)
          }
        }
      } catch (err) {
        log.err(`context hook failed: ${String(err)}`)
      }
    }

    const onCompaction = (event: { system: Array<{ type: "text"; text: string }> }) => {
      try {
        event.system.push({ type: "text", text: precompactInstruction() })
        const identity = readIdentity(paths).trim()
        let wakeup = ""
        if (bin !== null) {
          try {
            const result = runMempalaceSync(bin, wakeUpArgs(), WAKEUP_TIMEOUT_MS)
            if (result.ok) wakeup = result.stdout.trim().slice(0, MAX_WAKEUP_CHARS)
          } catch {
            // Wake-up failure → empty wakeup section, never a broken compaction.
          }
        }
        const rescue = rescueBlock(identity, wakeup)
        if (rescue !== "") event.system.push({ type: "text", text: rescue })
        log.hook(`compaction rescue pushed (identity=${identity !== ""}, wakeup=${wakeup !== ""})`)
      } catch (err) {
        log.err(`compaction hook failed: ${String(err)}`)
      }
    }

    const onToolAfter = (event: { tool: string; input: unknown } & ({ status: "completed"; result?: unknown } | { status: "error"; error: { message: string } })) => {
      try {
        if (!event.tool.toLowerCase().includes("mempalace")) return
        const asked = formatToolArgs(event.input)
        const answered =
          event.status === "completed"
            ? extractResultText(event.result as ToolResultLike | undefined)
            : event.error.message
        toast("info", "MemPalace", toolToastMessage(event.tool, asked, answered))
        log.ilog("tool", {
          tool: event.tool,
          asked: truncate(asked, TOOL_LOG_ASKED_CHARS),
          answered: truncate(answered, TOOL_LOG_ANSWERED_CHARS),
        })
      } catch (err) {
        log.err(`tool hook failed: ${String(err)}`)
      }
    }

    const registrations = [
      await ctx.session.hook("prompt", onPrompt),
      // Scope note (official V2 plugin docs): the "context" hook "runs for
      // the agent loop, including tool-driven continuations" — title,
      // compaction, and generate are SEPARATE hook names. Auxiliary requests
      // therefore cannot reach this handler, so they can never consume the
      // recall/checkpoint slots; no kind-gating is needed here.
      await ctx.session.hook("context", onContext),
      await ctx.session.hook("compaction", onCompaction),
      await ctx.tool.hook("execute.after", onToolAfter),
    ]

    // Exit-save skeleton (Task 13 fills the body); guard against double-fire
    // because several signals can arrive during shutdown.
    let exitDone = false
    const onExit = (): void => {
      if (exitDone) return
      exitDone = true
      // Task 13: synchronous exit salvage (final mine / state flush) goes here.
    }
    for (const signal of EXIT_SIGNALS) process.once(signal, onExit)

    log.debug("hooks registered: prompt, context, compaction, execute.after")

    return async () => {
      for (const signal of EXIT_SIGNALS) process.removeListener(signal, onExit)
      for (const registration of registrations) await registration.dispose()
      await rpc.dispose()
    }
  },
})
