import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { Plugin } from "@opencode/plugin/tui"
import { MemPalaceUI, type ToastPayload } from "./rpc"
import { buildPaths } from "./paths"
import { readConfig, readPackageInfo } from "./config"

/**
 * Thin TUI-side bridge: subscribe to MemPalaceUI toast events and show them.
 * All semantics live behind the shared RPC schema in `./rpc`; this plugin is
 * wiring only. JSON-Schema-typed events arrive as Record<string, unknown>, so
 * the payload is asserted once via the schema's mirrored ToastPayload type.
 *
 * On load it also shows its own "connected" toast (Option 1, 2026-09-30): the
 * server-side startup toast fires 15s after each location's plugin instance
 * loads and RPC events are live-only, so a TUI that connects later never sees
 * it. Showing the version here guarantees every TUI window gets exactly one
 * immediate confirmation that the toast bridge is alive. Respects
 * `toasts: false` from ~/.mempalace/plugin-config.json like the server side.
 */
export default Plugin.define({
  id: "mempalace.tui",
  setup(context) {
    const ui = context.client.rpc(MemPalaceUI)
    const off = ui.events.on("toast", (e) => {
      const data = e.data as unknown as ToastPayload
      context.ui.toast.show({ title: data.title, message: data.message, variant: data.variant, duration: 5000 })
    })

    try {
      const paths = buildPaths(join(homedir(), ".mempalace"))
      if (readConfig(paths).toasts) {
        const pkg = readPackageInfo(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"))
        context.ui.toast.show({
          title: "MemPalace",
          message: `${pkg.name} v${pkg.version} connected`,
          variant: "info",
          duration: 5000,
        })
      }
    } catch {
      // The connected toast is cosmetic — never break the TUI plugin over it.
    }

    return () => off()
  },
})
