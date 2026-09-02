import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { PiClient } from "@earendil-works/pi-client";
import { PiServer } from "@earendil-works/pi-server";
import { NOOP_TELEMETRY_CONTEXT } from "@earendil-works/pi-telemetry";
import { KayaServerService, JsonSessionStore, createLocalEndpoint } from "@kaya/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChatBridge, type TelegramSink } from "../src/bridge.js";
import { ChatSessions } from "../src/sessions.js";
import { chunkText, toolSummaryLine } from "../src/format.js";

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kaya-tg-client-"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Recording Telegram edge: what a grammy adapter would do for real. */
function makeSink() {
  const sent: { chatId: number; html: string }[] = [];
  const edits: { chatId: number; messageId: number; html: string }[] = [];
  let nextId = 1;
  const sink: TelegramSink = {
    send: (chatId, html) => {
      sent.push({ chatId, html });
      return Promise.resolve(nextId++);
    },
    edit: (chatId, messageId, html) => {
      edits.push({ chatId, messageId, html });
      return Promise.resolve();
    },
  };
  return { sink, sent, edits };
}

describe("format", () => {
  it("condenses tool items into a one-line summary", () => {
    const line = toolSummaryLine({
      id: "t1",
      role: "tool",
      toolCallId: "c1",
      toolName: "bash",
      input: { command: "npm test" },
      content: [{ type: "text", text: "line one\nline two" }],
      timestamp: 0,
      status: "complete",
      isError: false,
    });
    expect(line).toContain("✓");
    expect(line).toContain("<code>bash npm test</code>");
    expect(line).toContain("/output");
  });

  it("chunks long text on line boundaries within the limit", () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    for (const chunk of chunkText(long, 4000)) expect(chunk.length).toBeLessThanOrEqual(4000);
    expect(chunkText(long).join("")).toContain("line 499");
  });
});

describe("ChatBridge over the real kaya wire", () => {
  it("streams an answer in place and sends condensed tool summaries; /output shows full output", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 1_000_000 }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const service = new KayaServerService({
      models,
      store: new JsonSessionStore(path.join(tmp, "store-tgc")),
      telemetry: NOOP_TELEMETRY_CONTEXT,
      config: { cwd: tmp, configDir: tmp, watchExtensions: false, mcp: false },
      defaultModel: faux.getModel() as never,
      defaultModelRef: { provider: "faux", id: "faux-1" },
    });
    const endpoint = createLocalEndpoint();
    const server = new PiServer(service, { listeners: [endpoint.listener] });
    await server.start();
    const client = await PiClient.connect({ transportFactory: endpoint.transportFactory });

    const chatId = 12345;
    const { sink, sent, edits } = makeSink();
    const sessions = new ChatSessions(client, tmp, tmp);
    const bridge = new ChatBridge(chatId, sink);
    bridge.attach(await sessions.ensure(chatId));

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo bridge-test" }, { id: "tc-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("the bridge answer"),
    ]);
    await bridge.submit("run echo");
    await new Promise((r) => setTimeout(r, 1200)); // let the stream flush

    // The answer was edited in place: one placeholder message, edits point at it.
    expect(sent.length).toBeGreaterThanOrEqual(2); // placeholder + tool summary (+ maybe thinking)
    const answerEdit = edits.at(-1);
    expect(answerEdit).toBeDefined();
    expect(answerEdit!.html).toContain("the bridge answer");

    const toolSummary = sent.find((m) => m.html.includes("bash"));
    expect(toolSummary).toBeDefined();
    expect(toolSummary!.html).toContain("✓");
    expect(toolSummary!.html).toContain("echo bridge-test");

    expect(bridge.toolOutputCount).toBe(1);
    await bridge.showOutput();
    const full = sent.at(-1)!;
    expect(full.html).toContain("<pre>");
    expect(full.html).toContain("bridge-test");

    // Per-chat session isolation: a second chat gets a different session id.
    const other = await sessions.ensure(999);
    const first = await sessions.ensure(chatId);
    expect(other.id).not.toBe(first.id);
    // Reattach returns the same session.
    expect((await sessions.ensure(chatId)).id).toBe(first.id);

    await client.dispose();
    await server.close();
  }, 15_000);
});
