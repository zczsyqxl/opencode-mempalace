import { describe, expect, it } from "vitest"
import { MemPalaceUI } from "../src/rpc"

/** Shape of the JSON Schema subset the toast schema uses (keywords we validate). */
type PropertySchema = { type?: string; enum?: readonly unknown[] }
type ObjectSchema = {
  type: string
  properties: Record<string, PropertySchema>
  required: readonly string[]
  additionalProperties: boolean
}

/**
 * Minimal JSON Schema validator for exactly the keywords the toast schema
 * declares: object type, string properties, enum, required, and
 * additionalProperties:false. No external dependency.
 */
function validate(schema: ObjectSchema, payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return ["payload is not an object"]
  }
  const errors: string[] = []
  const obj = payload as Record<string, unknown>
  for (const key of schema.required) {
    if (!(key in obj)) errors.push(`missing required field "${key}"`)
  }
  for (const [key, value] of Object.entries(obj)) {
    const prop = schema.properties[key]
    if (prop === undefined) {
      if (schema.additionalProperties === false) errors.push(`unknown field "${key}"`)
      continue
    }
    if (prop.type === "string" && typeof value !== "string") {
      errors.push(`field "${key}" must be a string`)
      continue
    }
    if (prop.enum !== undefined && !prop.enum.includes(value)) {
      errors.push(`field "${key}" must be one of ${prop.enum.join(", ")}`)
    }
  }
  return errors
}

const schema = MemPalaceUI.events.toast.schema as unknown as ObjectSchema
const valid = { variant: "info", title: "t", message: "m" }

describe("MemPalaceUI toast event schema", () => {
  it("defines id mempalace-ui with a single toast event", () => {
    expect(MemPalaceUI.id).toBe("mempalace-ui")
    expect(Object.keys(MemPalaceUI.events)).toEqual(["toast"])
  })

  it.each(["info", "success", "warning", "error"])("accepts a valid %s payload", (variant) => {
    expect(validate(schema, { ...valid, variant })).toEqual([])
  })

  it("rejects a non-object payload", () => {
    expect(validate(schema, "not an object")).toEqual(["payload is not an object"])
  })

  it("rejects each missing required field", () => {
    for (const field of ["variant", "title", "message"]) {
      const { [field]: _omit, ...rest } = valid
      expect(validate(schema, rest)).toEqual([`missing required field "${field}"`])
    }
  })

  it("rejects an unknown extra field (additionalProperties: false)", () => {
    expect(validate(schema, { ...valid, extra: "x" })).toEqual(['unknown field "extra"'])
  })

  it("rejects an invalid variant", () => {
    expect(validate(schema, { ...valid, variant: "verbose" })).toEqual([
      'field "variant" must be one of info, success, warning, error',
    ])
  })

  it("rejects non-string title and message", () => {
    expect(validate(schema, { ...valid, title: 42 })).toEqual(['field "title" must be a string'])
    expect(validate(schema, { ...valid, message: null })).toEqual(['field "message" must be a string'])
  })
})
