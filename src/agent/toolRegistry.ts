/**
 * Tool registry for the Chronote AI agent.
 *
 * Gemini's function-calling protocol expects a `tools` array of
 * `functionDeclarations` and lets the model return a `functionCall`
 * which we then dispatch by name. This module isolates that wiring so
 * the rest of the agent doesn't have to know about Gemini specifics.
 *
 * The registry is intentionally tiny: a name → execute() map plus a
 * declarations() helper that returns the JSON schema the model sees.
 * No retries, no rate limiting, no per-tool policy — those live in
 * the tool implementations.
 */

import { requestUrl } from "obsidian";

/**
 * Parameter schema for a single tool argument. Mirrors the subset of
 * the Gemini `Schema` object we actually use (OBJECT, STRING, INTEGER,
 * BOOLEAN, ARRAY of STRING). Kept loose on purpose so the same shape
 * compiles for any future LLM provider — the conversion to OpenAI /
 * Anthropic / Ollama tool formats will be a thin adapter.
 */
export interface ToolParameterSchema {
  type: "OBJECT" | "STRING" | "INTEGER" | "NUMBER" | "BOOLEAN" | "ARRAY";
  description: string;
  properties?: Record<string, ToolParameterSchema>;
  required?: string[];
  items?: ToolParameterSchema;
  enum?: string[];
}

/** What the model sees when we declare a tool. */
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

/** What the model returns when it wants to call a tool. */
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Runtime context passed to every tool. Tools that need the calendar,
 * the vault, or a progress callback read it from here. The plugin
 * instance is included so future tools (e.g. flashcard save) can
 * reach `app.vault`, `app.workspace`, etc. without us inventing a
 * purpose-built accessor for every dependency.
 */
export interface ToolContext {
  plugin: unknown; // typed as `unknown` here to avoid an import cycle
  // (the agent layer imports Obsidian types only at the leaves)
}

/** A registered tool: schema + executor. */
export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

/**
 * Lightweight argument validator. Checks required fields and basic
 * JSON-Schema types so a model that sends malformed arguments gets a
 * clear error back and can self-correct on the next round.
 */
function validateArgs(
  schema: ToolParameterSchema,
  args: Record<string, unknown>,
): string | null {
  if (schema.type !== "OBJECT" || !schema.properties) {
    return null;
  }

  const required = schema.required ?? [];
  for (const key of required) {
    if (!(key in args) || args[key] === undefined || args[key] === null) {
      return `Missing required argument: ${key}`;
    }
  }

  for (const [key, propSchema] of Object.entries(schema.properties)) {
    if (!(key in args)) continue;
    const value = args[key];
    const err = validateValue(propSchema, value, key);
    if (err) return err;
  }

  return null;
}

function validateValue(
  schema: ToolParameterSchema,
  value: unknown,
  path: string,
): string | null {
  switch (schema.type) {
    case "STRING":
      if (typeof value !== "string") {
        return `${path} must be a string`;
      }
      if (schema.enum && !schema.enum.includes(value)) {
        return `${path} must be one of: ${schema.enum.join(", ")}`;
      }
      return null;
    case "INTEGER":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return `${path} must be an integer`;
      }
      return null;
    case "NUMBER":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return `${path} must be a number`;
      }
      return null;
    case "BOOLEAN":
      if (typeof value !== "boolean") {
        return `${path} must be a boolean`;
      }
      return null;
    case "ARRAY":
      if (!Array.isArray(value)) {
        return `${path} must be an array`;
      }
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          const err = validateValue(schema.items, value[i], `${path}[${i}]`);
          if (err) return err;
        }
      }
      return null;
    case "OBJECT":
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return `${path} must be an object`;
      }
      if (schema.properties) {
        const obj = value as Record<string, unknown>;
        const required = schema.required ?? [];
        for (const key of required) {
          if (!(key in obj) || obj[key] === undefined || obj[key] === null) {
            return `${path}.${key} is required`;
          }
        }
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          if (!(key in obj)) continue;
          const err = validateValue(propSchema, obj[key], `${path}.${key}`);
          if (err) return err;
        }
      }
      return null;
    default:
      return null;
  }
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }


  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Returns the Gemini-shaped `tools` body field. An empty registry
   * yields `[]` so the caller can decide whether to include it at all.
   */
  declarations(): Array<{ functionDeclarations: ToolDeclaration[] }> | null {
    if (this.tools.size === 0) return null;
    return [
      {
        functionDeclarations: Array.from(this.tools.values()).map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
  }

  /**
   * Dispatches a model-requested function call. Returns the string the
   * model should see as the function response. On an unknown tool we
   * return a clear error string instead of throwing — Gemini expects
   * a functionResponse on every round, and throwing would force the
   * caller to invent an error path. Throwing is reserved for the
   * executor itself (network failures, etc.).
   */
  async execute(call: ToolCall, ctx: ToolContext): Promise<string> {
    // Gemini may namespace tool names as `default_api:tool_name`. Strip
    // that prefix when dispatching to our locally-registered tools.
    const dispatchName = call.name.replace(/^default_api:/, "");
    const tool = this.tools.get(dispatchName);
    if (!tool) {
      const known = Array.from(this.tools.keys()).join(", ");
      return `Error: Unknown function "${call.name}". Available functions: ${known || "(none registered)"}.`;
    }
    const validationError = validateArgs(tool.parameters, call.args);
    if (validationError) {
      return `Error calling ${call.name}: ${validationError}. Please fix the arguments and try again.`;
    }
    try {
      return await tool.execute(call.args, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error executing ${call.name}: ${msg}`;
    }

  }
}

/**
 * Re-export `requestUrl` so tool implementations don't have to import
 * from `obsidian` directly — keeps the dependency graph tidy and lets
 * us swap in a mock at test time.
 */
export { requestUrl };
