/**
 * Toast emitter for the server plugin: config-gated with a busy throttle.
 *
 *   - The `toasts` flag is read from plugin-config.json ONCE at construction
 *     (V1 read config at startup); a later config flip requires a plugin
 *     reload. `toasts:false` makes the emitter silently drop everything.
 *   - Busy throttle (V1): at most one busy notice per BUSY_TOAST_WINDOW_MS,
 *     recognized as `variant === "info" && message.startsWith("palace busy")`.
 *     Everything else passes through unthrottled.
 *
 * Pure logic + the injected `emit` bridge (the RPC call is wired in index.ts),
 * so the whole gate/throttle behavior is unit-testable without a plugin host.
 *
 * startupToastMessage builds the V1 startup toast text (version + backlog
 * suffix); the 15s timer that fires it lives in index.ts with the plugin
 * lifetime it belongs to.
 */
import { readConfig } from "./config"
import type { Paths } from "./paths"
import type { ToastPayload } from "./rpc"

/** At most one busy notice per 5 minutes (V1 value). */
export const BUSY_TOAST_WINDOW_MS = 5 * 60 * 1000

/** Busy notices are recognized by this message prefix (info variant only). */
const BUSY_MESSAGE_PREFIX = "palace busy"

// ---------------------------------------------------------------------------
// Startup toast message (pure)
// ---------------------------------------------------------------------------

/**
 * V1 startup toast text: `opencode-mempalace v0.0.0 loaded` plus a backlog
 * suffix — `, N file(s) waiting to mine` when export files are pending under
 * the sync workspace, `, queue empty` otherwise.
 */
export function startupToastMessage(name: string, version: string, pendingFiles: number): string {
  const suffix = pendingFiles > 0 ? `, ${pendingFiles} file(s) waiting to mine` : ", queue empty"
  return `${name} v${version} loaded${suffix}`
}

/**
 * Build the emitter. `now` is injectable so the busy window is testable
 * without real time; default is the wall clock.
 */
export function makeToastEmitter(
  paths: Paths,
  emit: (payload: ToastPayload) => void,
  now: () => number = () => Date.now(),
): (variant: "info" | "success" | "warning" | "error", title: string, message: string) => void {
  const enabled = readConfig(paths).toasts
  let lastBusyTs: number | null = null

  return (variant, title, message) => {
    if (!enabled) return
    if (variant === "info" && message.startsWith(BUSY_MESSAGE_PREFIX)) {
      const ts = now()
      if (lastBusyTs !== null && ts - lastBusyTs < BUSY_TOAST_WINDOW_MS) return
      lastBusyTs = ts
    }
    emit({ variant, title, message })
  }
}
