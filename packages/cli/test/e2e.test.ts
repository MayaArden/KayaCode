import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { PiClient } from "@earendil-works/pi-client";
import { PiServer } from "@earendil-works/pi-server";
import { NOOP_TELEMETRY_CONTEXT } from "@earendil-works/pi-telemetry";
import { visibleWidth } from "@earendil-works/pi-tui";
import { KayaServerService, JsonSessionStore, createLocalEndpoint } from "@kaya/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyProgress, applySnapshot, createTranscriptState, selectTranscript } from "../src/transcript.js";
import { createKayaUi } from "../src/ui/index.js";

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kaya-e2e-"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const EXAMPLE_EXTENSION = `import { Type } from "@kaya/extensions";
export default function (kaya) {
  kaya.on("session_start", (_event, ctx) => {
    ctx.appendAssistantNote("hello-extension active");
  });
  kaya.registerTool({
    name: "get_current_time",
    label: "Get current time",
    description: "Returns the current local time.",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "2030-01-01T00:00:00.000Z" }], details: undefined }),
  });
  kaya.registerCommand("hello", {
    description: "Greet someone",
    handler: (args, ctx) => ctx.appendAssistantNote("Hello, " + (args || "there") + "!"),
  });
}
`;

describe("end-to-end: extension through real wire into the pi-tui client", () => {
  it("extension tool + hook + command are all visible in rendered transcript", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kaya-e2e-ext-"));
    fs.mkdirSync(path.join(cwd, ".kaya", "extensions"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".kaya", "extensions", "hello.ts"), EXAMPLE_EXTENSION);

    const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 1_000_000 }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const service = new KayaServerService({
      models,
      store: new JsonSessionStore(path.join(tmp, "store")),
      telemetry: NOOP_TELEMETRY_CONTEXT,
      config: { cwd, configDir: tmp, watchExtensions: false },
      defaultModel: faux.getModel() as never,
      defaultModelRef: { provider: "faux", id: "faux-1" },
    });

    const endpoint = createLocalEndpoint();
    const server = new PiServer(service, { listeners: [endpoint.listener] });
    await server.start();
    const client = await PiClient.connect({ transportFactory: endpoint.transportFactory });

    // Drive exactly like the interactive app does: snapshots + progress into the reducer.
    let state = createTranscriptState();
    const session = await client.createSession({ cwd });
    session.subscribe((snapshot) => {
      state = applySnapshot(state, snapshot);
    });
    session.onEvent((event) => {
      if (event.type === "session_progress") state = applyProgress(state, event.progress);
    });
    if (session.snapshot) state = applySnapshot(state, session.snapshot);

    // 1. Hook: session_start note visible.
    let items = selectTranscript(state);
    expect(items.some((i) => i.role === "assistant" && i.content.some((c) => c.type === "text" && c.text.includes("hello-extension active")))).toBe(true);

    // 2. Tool: model calls the extension tool; result visible.
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("get_current_time", {}, { id: "call-t1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("The time is frozen."),
    ]);
    await session.prompt("what time is it?");
    items = selectTranscript(state);
    const toolItem = items.find((i) => i.role === "tool");
    expect(toolItem).toBeDefined();
    expect(toolItem!.toolName).toBe("get_current_time");

    // 3. Command: /hello dispatched server-side, note visible.
    await session.prompt("/hello Kaya");
    items = selectTranscript(state);
    expect(items.some((i) => i.role === "assistant" && i.content.some((c) => c.type === "text" && c.text.includes("Hello, Kaya!")))).toBe(true);

    // Render every transcript item through the real pi-tui components.
    const ui = createKayaUi();
    for (const item of items) {
      const component = ui.createItemComponent(item);
      const lines = component.render(80);
      expect(lines.length, `item ${item.id} role=${item.role}`).toBeGreaterThan(0);
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(80);
      }
      component.invalidate();
    }
    const rendered = items.map((i) => ui.createItemComponent(i).render(100).join("\n")).join("\n---\n");
    expect(rendered).toContain("hello-extension active");
    expect(rendered).toContain("get_current_time");
    expect(rendered).toContain("The time is frozen.");
    expect(rendered).toContain("Hello, Kaya!");

    await session.dispose();
    await client.dispose();
    await server.close();
  });
});
