import { describe, it, expect } from "vitest";
import { toStandardJsonSchema } from "../types";

/**
 * Unit tests for the schema normalizer that converts the agent
 * ToolRegistry's Gemini-native UPPERCASE type names into standard
 * (lowercase) JSON Schema, which the OpenAI-compatible and Anthropic
 * adapters require. The adapter tests cover the wire-level integration;
 * these lock the helper's edge cases.
 */
interface Schema {
  type?: string;
  description?: string;
  enum?: string[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
}

describe("toStandardJsonSchema", () => {
  it("lowercases every type recursively (properties + items)", () => {
    const out = toStandardJsonSchema({
      type: "OBJECT",
      properties: {
        name: { type: "STRING", description: "kept" },
        scores: { type: "ARRAY", items: { type: "NUMBER" } },
        flag: { type: "BOOLEAN" },
        count: { type: "INTEGER" },
      },
      required: ["name"],
    }) as Schema;
    expect(out.type).toBe("object");
    const props = out.properties as Record<string, Schema>;
    expect(props.name.type).toBe("string");
    expect(props.scores.type).toBe("array");
    expect(props.scores.items?.type).toBe("number");
    expect(props.flag.type).toBe("boolean");
    expect(props.count.type).toBe("integer");
    // Non-type keys are preserved verbatim.
    expect(out.required).toEqual(["name"]);
    expect(props.name.description).toBe("kept");
  });

  it("leaves already-lowercase (canonical) schemas unchanged", () => {
    const canonical = {
      type: "object",
      properties: { date: { type: "string", description: "d" } },
      required: ["date"],
    };
    expect(toStandardJsonSchema(canonical)).toEqual(canonical);
  });

  it("preserves enum and other constraint keys", () => {
    const out = toStandardJsonSchema({
      type: "OBJECT",
      properties: {
        mode: { type: "STRING", enum: ["fast", "slow"], description: "m" },
      },
    }) as Schema;
    const props = out.properties as Record<string, Schema>;
    expect(props.mode.type).toBe("string");
    expect(props.mode.enum).toEqual(["fast", "slow"]);
  });

  it("returns an empty object for non-object input", () => {
    // Defensive: a malformed declaration must not crash the request.
    expect(toStandardJsonSchema(null as unknown as Record<string, unknown>)).toEqual({});
    expect(
      toStandardJsonSchema([] as unknown as Record<string, unknown>),
    ).toEqual({});
  });
});
