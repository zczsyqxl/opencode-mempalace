import { Rpc } from "@opencode/plugin/rpc"

/** Payload carried by the `toast` RPC event; kept in lockstep with the schema below. */
export interface ToastPayload {
  readonly variant: "info" | "success" | "warning" | "error"
  readonly title: string
  readonly message: string
}

/**
 * Shared RPC bridge between the MemPalace server plugin (emits toast events)
 * and the TUI plugin (subscribes and shows toasts). Both processes import
 * this same definition, so the schema is the single source of truth.
 */
export const MemPalaceUI = Rpc.define({
  id: "mempalace-ui",
  methods: {},
  events: {
    toast: {
      schema: {
        type: "object",
        properties: {
          variant: { type: "string", enum: ["info", "success", "warning", "error"] },
          title: { type: "string" },
          message: { type: "string" },
        },
        required: ["variant", "title", "message"],
        additionalProperties: false,
      },
    },
  },
})
