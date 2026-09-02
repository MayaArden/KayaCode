import { describe, expect, it } from "vitest";
import { ExtensionHost } from "../src/host.js";
import type { KayaSessionFacade } from "../src/types.js";

function makeFacade(): KayaSessionFacade {
  const controller = new AbortController();
  return {
    cwd: "/tmp/test",
    signal: controller.signal,
    isIdle: () => true,
    getModel: () => ({ provider: "test", id: "test-model" }),
    getThinkingLevel: () => "off",
    setThinkingLevel: () => {},
    steer: () => {},
    followUp: () => {},
    prompt: () => Promise.resolve(),
    appendAssistantNote: () => {},
    listTools: () => [],
  };
}

const SRC_A = { path: "/ext/a.ts", kind: "file" as const };
const SRC_B = { path: "/ext/b.ts", kind: "file" as const };

describe("ExtensionHost", () => {
  it("runs passive handlers sequentially in load order", async () => {
    const host = new ExtensionHost(makeFacade());
    const order: string[] = [];
    await host.loadFactory((kaya) => {
      kaya.on("turn_start", async (_e, _ctx) => {
        order.push("a");
      });
    }, SRC_A);
    await host.loadFactory((kaya) => {
      kaya.on("turn_start", () => {
        order.push("b");
      });
    }, SRC_B);
    await host.emit("turn_start", { type: "turn_start" });
    expect(order).toEqual(["a", "b"]);
  });

  it("isolates handler errors and routes them to onError", async () => {
    const errors: string[] = [];
    const host = new ExtensionHost(makeFacade(), {
      onError: (e) => errors.push(`${e.source.path}:${e.error.message}`),
    });
    let secondRan = false;
    await host.loadFactory((kaya) => {
      kaya.on("agent_start", () => {
        throw new Error("boom");
      });
    }, SRC_A);
    await host.loadFactory((kaya) => {
      kaya.on("agent_start", () => {
        secondRan = true;
      });
    }, SRC_B);
    await host.emit("agent_start", { type: "agent_start" });
    expect(secondRan).toBe(true);
    expect(errors).toEqual(["/ext/a.ts:boom"]);
  });

  it("discards staged registrations when a factory throws", async () => {
    const host = new ExtensionHost(makeFacade(), { onError: () => {} });
    await host.loadFactory((kaya) => {
      kaya.on("agent_start", () => {});
      throw new Error("load failed");
    }, SRC_A);
    expect(host.hasHandlers("agent_start")).toBe(false);
  });

  it("tool_call: first block short-circuits; input mutations are visible to later handlers", async () => {
    const host = new ExtensionHost(makeFacade());
    await host.loadFactory((kaya) => {
      kaya.on("tool_call", (e) => {
        (e.input as { path: string }).path = "/mutated";
      });
    }, SRC_A);
    await host.loadFactory((kaya) => {
      kaya.on("tool_call", (e) => {
        if ((e.input as { path: string }).path === "/mutated") return { block: true, reason: "nope" };
        return undefined;
      });
    }, SRC_B);
    const input = { path: "/original" };
    const result = await host.emitToolCall({ type: "tool_call", toolCallId: "1", toolName: "read", input });
    expect(result).toEqual({ block: true, reason: "nope" });
    expect(input.path).toBe("/mutated");
  });

  it("tool_result: field replacements chain across handlers", async () => {
    const host = new ExtensionHost(makeFacade());
    await host.loadFactory((kaya) => {
      kaya.on("tool_result", () => ({ isError: true }));
    }, SRC_A);
    await host.loadFactory((kaya) => {
      kaya.on("tool_result", (e) => ({ content: [...e.content, { type: "text" as const, text: "extra" }] }));
    }, SRC_B);
    const merged = await host.emitToolResult({
      type: "tool_result",
      toolCallId: "1",
      toolName: "bash",
      content: [{ type: "text", text: "base" }],
      details: undefined,
      isError: false,
    });
    expect(merged?.isError).toBe(true);
    expect(merged?.content).toHaveLength(2);
  });

  it("before_provider_request chains payload replacements", async () => {
    const host = new ExtensionHost(makeFacade());
    await host.loadFactory((kaya) => {
      kaya.on("before_provider_request", (e) => ({ ...(e.payload as object), a: 1 }));
    }, SRC_A);
    await host.loadFactory((kaya) => {
      kaya.on("before_provider_request", (e) => ({ ...(e.payload as object), b: 2 }));
    }, SRC_B);
    const out = await host.emitBeforeProviderRequest({
      type: "before_provider_request",
      provider: "anthropic",
      model: "m",
      payload: {},
    });
    expect(out).toEqual({ a: 1, b: 2 });
  });

  it("before_compact: first cancel short-circuits", async () => {
    const host = new ExtensionHost(makeFacade());
    let bRan = false;
    await host.loadFactory((kaya) => {
      kaya.on("before_compact", () => ({ cancel: true }));
    }, SRC_A);
    await host.loadFactory((kaya) => {
      kaya.on("before_compact", () => {
        bRan = true;
      });
    }, SRC_B);
    const result = await host.emitBeforeCompact({
      type: "before_compact",
      reason: "manual",
      messageCount: 10,
      estimatedTokens: 1000,
    });
    expect(result).toEqual({ cancel: true });
    expect(bRan).toBe(false);
  });

  it("keeps first registration on duplicate tool/command names", async () => {
    const host = new ExtensionHost(makeFacade(), { onError: () => {} });
    const mkTool = (label: string) => ({
      name: "t",
      label,
      description: "",
      parameters: {},
      execute: () => Promise.resolve({ content: [], details: undefined }),
    });
    await host.loadFactory((kaya) => {
      kaya.registerTool(mkTool("from-a") as never);
      kaya.registerCommand("c", { handler: () => {} });
    }, SRC_A);
    await host.loadFactory((kaya) => {
      kaya.registerTool(mkTool("from-b") as never);
      kaya.registerCommand("c", { handler: () => {} });
    }, SRC_B);
    expect(host.getTools()).toHaveLength(1);
    expect((host.getTools()[0] as { label: string }).label).toBe("from-a");
    expect(host.getCommands()).toHaveLength(1);
    expect(host.getCommand("c")?.source.path).toBe("/ext/a.ts");
  });

  it("invalidate() poisons contexts handed out earlier", async () => {
    const host = new ExtensionHost(makeFacade());
    let captured: { cwd: string } | undefined;
    await host.loadFactory((kaya) => {
      kaya.on("agent_start", (_e, ctx) => {
        captured = ctx;
      });
    }, SRC_A);
    await host.emit("agent_start", { type: "agent_start" });
    expect(captured!.cwd).toBe("/tmp/test");
    host.invalidate();
    expect(() => captured!.cwd).toThrow();
  });

  it("runCommand returns false for unknown commands and isolates handler errors", async () => {
    const errors: string[] = [];
    const host = new ExtensionHost(makeFacade(), { onError: (e) => errors.push(e.error.message) });
    await host.loadFactory((kaya) => {
      kaya.registerCommand("ok", {
        handler: (args, ctx) => {
          ctx.appendAssistantNote(`args:${args}`);
        },
      });
      kaya.registerCommand("bad", {
        handler: () => {
          throw new Error("cmd boom");
        },
      });
    }, SRC_A);
    expect(await host.runCommand("missing", "")).toBe(false);
    expect(await host.runCommand("ok", "x y")).toBe(true);
    expect(await host.runCommand("bad", "")).toBe(true);
    expect(errors).toEqual(["cmd boom"]);
  });
});
