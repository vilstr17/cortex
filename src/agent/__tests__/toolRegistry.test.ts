import { describe, it, expect, vi } from "vitest";
import { ToolRegistry, Tool } from "../toolRegistry";

/**
 * Tests for the ToolRegistry.
 *
 * The registry is the dispatch table that the rest of the agent
 * layer talks to. We test the surface that matters:
 *   - declarations() returns the right shape
 *   - register() de-dupes (last writer wins, with a warning)
 *   - execute() dispatches by name
 *   - execute() returns a clear error string on unknown tools
 *   - execute() catches and stringifies thrown errors
 */

function makeTool(name: string, exec: Tool["execute"]): Tool {
  return {
    name,
    description: `desc for ${name}`,
    parameters: {
      type: "OBJECT",
      description: "params",
      properties: {
        x: { type: "STRING", description: "x arg" },
      },
      required: ["x"],
    },
    execute: exec,
  };
}

describe("ToolRegistry", () => {
  it("declarations() returns null for an empty registry", () => {
    const r = new ToolRegistry();
    expect(r.declarations()).toBeNull();
  });

  it("declarations() wraps registered tools in the Gemini shape", () => {
    const r = new ToolRegistry();
    r.register(makeTool("foo", async () => "ok"));
    const decls = r.declarations();
    expect(decls).not.toBeNull();
    expect(decls!.length).toBe(1);
    expect(decls![0].functionDeclarations.length).toBe(1);
    expect(decls![0].functionDeclarations[0].name).toBe("foo");
  });

  it("execute() dispatches by name and forwards args + ctx", async () => {
    const r = new ToolRegistry();
    const spy = vi.fn(async (args: Record<string, unknown>) => {
      return `got x=${args.x}`;
    });
    r.register(makeTool("echo", spy));
    const out = await r.execute({ name: "echo", args: { x: "hi" } }, { plugin: null });
    expect(out).toBe("got x=hi");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("execute() returns a clear error for an unknown tool", async () => {
    const r = new ToolRegistry();
    r.register(makeTool("known", async () => "ok"));
    const out = await r.execute({ name: "ghost", args: {} }, { plugin: null });
    expect(out).toMatch(/Unknown function "ghost"/);
    expect(out).toContain("known");
  });

  it("execute() catches thrown errors and returns a string", async () => {
    const r = new ToolRegistry();
    r.register(makeTool("boom", async () => {
      throw new Error("kaboom");
    }));
    const out = await r.execute({ name: "boom", args: { x: "x" } }, { plugin: null });
    expect(out).toMatch(/Error executing boom: kaboom/);
  });

  it("execute() returns a validation error for missing required args", async () => {
    const r = new ToolRegistry();
    r.register(makeTool("echo", async () => "ok"));
    const out = await r.execute({ name: "echo", args: {} }, { plugin: null });
    expect(out).toMatch(/Error calling echo: Missing required argument: x/);
  });

  it("register() with a duplicate name overwrites (with a warning)", async () => {
    const r = new ToolRegistry();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    r.register(makeTool("dup", async () => "first"));
    r.register(makeTool("dup", async () => "second"));
    expect(warn).toHaveBeenCalled();
    const out = await r.execute({ name: "dup", args: { x: "x" } }, { plugin: null });
    expect(out).toBe("second");
    warn.mockRestore();
  });

  it("has() reports membership", () => {
    const r = new ToolRegistry();
    r.register(makeTool("a", async () => "x"));
    expect(r.has("a")).toBe(true);
    expect(r.has("b")).toBe(false);
  });
});
