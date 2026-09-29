/**
 * Thin, testable wrappers around the `mempalace` CLI, ported from V1 semantics.
 *
 * Disciplines carried over from V1 (see task brief):
 *
 *   - argv arrays ONLY. The CLI is spawned via execFile/spawnSync without a
 *     shell, so a wing name or query can never be interpreted as a command.
 *   - Bin resolution never throws: `resolveMempalaceBin` returns null when the
 *     CLI is not installed, and callers degrade gracefully (Review Focus #5).
 *   - Child stdout buffer is 64 MiB: mine exports can be large, and V1 hit
 *     ENOBUFS with Node's 1 MiB default.
 *   - Lock contention ("is held by") is distinguished from every other mine
 *     failure so the sync engine can back off instead of erroring a wing.
 *
 * Everything except `runMempalace`/`runMempalaceSync`/`findMempalaceBin` is a
 * pure function with its dependencies injected — no process, no filesystem.
 */
import { execFile, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

/** 64 MiB child stdio cap (V1 value): large mine outputs, ENOBUFS protection. */
export const CHILD_MAX_BUFFER = 64 * 1024 * 1024

/** Uniform result of a mempalace invocation: success carries stdout, failure an error string. */
export type MempalaceResult =
  | { ok: true; stdout: string }
  | { ok: false; error: string }

/**
 * Resolve the mempalace binary, V1 priority order:
 *
 *   1. `MEMPALACE_BIN` env override — used only when it actually exists,
 *      so a stale override cannot brick the plugin when the CLI moves.
 *   2. PATH lookup (`where` on win32, `command -v` otherwise) — the injected
 *      `lookup(cmd)` returns the trimmed command output or throws; `where`
 *      may list several candidates, the first line wins.
 *   3. `~/.local/bin/mempalace` fallback (home from USERPROFILE on win32,
 *      HOME otherwise, per the injected `platform`).
 *   4. null — never throws. Callers must degrade gracefully (Review Focus #5).
 */
export function resolveMempalaceBin(
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean,
  platform: NodeJS.Platform,
  lookup: (cmd: string) => string,
): string | null {
  const fromEnv = (env.MEMPALACE_BIN ?? "").trim()
  if (fromEnv !== "" && exists(fromEnv)) return fromEnv

  try {
    const first = lookup("mempalace").split(/\r?\n/)[0]?.trim() ?? ""
    if (first !== "") return first
  } catch {
    // Not on PATH — fall through to the canonical install location.
  }

  const home =
    platform === "win32" ? env.USERPROFILE ?? env.HOME : env.HOME ?? env.USERPROFILE
  if (home) {
    const fallback = join(home, ".local", "bin", "mempalace")
    if (exists(fallback)) return fallback
  }

  return null
}

/**
 * Real-environment wiring of `resolveMempalaceBin` (process.env/process.platform
 * overridable for tests). The PATH lookup runs `where mempalace` on win32 and
 * `sh -c "command -v mempalace"` elsewhere, matching V1. Never throws.
 */
export function findMempalaceBin(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return resolveMempalaceBin(env, existsSync, platform, (cmd) => {
    const r =
      platform === "win32"
        ? spawnSync("where", [cmd], { timeout: 5_000, encoding: "utf8", windowsHide: true })
        : spawnSync("sh", ["-c", `command -v ${cmd}`], { timeout: 5_000, encoding: "utf8" })
    if (r.error || r.status !== 0) throw new Error(`PATH lookup failed for ${cmd}`)
    const out = r.stdout.trim()
    if (out === "") throw new Error(`PATH lookup returned nothing for ${cmd}`)
    return out
  })
}

/** `mempalace search <query> --results <n>` (V1 default: 3). */
export function searchArgs(query: string, results = 3): string[] {
  return ["search", query, "--results", String(results)]
}

/** `mempalace wake-up` — palace identity warm-up. */
export function wakeUpArgs(): string[] {
  return ["wake-up"]
}

/** `mempalace mine <wingDir> --mode convos --agent opencode --wing <wing>` (V1). */
export function mineArgs(wingDir: string, wing: string): string[] {
  return ["mine", wingDir, "--mode", "convos", "--agent", "opencode", "--wing", wing]
}

/** Lock contention ("... is held by ...") → "busy"; every other failure → "error". */
export function classifyMineError(msg: string): "busy" | "error" {
  return /is held by/i.test(msg) ? "busy" : "error"
}

/** Count of `Drawers filed: <n>` from mine output; 0 when absent. */
export function parseDrawers(stdout: string): number {
  const m = /Drawers filed:\s*(\d+)/i.exec(stdout)
  return m ? Number.parseInt(m[1], 10) : 0
}

/**
 * Run the CLI asynchronously (execFile, no shell). Resolves — never rejects —
 * with `{ ok: true, stdout }` or `{ ok: false, error }`; the error string keeps
 * stderr so `classifyMineError` can see lock contention messages.
 *
 * `timeoutMs` is OPTIONAL: omitted (or 0) means NO timeout (execFile default)
 * — V1 ran idle mines unbounded on purpose, because killing the wrapper
 * orphans the python miner holding the palace lock. Only callers with a real
 * budget (search, wake-up) pass one.
 */
export function runMempalace(
  bin: string,
  args: string[],
  timeoutMs?: number,
  maxBuffer: number = CHILD_MAX_BUFFER,
): Promise<MempalaceResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs ?? 0, maxBuffer, encoding: "utf8", windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const parts = [stderr.trim(), err.message].filter((p) => p !== "")
          resolve({ ok: false, error: parts.join("\n") })
          return
        }
        resolve({ ok: true, stdout })
      },
    )
  })
}

/**
 * Run the CLI synchronously (spawnSync, no shell) — exit-time salvage path.
 * Same result shape and error-string rule as `runMempalace`.
 */
export function runMempalaceSync(
  bin: string,
  args: string[],
  timeoutMs: number,
): MempalaceResult {
  const r = spawnSync(bin, args, {
    timeout: timeoutMs,
    maxBuffer: CHILD_MAX_BUFFER,
    encoding: "utf8",
    windowsHide: true,
  })
  if (r.error || r.status !== 0) {
    const parts = [
      typeof r.stderr === "string" ? r.stderr.trim() : "",
      r.error ? r.error.message : "",
      r.status !== 0 && r.status !== null ? `exit code ${r.status}` : "",
    ].filter((p) => p !== "")
    return { ok: false, error: parts.join("\n") || "mempalace failed" }
  }
  return { ok: true, stdout: r.stdout ?? "" }
}
