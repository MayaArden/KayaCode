import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { NOOP_TELEMETRY_CONTEXT } from "@earendil-works/pi-telemetry";
import { KayaServerService, JsonSessionStore } from "@kaya/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExtensionHost } from "@kaya/extensions";
import { McpLoader, mcpToolName } from "../src/loader.js";

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kaya-mcp-"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const FS_SERVER_ENTRY = path.resolve("node_modules/@modelcontextprotocol/server-filesystem/dist/index.js");

function makeHost() {
  return new ExtensionHost({
    cwd: tmp,
    signal: new AbortController().signal,
    isIdle: () => true,
    getModel: () => ({ provider: "test", id: "m" }),
    getThinkingLevel: () => "off",
    setThinkingLevel: () => {},
    steer: () => {},
    followUp: () => {},
    prompt: () => Promise.resolve(),
    appendAssistantNote: () => {},
    listTools: () => [],
  });
}

describe("McpLoader", () => {
  it("connects to a real stdio MCP server (server-filesystem) and registers working tools", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kaya-mcp-cwd-"));
    fs.mkdirSync(path.join(cwd, ".kaya"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".kaya", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          fs: { command: process.execPath, args: [FS_SERVER_ENTRY, tmp] },
        },
      }),
    );
    const host = makeHost();
    const loader = new McpLoader({ cwd, configDir: path.join(tmp, "no-global-here") });
    const result = await loader.loadInto(host);

    expect(result.errors).toEqual([]);
    expect(result.connected).toHaveLength(1);
    expect(result.connected[0]!.transport).toBe("stdio");
    const names = result.connected[0]!.toolNames;
    expect(names).toContain(mcpToolName("fs", "read_file"));
    expect(names).toContain(mcpToolName("fs", "write_file"));

    // Execute a real call through the registered AgentTool (not a mock):
    const tools = host.getTools();
    const writeFile = tools.find((t) => t.name === mcpToolName("fs", "write_file"))!;
    const target = path.join(tmp, "via-mcp.txt");
    const writeResult = await writeFile.execute("call-1", {
      path: target,
      content: "hello over mcp",
    } as never, undefined, undefined);
    expect(writeResult.content[0]!.type).toBe("text");
    expect(fs.readFileSync(target, "utf8")).toBe("hello over mcp");

    const readFile = tools.find((t) => t.name === mcpToolName("fs", "read_file"))!;
    const readResult = await readFile.execute("call-2", { path: target } as never, undefined, undefined);
    expect(readResult.content.map((c) => (c.type === "text" ? c.text : "")).join("")).toContain("hello over mcp");

    await loader.close();
  }, 30_000);

  it("skips broken/unreachable servers without failing the load", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kaya-mcp-bad-"));
    fs.mkdirSync(path.join(cwd, ".kaya"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".kaya", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          nonexistent: { command: "definitely-not-a-real-command-kaya", args: [] },
          unreachable: { url: "http://127.0.0.1:1/mcp" },
          fs: { command: process.execPath, args: [FS_SERVER_ENTRY, tmp] },
        },
      }),
    );
    const host = makeHost();
    const loader = new McpLoader({ cwd, connectTimeoutMs: 3000 });
    const result = await loader.loadInto(host);

    expect(result.errors.map((e) => e.name).sort()).toEqual(["nonexistent", "unreachable"]);
    expect(result.connected.map((c) => c.name)).toEqual(["fs"]);
    expect(host.getTools().length).toBeGreaterThan(0);
    await loader.close();
  }, 30_000);

  it("connects to a real streamable-HTTP MCP server (SDK McpServer over HTTP)", async () => {
    const { createRealHttpMcpServer } = await import("./http-server-fixture.js");
    const fixture = await createRealHttpMcpServer();

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kaya-mcp-http-"));
    fs.mkdirSync(path.join(cwd, ".kaya"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".kaya", "mcp.json"),
      JSON.stringify({ mcpServers: { httpdemo: { url: fixture.url, transport: "http" } } }),
    );
    const host = makeHost();
    const loader = new McpLoader({ cwd });
    const result = await loader.loadInto(host);

    expect(result.errors).toEqual([]);
    expect(result.connected[0]!.transport).toBe("http");
    const echo = host.getTools().find((t) => t.name === mcpToolName("httpdemo", "echo"))!;
    expect(echo).toBeDefined();
    const out = await echo.execute("call-1", { text: "ping over http" } as never, undefined, undefined);
    expect(out.content.map((c) => (c.type === "text" ? c.text : "")).join("")).toContain("ping over http");

    await loader.close();
    await fixture.close();
  }, 30_000);
});

describe("MCP through the kaya server stack", () => {
  it("faux model calls an MCP tool; result lands in the session transcript", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kaya-mcp-stack-"));
    fs.mkdirSync(path.join(cwd, ".kaya"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "target.txt"), "mcp stack content");
    fs.writeFileSync(
      path.join(cwd, ".kaya", "mcp.json"),
      JSON.stringify({ mcpServers: { fs: { command: process.execPath, args: [FS_SERVER_ENTRY, cwd] } } }),
    );

    const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 1_000_000 }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const service = new KayaServerService({
      models,
      store: new JsonSessionStore(path.join(tmp, "store-mcp")),
      telemetry: NOOP_TELEMETRY_CONTEXT,
      config: { cwd, configDir: tmp, watchExtensions: false, mcp: true },
      defaultModel: faux.getModel() as never,
      defaultModelRef: { provider: "faux", id: "faux-1" },
    });

    const runtime = await service.createSession({ id: "mcp-stack-1", cwd });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(mcpToolName("fs", "read_file"), { path: path.join(cwd, "target.txt") }, { id: "mcp-call-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done reading via mcp"),
    ]);
    await runtime.prompt({ text: "read the file" });

    const snapshot = await runtime.snapshot();
    const toolItems = snapshot.transcript.filter((i) => i.role === "tool");
    expect(toolItems).toHaveLength(1);
    expect(toolItems[0]!.toolName).toBe(mcpToolName("fs", "read_file"));
    expect(toolItems[0]!.status).toBe("complete");
    expect(
      toolItems[0]!.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join(""),
    ).toContain("mcp stack content");
    await runtime.dispose();
  }, 30_000);
});
