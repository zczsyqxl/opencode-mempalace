import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { buildPaths, type Paths } from "../src/paths"
import { parsePluginConfig, readConfig, readIdentity, readPackageInfo } from "../src/config"

/** Fresh temp dir per test; never touch the real ~/.mempalace. */
let tmp = ""
afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true })
    tmp = ""
  }
})

/** New Paths rooted at <tmp>/base, with baseDir created so tests can write files into it. */
const freshPaths = (): Paths => {
  tmp = mkdtempSync(join(tmpdir(), "mp-config-"))
  const base = join(tmp, "base")
  mkdirSync(base, { recursive: true })
  return buildPaths(base)
}

const DEFAULTS = { autoInjectContext: false, saveInterval: 15, toasts: true }

describe("parsePluginConfig", () => {
  it("returns V1 defaults for null (missing file)", () => {
    expect(parsePluginConfig(null)).toEqual(DEFAULTS)
  })

  it("returns defaults for malformed JSON, never throws", () => {
    for (const raw of ["{ not json", "", "{\"saveInterval\":", "<<<"]) {
      expect(parsePluginConfig(raw)).toEqual(DEFAULTS)
    }
  })

  it("returns defaults when the JSON is not a config object", () => {
    for (const raw of ["null", "42", "\"hello\"", "[1,2]", "true"]) {
      expect(parsePluginConfig(raw)).toEqual(DEFAULTS)
    }
  })

  it("falls back per field on wrong types (saveInterval: \"x\", strings, numbers)", () => {
    expect(parsePluginConfig(JSON.stringify({ saveInterval: "x" }))).toEqual(DEFAULTS)
    expect(parsePluginConfig(JSON.stringify({ autoInjectContext: "yes" }))).toEqual(DEFAULTS)
    expect(parsePluginConfig(JSON.stringify({ autoInjectContext: 1 }))).toEqual(DEFAULTS)
    expect(parsePluginConfig(JSON.stringify({ toasts: 0 }))).toEqual(DEFAULTS)
    expect(parsePluginConfig(JSON.stringify({ toasts: "false" }))).toEqual(DEFAULTS)
    expect(parsePluginConfig(JSON.stringify({ saveInterval: true }))).toEqual(DEFAULTS)
  })

  it("saveInterval below the floor of 5 falls back to 15; 5 itself is valid", () => {
    expect(parsePluginConfig(JSON.stringify({ saveInterval: 3 })).saveInterval).toBe(15)
    expect(parsePluginConfig(JSON.stringify({ saveInterval: 0 })).saveInterval).toBe(15)
    expect(parsePluginConfig(JSON.stringify({ saveInterval: -10 })).saveInterval).toBe(15)
    expect(parsePluginConfig(JSON.stringify({ saveInterval: 5 })).saveInterval).toBe(5)
  })

  it("passes valid values through untouched", () => {
    const raw = JSON.stringify({ autoInjectContext: true, saveInterval: 30, toasts: false })
    expect(parsePluginConfig(raw)).toEqual({ autoInjectContext: true, saveInterval: 30, toasts: false })
  })

  it("keeps defaults for absent keys and ignores unknown keys", () => {
    expect(parsePluginConfig(JSON.stringify({ saveInterval: 7 }))).toEqual({
      autoInjectContext: false,
      saveInterval: 7,
      toasts: true,
    })
    expect(
      parsePluginConfig(JSON.stringify({ evil: "payload", autoInjectContext: true })),
    ).toEqual({ autoInjectContext: true, saveInterval: 15, toasts: true })
  })
})

describe("readConfig", () => {
  it("returns defaults when plugin-config.json is missing", () => {
    const paths = freshPaths()
    expect(existsSync(paths.pluginConfig)).toBe(false)
    expect(readConfig(paths)).toEqual(DEFAULTS)
  })

  it("reads and parses an existing plugin-config.json", () => {
    const paths = freshPaths()
    writeFileSync(
      paths.pluginConfig,
      JSON.stringify({ autoInjectContext: true, saveInterval: 10, toasts: false }),
      "utf8",
    )
    expect(readConfig(paths)).toEqual({ autoInjectContext: true, saveInterval: 10, toasts: false })
  })

  it("returns defaults for a corrupted file, never throws", () => {
    const paths = freshPaths()
    writeFileSync(paths.pluginConfig, "{ broken", "utf8")
    expect(readConfig(paths)).toEqual(DEFAULTS)
  })

  it("never throws when the file location is unreadable", () => {
    tmp = mkdtempSync(join(tmpdir(), "mp-config-"))
    // A regular file as baseDir: reads under it fail (ENOTDIR), which stands
    // in for a permission error on Windows.
    const blocker = join(tmp, "blocker")
    writeFileSync(blocker, "not a directory", "utf8")
    expect(() => readConfig(buildPaths(blocker))).not.toThrow()
    expect(readConfig(buildPaths(blocker))).toEqual(DEFAULTS)
  })
})

describe("readIdentity", () => {
  it("returns \"\" when identity.txt is missing", () => {
    const paths = freshPaths()
    expect(existsSync(paths.identityFile)).toBe(false)
    expect(readIdentity(paths)).toBe("")
  })

  it("returns the file content verbatim when present", () => {
    const paths = freshPaths()
    writeFileSync(paths.identityFile, "You are MemPalace, the shared brain.\nLine two.", "utf8")
    expect(readIdentity(paths)).toBe("You are MemPalace, the shared brain.\nLine two.")
  })

  it("returns \"\" when the file location is unreadable, never throws", () => {
    tmp = mkdtempSync(join(tmpdir(), "mp-config-"))
    const blocker = join(tmp, "blocker")
    writeFileSync(blocker, "not a directory", "utf8")
    expect(() => readIdentity(buildPaths(blocker))).not.toThrow()
    expect(readIdentity(buildPaths(blocker))).toBe("")
  })
})

describe("readPackageInfo", () => {
  it("reads name and version from a package.json", () => {
    tmp = mkdtempSync(join(tmpdir(), "mp-config-"))
    const file = join(tmp, "package.json")
    writeFileSync(file, JSON.stringify({ name: "opencode-mempalace", version: "1.2.3" }), "utf8")
    expect(readPackageInfo(file)).toEqual({ name: "opencode-mempalace", version: "1.2.3" })
  })

  it("falls back per field when values are wrong-typed or empty strings", () => {
    tmp = mkdtempSync(join(tmpdir(), "mp-config-"))
    const file = join(tmp, "package.json")
    writeFileSync(file, JSON.stringify({ name: 42, version: "" }), "utf8")
    expect(readPackageInfo(file)).toEqual({ name: "opencode-mempalace", version: "unknown" })
    writeFileSync(file, JSON.stringify({ name: "" }), "utf8")
    expect(readPackageInfo(file)).toEqual({ name: "opencode-mempalace", version: "unknown" })
  })

  it("falls back for malformed JSON, non-object JSON, and missing files, never throwing", () => {
    tmp = mkdtempSync(join(tmpdir(), "mp-config-"))
    const file = join(tmp, "package.json")
    writeFileSync(file, "{ broken", "utf8")
    expect(readPackageInfo(file)).toEqual({ name: "opencode-mempalace", version: "unknown" })
    writeFileSync(file, "[1,2]", "utf8")
    expect(readPackageInfo(file)).toEqual({ name: "opencode-mempalace", version: "unknown" })
    expect(readPackageInfo(join(tmp, "no-such-package.json"))).toEqual({
      name: "opencode-mempalace",
      version: "unknown",
    })
  })
})
