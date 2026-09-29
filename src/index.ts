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
 *   command.transform()         /memory-status + /memory-log read-only views
 *                               (./commands render; results via
 *                               session.synthetic into the transcript)
 *   skill.transform()           auto-register the vendored recall skill
 *                               (content read ONCE at setup — transform
 *                               callbacks must stay cheap and synchronous)
 *   event.subscribe()           session.idle → debounced sync run (./pipeline)
 *   startup timer               one catch-up sync 10s after load,
 *                               startup toast 15s after load (V1)
 *   exit signals                synchronous rescue of pending wing dirs
 *                               (./pipeline runExitSync; no discovery/export)
 *
 * Failure discipline (V1): a hook must never break the host model call —
 * every handler is wrapped in try/catch and logs via ./logs.
 */
import { Plugin, type Skill } from "@opencode/plugin"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  MINE_LOG_TAIL_LINES,
  commandArgs,
  countPendingFiles,
  parseMemoryLogArgs,
  readLastLines,
  readLines,
  renderMemoryLog,
  renderMemoryStatus,
} from "./commands"
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
import { readConfig, readIdentity, readPackageInfo } from "./config"
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
import { collectCandidates, toExportMessages } from "./discover"
import { findMempalaceBin, mineArgs, runMempalace, runMempalaceSync, searchArgs, wakeUpArgs } from "./mempalace"
import { buildPaths } from "./paths"
import { runExitSync, runSync, backfillRequested } from "./pipeline"
import { MemPalaceUI, type ToastPayload } from "./rpc"
import { mergeSession, readCounters, readSessions, readSyncState, writeCounters, writeSessions } from "./state"
import { makeToastEmitter, startupToastMessage } from "./toast"

/** `mempalace search` budget at the context hook; a recall may never stall the model call. */
const SEARCH_TIMEOUT_MS = 15_000
/** `mempalace wake-up` budget at the compaction hook (V1: synchronous 15s salvage). */
const WAKEUP_TIMEOUT_MS = 15_000
/** `mempalace status` budget at /memory-status (read-only view; "" on failure). */
const STATUS_TIMEOUT_MS = 15_000
/**
 * V1 exit-rescue per-wing mine budget (planExitWings). Idle mines run with NO
 * timeout on purpose — V1 knew that killing the wrapper orphans the python
 * miner holding the palace lock, so an idle mine must be left to finish.
 */
const EXIT_PER_WING_MS = 30_000
/** V1 exit-rescue total budget across all wings (planExitWings default). */
const EXIT_BUDGET_MS = 45_000
/** V1 idle→sync delay: let the round settle before reading the context. */
const IDLE_SYNC_DELAY_MS = 3_000
/** Startup catch-up (design §7): pick up whatever an interrupted run left behind. */
const STARTUP_SYNC_DELAY_MS = 10_000
/** V1 startup toast delay: version + backlog notice once the host is settled. */
const STARTUP_TOAST_DELAY_MS = 15_000

/**
 * Repo root resolved from THIS module (`src/` → `..`). Works no matter where
 * the plugin is loaded from, and keeps the skill/package reads off the
 * process CWD (which is the host's, not ours).
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
/** Vendored recall skill source (V1 content; see skills/mempalace-recall/). */
const RECALL_SKILL_PATH = join(REPO_ROOT, "skills", "mempalace-recall", "SKILL.md")
/** This plugin's package.json (name/version for the startup toast). */
const PACKAGE_JSON_PATH = join(REPO_ROOT, "package.json")

/** Exit signals the synchronous rescue hooks into (SIGINT before exit; see onExit). */
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
    if (bin === null) {
      // V1 parity: a missing CLI is an ERROR line in hook.log, not just a note.
      log.err(`mempalace CLI not found (tried MEMPALACE_BIN env, PATH) — search/wake-up/mine disabled`)
    }

    // Package metadata for the startup toast (total: falls back, never throws).
    const pkg = readPackageInfo(PACKAGE_JSON_PATH)

    // Recall skill (V1 content vendored at skills/mempalace-recall/SKILL.md):
    // read ONCE here, before transform registration — V2 calls transform
    // callbacks whenever skills are listed/reloaded, so they must stay cheap
    // and synchronous (no IO inside the callback). A read failure logs an
    // ERROR and skips registration; the plugin keeps working without the skill.
    let recallSkillContent: string | null = null
    try {
      recallSkillContent = readFileSync(RECALL_SKILL_PATH, "utf8")
    } catch (err) {
      log.err(`recall skill not registered — cannot read ${RECALL_SKILL_PATH}: ${String(err)}`)
    }

    const onPrompt = async (event: { sessionID: string; prompt: { text: string }; metadata?: Record<string, unknown> }) => {
      try {
        const text = event.prompt.text ?? ""
        if (text.trim() === "") return
        const sessionID = event.sessionID

        const { armed, count } = checkpoints.onPrompt(sessionID)
        log.debug(`prompt ${sessionID}: humanMsgs=${count} armed=${armed}`)
        if (armed) {
          // V1 visibility at ARMING time: toast + interactions.log + hook.log.
          toast("info", "MemPalace", `checkpoint armed (~${count} msgs): the model will file memories now`)
          log.ilog("checkpoint", { sessionID, count })
          log.hook(`session ${sessionID}: ${count} human msgs — checkpoint armed`)
        }

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
        // V1 visibility: every search lands in the toast + interactions.log
        // (hit count from "\n [n]" result markers, || 1 for non-empty output
        // without markers); failure paths stay debug-silent.
        const query = recall.take()
        if (query !== null && bin !== null) {
          try {
            const startedAt = Date.now()
            const result = await runMempalace(bin, searchArgs(query, MAX_SEARCH_RESULTS), SEARCH_TIMEOUT_MS)
            if (result.ok) {
              const ms = Date.now() - startedAt
              const memories = result.stdout.trim()
              const hit = memories !== "" && !memories.includes("No results")
              const n = hit ? (memories.match(/\n\s*\[\d+\]/g) ?? []).length || 1 : 0
              toast("info", "MemPalace", `search "${query.slice(0, 50)}" → ${hit ? `${n} result(s)` : "no results"}`)
              log.ilog("search", { via: "cli", query: query.slice(0, 200), results: n, ms })
              if (hit) {
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
      // /memory-status + /memory-log (Task 11): read-only views assembled in
      // ./commands and delivered into the transcript via session.synthetic.
      // Command.execute receives { sessionID, prompt, delivery } where
      // prompt.text carries the text AFTER the command name (commandArgs
      // strips a leading "/<name>" token defensively). Every execute is
      // wrapped: on failure a short error line is synthetized, never thrown.
      await ctx.command.transform((editor) => {
        editor.add({
          name: "memory-status",
          description: "MemPalace palace health (drawers, cursors, backlog)",
          execute: async ({ sessionID }) => {
            try {
              let palaceStatus = ""
              if (bin !== null) {
                try {
                  const result = runMempalaceSync(bin, ["status"], STATUS_TIMEOUT_MS)
                  if (result.ok) palaceStatus = result.stdout.trim()
                } catch {
                  // CLI hosed → empty section, not a broken view.
                }
              }
              const text = renderMemoryStatus({
                pendingFiles: countPendingFiles(paths.syncDir),
                syncState: readSyncState(paths),
                lastMineLog: readLastLines(paths.hookLog, MINE_LOG_TAIL_LINES),
                palaceStatus,
              })
              log.debug(`memory-status served (session ${sessionID})`)
              await ctx.session.synthetic({ sessionID, text })
            } catch (err) {
              log.err(`memory-status failed: ${String(err)}`)
              try {
                await ctx.session.synthetic({ sessionID, text: "MemPalace status unavailable (see hook.log)" })
              } catch {
                // Synthetic itself failing: nothing left to do.
              }
            }
          },
        })
        editor.add({
          name: "memory-log",
          description: "MemPalace interaction history (newest last)",
          execute: async ({ sessionID, prompt }) => {
            try {
              const { n, filter } = parseMemoryLogArgs(commandArgs(prompt.text, "memory-log"))
              const text = renderMemoryLog(readLines(paths.interactionsLog), n, filter)
              log.debug(`memory-log served (session ${sessionID}, n=${n}, filter=${filter ?? "none"})`)
              await ctx.session.synthetic({ sessionID, text })
            } catch (err) {
              log.err(`memory-log failed: ${String(err)}`)
              try {
                await ctx.session.synthetic({ sessionID, text: "MemPalace log unavailable (see hook.log)" })
              } catch {
                // Synthetic itself failing: nothing left to do.
              }
            }
          },
        })
      }),
    ]

    // Auto-register the recall skill (design §4: V1's "manually copy the
    // skill" step becomes skill.transform). Field types carry effect brands
    // (Skill.ID / Skill.Name / AbsolutePath) that are runtime-transparent;
    // the casts only satisfy the branded schema types.
    if (recallSkillContent !== null) {
      const content = recallSkillContent
      registrations.push(
        await ctx.skill.transform((editor) => {
          editor.add({
            id: "mempalace-recall" as Skill.Info["id"],
            name: "MemPalace Recall" as Skill.Info["name"],
            description: "Question-driven search-before-answer protocol for MemPalace",
            path: RECALL_SKILL_PATH as Skill.Info["path"],
            content,
          })
        }),
      )
      log.debug(`recall skill registered (${RECALL_SKILL_PATH}, ${content.length} chars)`)
    }

    // Sync-engine triggers (Ruling 13): thin wiring only — debounce, locking,
    // export, mining and state all live in ./pipeline. `session.idle` events
    // schedule a run after the V1 3s settle delay; one startup run 10s after
    // load catches anything an interrupted previous run left behind.
    const startSync = (): void => {
      const backfill = backfillRequested(process.env)
      void runSync(
        {
          readContext: async (sessionID) => toExportMessages(await ctx.session.context({ sessionID })),
          // runSync forwards its opts.backfill so discovery widens its cursor
          // floor to 0 exactly when the run is a forced full export.
          listCandidates: (bf) => collectCandidates(paths, { backfill: bf === true }),
          runMine: async (wingDir, wing) => {
            if (bin === null) return { ok: false, error: "mempalace CLI not found" }
            // NO timeout (V1): an idle mine runs to completion — killing the
            // wrapper would orphan the python miner holding the palace lock.
            return runMempalace(bin, mineArgs(wingDir, wing))
          },
          now: () => Date.now(),
        },
        paths,
        { toast, loggers: log, backfill },
      )
    }
    const scheduleSync = (): void => {
      setTimeout(startSync, IDLE_SYNC_DELAY_MS)
    }
    const idleEvents = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: idleEvents.signal })) {
          if (event.type !== "session.idle") continue
          scheduleSync()
        }
      } catch {
        // Aborted at cleanup or the shared stream closed — either way, stop.
      }
    })()
    const startupSync = setTimeout(startSync, STARTUP_SYNC_DELAY_MS)
    log.debug("sync triggers armed: session.idle (+3s), startup (+10s)")

    // V1 startup toast (15s): plugin identity + export backlog. Emitted
    // through the same config-gated emitter, so `toasts:false` stays silent.
    const startupToast = setTimeout(() => {
      toast("info", "MemPalace", startupToastMessage(pkg.name, pkg.version, countPendingFiles(paths.syncDir)))
    }, STARTUP_TOAST_DELAY_MS)

    // Exit rescue (Task 13): synchronous salvage of whatever a failed/busy
    // run left in oc-sessions/ — discovery/export need async ctx reads and
    // are skipped; the miningLock is deliberately ignored (V1: exit takes
    // ownership). `exitDone` guards double-fire because several signals can
    // arrive during shutdown.
    let exitDone = false
    const onExit = (): void => {
      if (exitDone) return
      exitDone = true
      try {
        const backfill = backfillRequested(process.env)
        if (backfill) log.debug("backfill requested at exit: mining pending exports")
        runExitSync(
          {
            runMineSync: (wingDir, wing, timeoutMs) =>
              bin === null
                ? { ok: false, error: "mempalace CLI not found" }
                : runMempalaceSync(bin, mineArgs(wingDir, wing), timeoutMs),
            now: () => Date.now(),
          },
          paths,
          { loggers: log, budgetMs: EXIT_BUDGET_MS, perWingMs: EXIT_PER_WING_MS },
        )
      } catch (err) {
        log.err(`exit save failed: ${String(err)}`)
      }
    }
    for (const signal of EXIT_SIGNALS) process.once(signal, onExit)

    log.debug("hooks registered: prompt, context, compaction, execute.after; commands: memory-status, memory-log")

    return async () => {
      idleEvents.abort()
      clearTimeout(startupSync)
      clearTimeout(startupToast)
      for (const signal of EXIT_SIGNALS) process.removeListener(signal, onExit)
      for (const registration of registrations) await registration.dispose()
      await rpc.dispose()
    }
  },
})
