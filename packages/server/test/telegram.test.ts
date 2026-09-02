import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { NOOP_TELEMETRY_CONTEXT } from "@earendil-works/pi-telemetry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KayaServerService } from "../src/service.js";
import type { KayaSessionRuntime } from "../src/session.js";
import { JsonSessionStore } from "../src/store.js";
import { createNotifyTelegramTool, loadLinkedChatId, loadTelegramConfig } from "../src/telegram.js";

let tmp: string;
let apiStub: http.Server;
let received: { method: string; payload: Record<string, unknown> }[];
let apiPort: number;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kaya-tg-"));
  received = [];
  apiStub = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const url = req.url ?? "";
      const method = url.split("/").pop() ?? "";
      received.push({ method, payload: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, result: { message_id: 42 } }));
    })();
  });
  await new Promise<void>((resolve) => apiStub.listen(0, "127.0.0.1", resolve));
  apiPort = (apiStub.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise((resolve) => apiStub.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(configDir: string, chatIds: number[] = [111, 222]) {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "telegram.json"),
    JSON.stringify({
      botToken: "test-token",
      allowedChatIds: chatIds,
      apiBase: `http://127.0.0.1:${apiPort}`,
    }),
  );
}

describe("notify_telegram tool", () => {
  it("sends via the Bot API to the linked/first allowlisted chat", async () => {
    const configDir = path.join(tmp, "cfg1");
    writeConfig(configDir);
    const tool = createNotifyTelegramTool(configDir);
    expect(tool).toBeDefined();
    const result = await tool!.execute("c1", { message: "job <done>" } as never, undefined, undefined);
    const call = received.at(-1)!;
    expect(call.method).toBe("sendMessage");
    expect(call.payload.chat_id).toBe(111);
    // HTML-escaped before sending.
    expect(call.payload.text).toBe("job &lt;done&gt;");
    expect(result.details).toEqual({ chatId: 111, messageId: 42 });
  });

  it("refuses non-allowlisted chat ids", async () => {
    const configDir = path.join(tmp, "cfg2");
    writeConfig(configDir);
    const tool = createNotifyTelegramTool(configDir)!;
    await expect(tool.execute("c2", { message: "x", chatId: 999 } as never, undefined, undefined)).rejects.toThrow(
      /not in allowedChatIds/,
    );
  });

  it("returns undefined when no Telegram config exists", () => {
    expect(createNotifyTelegramTool(path.join(tmp, "cfg-empty"))).toBeUndefined();
  });
});

describe("/telegram command (server-side builtin)", () => {
  it("reports status, links and unlinks an allowlisted chat, rejects others", async () => {
    const configDir = path.join(tmp, "cfg3");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kaya-tg-cwd-"));
    writeConfig(configDir);

    const faux = fauxProvider({ models: [{ id: "faux-1" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const service = new KayaServerService({
      models,
      store: new JsonSessionStore(path.join(tmp, "store-tg")),
      telemetry: NOOP_TELEMETRY_CONTEXT,
      config: { cwd, configDir, watchExtensions: false, mcp: false },
      defaultModel: faux.getModel() as never,
      defaultModelRef: { provider: "faux", id: "faux-1" },
    });
    const runtime = (await service.createSession({ id: "tg-1", cwd })) as KayaSessionRuntime;

    const notes = async () => {
      const snapshot = await runtime.snapshot();
      return snapshot.transcript
        .filter((i) => i.role === "assistant")
        .flatMap((i) => i.content.filter((c) => c.type === "text").map((c) => c.text));
    };

    await runtime.prompt({ text: "/telegram" });
    expect((await notes()).some((t) => t.includes("Telegram status:"))).toBe(true);
    expect((await notes()).some((t) => t.includes("linked chat: (none") || t.includes("linked chat"))).toBe(true);

    await runtime.prompt({ text: "/telegram link 999" });
    expect((await notes()).at(-1)).toContain("not in allowedChatIds");

    await runtime.prompt({ text: "/telegram link 222" });
    expect((await notes()).at(-1)).toContain("linked to chat 222");
    expect(loadLinkedChatId(configDir)).toBe(222);

    await runtime.prompt({ text: "/telegram test" });
    const call = received.at(-1)!;
    expect(call.method).toBe("sendMessage");
    expect(call.payload.chat_id).toBe(222);

    // Allowlist management from the CLI command:
    await runtime.prompt({ text: "/telegram allow chat 333" });
    expect((await notes()).at(-1)).toContain("Allowed chat 333");
    expect(loadTelegramConfig(configDir)!.allowedChatIds).toEqual([111, 222, 333]);

    await runtime.prompt({ text: "/telegram allow user 777" });
    expect(loadTelegramConfig(configDir)!.allowedUserIds).toEqual([777]);

    await runtime.prompt({ text: "/telegram deny chat 333" });
    expect((await notes()).at(-1)).toContain("Denied chat 333");
    expect(loadTelegramConfig(configDir)!.allowedChatIds).toEqual([111, 222]);

    // Denying the currently linked chat also unlinks it.
    await runtime.prompt({ text: "/telegram deny chat 222" });
    expect(loadTelegramConfig(configDir)!.allowedChatIds).toEqual([111]);
    expect(loadLinkedChatId(configDir)).toBeUndefined();

    // Linking a non-allowlisted chat stays rejected.
    await runtime.prompt({ text: "/telegram link 999" });
    expect((await notes()).at(-1)).toContain("not in allowedChatIds");

    await runtime.prompt({ text: "/telegram unlink" });
    expect(loadLinkedChatId(configDir)).toBeUndefined();
    await runtime.dispose();
  }, 15_000);
});
