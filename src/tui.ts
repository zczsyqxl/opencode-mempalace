import { Plugin } from "@opencode/plugin/tui"
import { MemPalaceUI, type ToastPayload } from "./rpc"

/**
 * Thin TUI-side bridge: subscribe to MemPalaceUI toast events and show them.
 * All semantics live behind the shared RPC schema in `./rpc`; this plugin is
 * wiring only. JSON-Schema-typed events arrive as Record<string, unknown>, so
 * the payload is asserted once via the schema's mirrored ToastPayload type.
 */
export default Plugin.define({
  id: "mempalace.tui",
  setup(context) {
    const ui = context.client.rpc(MemPalaceUI)
    const off = ui.events.on("toast", (e) => {
      const data = e.data as unknown as ToastPayload
      context.ui.toast.show({ title: data.title, message: data.message, variant: data.variant, duration: 5000 })
    })
    return () => off()
  },
})
