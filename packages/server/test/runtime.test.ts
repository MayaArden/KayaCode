import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { TranscriptProgress } from "@earendil-works/pi-protocol";
import { NOOP_TELEMETRY_CONTEXT } from "@earendil-works/pi-telemetry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KayaServerService } from "../src/service.js";
import type { KayaSessionRuntime } from "../src/session.js";
import { JsonSessionStore } from "../src/store.js";

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kaya-server-"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeService(overrides: { cwd?: string } = {}) {
  const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 1_000_000 }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const cwd = overrides.cwd ?? tmp;
  const service = new KayaServerService({
    models,
    store: new JsonSessionStore(path.join(tmp, `.store-${Math.random().toString(36).slice(2)}`)),
    telemetry: NOOP_TELEMETRY_CONTEXT,
    config: { cwd, configDir: tmp, watchExtensions: false },
    defaultModel: faux.getModel() as never,
    defaultModelRef: { provider: "faux", id: "faux-1" },
  });
  return { faux, service };
}

describe("KayaSessionRuntime", () => {
  it("runs a prompt end-to-end and snapshots the transcript", async () => {
    const { faux, service } = makeService();
    faux.setResponses([fauxAssistantMessage("Hello back!")]);

    const runtime = await service.createSession({ id: "s1", cwd: tmp });
    const progress: TranscriptProgress[] = [];
    let snapshotEvents = 0;
    const unsub = runtime.subscribe((event) => {
      if (event.type === "progress") progress.push(event.progress);
      if (event.type === "snapshot") snapshotEvents++;
    });

    await runtime.prompt({ text: "hi" });

    const snapshot = await runtime.snapshot();
    const texts = snapshot.transcript
      .filter((i) => i.role === "assistant")
      .flatMap((i) => i.content.filter((c) => c.type === "text").map((c) => c.text));
    expect(texts).toContain("Hello back!");
    expect(snapshot.phase).toBe("idle");
    expect(faux.state.callCount).toBe(1);

    const kinds = progress.map((p) => p.type);
    expect(kinds).toContain("item_started");
    expect(kinds).toContain("assistant_delta");
    expect(kinds).toContain("item_finished");
    expect(snapshotEvents).toBeGreaterThan(0);
    unsub();
    await runtime.dispose();
  });

  it("dispatches slash commands server-side (built-in /tools)", async () => {
    const { faux, service } = makeService();
    faux.setResponses([]);
    const runtime = await service.createSession({ id: "s2", cwd: tmp });
    await runtime.prompt({ text: "/tools" });
    const snapshot = await runtime.snapshot();
    const notes = snapshot.transcript
      .filter((i) => i.role === "assistant")
      .flatMap((i) => i.content.filter((c) => c.type === "text").map((c) => c.text));
    expect(notes.some((t) => t.includes("Active tools:"))).toBe(true);
    expect(faux.state.callCount).toBe(0);
    await runtime.dispose();
  });

  it("extension tool + hook + command work against the real agent loop", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kaya-ext-"));
    fs.mkdirSync(path.join(cwd, ".kaya", "extensions"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".kaya", "extensions", "fixture.ts"),
      `import { Type } from "@kaya/extensions";
export default function (kaya) {
  kaya.on("tool_call", (e, ctx) => {
    if (e.toolName === "hello_tool") Object.assign(e.input, { name: String(e.input.name).toUpperCase() });
  });
  kaya.registerTool({
    name: "hello_tool",
    label: "Hello",
    description: "Greets",
    parameters: Type.Object({ name: Type.String() }),
    execute: async (_id, params) => ({
      content: [{ type: "text", text: "Hello, " + params.name + "!" }],
      details: null,
    }),
  });
  kaya.registerCommand("hello", {
    description: "Says hello",
    handler: (args, ctx) => ctx.appendAssistantNote("hello cmd: " + args),
  });
}
`,
    );

    const { faux, service } = makeService({ cwd });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("hello_tool", { name: "world" }, { id: "call-1" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("All done."),
    ]);

    const runtime = (await service.createSession({ id: "s3", cwd })) as KayaSessionRuntime;
    await runtime.prompt({ text: "call the tool" });
    expect(faux.state.callCount).toBe(2);

    let snapshot = await runtime.snapshot();
    const toolItems = snapshot.transcript.filter((i) => i.role === "tool");
    expect(toolItems).toHaveLength(1);
    expect(toolItems[0]!.toolName).toBe("hello_tool");
    expect(toolItems[0]!.status).toBe("complete");
    const toolText = toolItems[0]!.content.filter((c) => c.type === "text").map((c) => c.text)[0];
    // The tool_call hook upper-cased the argument before execution.
    expect(toolText).toBe("Hello, WORLD!");

    await runtime.prompt({ text: "/hello there" });
    snapshot = await runtime.snapshot();
    const notes = snapshot.transcript
      .filter((i) => i.role === "assistant")
      .flatMap((i) => i.content.filter((c) => c.type === "text").map((c) => c.text));
    expect(notes).toContain("hello cmd: there");
    await runtime.dispose();
  });

  it("persists and reopens a session from the JSON store", async () => {
    const { faux, service } = makeService();
    faux.setResponses([fauxAssistantMessage("remembered")]);
    const runtime = await service.createSession({ id: "s4", cwd: tmp });
    await runtime.prompt({ text: "hi" });
    await runtime.dispose();

    faux.setResponses([]);
    const reopened = await service.openSession("s4");
    const snapshot = await reopened.snapshot();
    const texts = snapshot.transcript
      .filter((i) => i.role === "assistant")
      .flatMap((i) => i.content.filter((c) => c.type === "text").map((c) => c.text));
    expect(texts).toContain("remembered");
    await reopened.dispose();
  });

  it("hot-reloads an edited extension file", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kaya-ext-reload-"));
    fs.mkdirSync(path.join(cwd, ".kaya", "extensions"), { recursive: true });
    const file = path.join(cwd, ".kaya", "extensions", "v.ts");
    fs.writeFileSync(
      file,
      `export default function (kaya) { kaya.registerCommand("v", { handler: (_a, ctx) => ctx.appendAssistantNote("v1") }); }`,
    );
    const { service } = makeService({ cwd });
    const runtime = (await service.createSession({ id: "s5", cwd })) as KayaSessionRuntime;
    await runtime.prompt({ text: "/v" });

    fs.writeFileSync(
      file,
      `export default function (kaya) { kaya.registerCommand("v", { handler: (_a, ctx) => ctx.appendAssistantNote("v2") }); }`,
    );
    await runtime.reloadExtensions();
    await runtime.prompt({ text: "/v" });

    const snapshot = await runtime.snapshot();
    const notes = snapshot.transcript
      .filter((i) => i.role === "assistant")
      .flatMap((i) => i.content.filter((c) => c.type === "text").map((c) => c.text));
    expect(notes).toContain("v1");
    expect(notes).toContain("v2");
    await runtime.dispose();
  });
});
