import { basename, join, sep } from "node:path"
import { describe, expect, it } from "vitest"
import { buildPaths } from "../src/paths"

describe("buildPaths", () => {
  it("derives every V1 file location from baseDir with exact names", () => {
    const base = join("home", "user", ".mempalace")
    const p = buildPaths(base)

    expect(p.baseDir).toBe(base)
    expect(p.stateFile).toBe(join(base, "sync_state.json"))
    expect(p.pluginConfig).toBe(join(base, "plugin-config.json"))
    expect(p.identityFile).toBe(join(base, "identity.txt"))
    expect(p.hookStateDir).toBe(join(base, "hook_state"))
    expect(p.countersFile).toBe(join(p.hookStateDir, "opencode_counters.json"))
    expect(p.hookLog).toBe(join(p.hookStateDir, "hook.log"))
    expect(p.interactionsLog).toBe(join(p.hookStateDir, "interactions.log"))
    expect(p.sessionsRegistry).toBe(join(p.hookStateDir, "oc_sessions.json"))
    expect(p.syncDir).toBe(join(base, "oc-sessions"))
    expect(p.debugLog).toBe(join(p.hookStateDir, "debug.log"))
  })

  it("prefixes every path with baseDir (V1 layout, no stray locations)", () => {
    const base = join("x", ".mempalace")
    const p = buildPaths(base)
    const prefix = base + sep

    for (const path of [
      p.stateFile,
      p.pluginConfig,
      p.identityFile,
      p.hookStateDir,
      p.countersFile,
      p.hookLog,
      p.interactionsLog,
      p.sessionsRegistry,
      p.syncDir,
      p.debugLog,
    ]) {
      expect(path.startsWith(prefix)).toBe(true)
    }
  })

  it("uses the exact V1 file and directory names", () => {
    const p = buildPaths(join("any", "base"))

    expect(basename(p.stateFile)).toBe("sync_state.json")
    expect(basename(p.pluginConfig)).toBe("plugin-config.json")
    expect(basename(p.identityFile)).toBe("identity.txt")
    expect(basename(p.hookStateDir)).toBe("hook_state")
    expect(basename(p.countersFile)).toBe("opencode_counters.json")
    expect(basename(p.hookLog)).toBe("hook.log")
    expect(basename(p.interactionsLog)).toBe("interactions.log")
    expect(basename(p.sessionsRegistry)).toBe("oc_sessions.json")
    expect(basename(p.syncDir)).toBe("oc-sessions")
    // Windows fix: debug log lives under hook_state, never /tmp.
    expect(basename(p.debugLog)).toBe("debug.log")
    expect(p.debugLog.startsWith(p.hookStateDir + sep)).toBe(true)
  })

  it("keeps hook_state files grouped under hookStateDir", () => {
    const p = buildPaths(join("y", ".mempalace"))
    const prefix = p.hookStateDir + sep

    for (const path of [p.countersFile, p.hookLog, p.interactionsLog, p.sessionsRegistry, p.debugLog]) {
      expect(path.startsWith(prefix)).toBe(true)
    }
  })
})
