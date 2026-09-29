/**
 * Plugin configuration and identity, ported from V1 semantics:
 *
 *   ~/.mempalace/plugin-config.json
 *     autoInjectContext (boolean, default false)
 *     saveInterval       (number,  default 15; invalid or <5 falls back to 15)
 *     toasts             (boolean, default true)
 *   ~/.mempalace/identity.txt   palace identity text (missing → "")
 *
 * Plus the repo's own package.json metadata (name/version) for the startup
 * toast — same total-parsing discipline: any failure falls back, never throws.
 *
 * Parsing is total: malformed JSON, wrong types, or a missing file all fall
 * back to the V1 defaults and never throw — a broken config must not crash
 * the host opencode process (Review Focus #2). Fallback is per field, so one
 * bad key (e.g. `saveInterval: "x"`) cannot silently disable the others.
 */
import { readFileSync } from "node:fs"
import type { Paths } from "./paths"

/** User-tunable plugin options with V1-compatible defaults. */
export interface PluginConfig {
  /** Inject identity + recall results into conversations (V1 default: off). */
  autoInjectContext: boolean
  /** Human messages per AI checkpoint (V1 default 15, floor 5). */
  saveInterval: number
  /** Show startup toast (V1 default: on). */
  toasts: boolean
}

/** V1 defaults, used verbatim whenever a value is missing or invalid. */
export const DEFAULT_CONFIG: PluginConfig = {
  autoInjectContext: false,
  saveInterval: 15,
  toasts: true,
}

/** Smallest accepted saveInterval; anything below (or invalid) → default. */
export const SAVE_INTERVAL_FLOOR = 5

/**
 * Parse raw plugin-config.json text into a PluginConfig. `null` stands for
 * "no file" and yields all defaults. Total function: never throws.
 */
export function parsePluginConfig(raw: string | null): PluginConfig {
  if (raw === null) return { ...DEFAULT_CONFIG }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_CONFIG }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULT_CONFIG }
  }

  const obj = parsed as Record<string, unknown>
  const autoInjectContext =
    typeof obj.autoInjectContext === "boolean" ? obj.autoInjectContext : DEFAULT_CONFIG.autoInjectContext
  const toasts = typeof obj.toasts === "boolean" ? obj.toasts : DEFAULT_CONFIG.toasts
  const rawInterval = obj.saveInterval
  const saveInterval =
    typeof rawInterval === "number" && rawInterval >= SAVE_INTERVAL_FLOOR
      ? rawInterval
      : DEFAULT_CONFIG.saveInterval

  return { autoInjectContext, saveInterval, toasts }
}

/**
 * Read `paths.pluginConfig` and parse it. Missing, unreadable, or corrupted
 * files yield the defaults. Never throws.
 */
export function readConfig(paths: Paths): PluginConfig {
  try {
    return parsePluginConfig(readFileSync(paths.pluginConfig, "utf8"))
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/**
 * Read `paths.identityFile` verbatim (no trimming — consumers decide how to
 * present it). Missing or unreadable file yields "". Never throws.
 */
export function readIdentity(paths: Paths): string {
  try {
    return readFileSync(paths.identityFile, "utf8")
  } catch {
    return ""
  }
}

// ---------------------------------------------------------------------------
// Plugin package metadata (startup toast)
// ---------------------------------------------------------------------------

/** Fallbacks when the repo's package.json is unreadable or malformed. */
export const PACKAGE_NAME_FALLBACK = "opencode-mempalace"
export const PACKAGE_VERSION_FALLBACK = "unknown"

/** `package.json` fields the startup toast shows. */
export interface PackageInfo {
  name: string
  version: string
}

/**
 * Read `{ name, version }` from a package.json file. Total function: a
 * missing/unreadable file, malformed JSON, or wrong-typed/empty fields all
 * fall back per field (name → "opencode-mempalace", version → "unknown").
 * The toast is cosmetic, so this must never throw into the host process.
 */
export function readPackageInfo(file: string): PackageInfo {
  const fallback: PackageInfo = { name: PACKAGE_NAME_FALLBACK, version: PACKAGE_VERSION_FALLBACK }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fallback
    const obj = parsed as Record<string, unknown>
    return {
      name: typeof obj.name === "string" && obj.name !== "" ? obj.name : fallback.name,
      version: typeof obj.version === "string" && obj.version !== "" ? obj.version : fallback.version,
    }
  } catch {
    return fallback
  }
}
