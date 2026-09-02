import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { PiClient } from "@earendil-works/pi-client";
import type { SessionSnapshot } from "@earendil-works/pi-protocol";
import { PiServer } from "@earendil-works/pi-server";
import { NOOP_TELEMETRY_CONTEXT } from "@earendil-works/pi-telemetry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KayaServerService } from "../src/service.js";
import { JsonSessionStore } from "../src/store.js";
import { createLocalEndpoint } from "../src/transports/local.js";
import { createTcpListener, createTcpTransportFactory } from "../src/transports/tcp.js";

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kaya-stack-"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("full wire stack (pi-server + pi-protocol + kaya service, in-process transport)", () => {
  it("client connects, creates a session, prompts, and receives snapshots + progress", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 1_000_000 }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const service = new KayaServerService({
      models,
      store: new JsonSessionStore(path.join(tmp, "store")),
      telemetry: NOOP_TELEMETRY_CONTEXT,
      config: { cwd: tmp, configDir: tmp, watchExtensions: false },
      defaultModel: faux.getModel() as never,
      defaultModelRef: { provider: "faux", id: "faux-1" },
    });

    const endpoint = createLocalEndpoint();
    const serverErrors: string[] = [];
    const server = new PiServer(service, {
      listeners: [endpoint.listener],
      onError: (e) => serverErrors.push(`${e.name}: ${e.message}\n${e.stack ?? ""}`),
    });
    await server.start();

    const client = await PiClient.connect({ transportFactory: endpoint.transportFactory });
    const serverSnapshot = client.snapshot;
    expect(serverSnapshot?.sessions).toEqual([]);
    expect((serverSnapshot?.models ?? []).map((m) => m.id)).toContain("faux-1");

    const session = await client.createSession({ cwd: tmp });
    expect(serverErrors, serverErrors.join("\n")).toEqual([]);
    const snapshots: SessionSnapshot[] = [];
    const unsubSnap = session.subscribe((s) => snapshots.push(s));

    faux.setResponses([fauxAssistantMessage("wire hello")]);
    const result = await session.prompt("hello");
    expect(result.id).toBe(session.id);

    const final = snapshots[snapshots.length - 1] ?? result;
    const texts = final.transcript
      .filter((i) => i.role === "assistant")
      .flatMap((i) => i.content.filter((c) => c.type === "text").map((c) => c.text));
    expect(texts).toContain("wire hello");

    await session.dispose();
    await client.dispose();
    await server.close();
  });
});

describe("TCP transport (real sockets)", () => {
  it("serves the same stack over localhost TCP", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 1_000_000 }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const service = new KayaServerService({
      models,
      store: new JsonSessionStore(path.join(tmp, "store-tcp")),
      telemetry: NOOP_TELEMETRY_CONTEXT,
      config: { cwd: tmp, configDir: tmp, watchExtensions: false },
      defaultModel: faux.getModel() as never,
      defaultModelRef: { provider: "faux", id: "faux-1" },
    });

    const listener = createTcpListener({ host: "127.0.0.1", port: 0 });
    const server = new PiServer(service, { listeners: [listener] });
    await server.start();
    const address = server.addresses[0]!;
    const port = Number.parseInt(address.slice(address.lastIndexOf(":") + 1), 10);
    expect(port).toBeGreaterThan(0);

    const client = await PiClient.connect({ transportFactory: createTcpTransportFactory({ host: "127.0.0.1", port }) });
    const session = await client.createSession({ cwd: tmp });
    faux.setResponses([fauxAssistantMessage("over tcp")]);
    const result = await session.prompt("hello tcp");
    const texts = result.transcript
      .filter((i) => i.role === "assistant")
      .flatMap((i) => i.content.filter((c) => c.type === "text").map((c) => c.text));
    expect(texts).toContain("over tcp");

    await session.dispose();
    await client.dispose();
    await server.close();
  });
});
