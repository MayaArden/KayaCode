import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExtensionHost } from "../src/host.js";
import { ExtensionLoader } from "../src/loader.js";
import type { KayaSessionFacade } from "../src/types.js";

function makeFacade(): KayaSessionFacade {
  return {
    cwd: process.cwd(),
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
  };
}

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kaya-loader-"));
  fs.mkdirSync(path.join(tmp, ".kaya", "extensions"), { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("ExtensionLoader", () => {
  it("discovers and loads .ts extension files with aliased kaya/typebox imports", async () => {
    fs.writeFileSync(
      path.join(tmp, ".kaya", "extensions", "hello.ts"),
      `import { Type } from "@kaya/extensions";
import type { KayaExtensionAPI } from "@kaya/extensions";

export default function (kaya: KayaExtensionAPI) {
  kaya.registerTool({
    name: "fixture_tool",
    label: "Fixture",
    description: "fixture",
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: undefined }),
  });
  kaya.registerCommand("fixture", {
    handler: (args, ctx) => {
      ctx.appendAssistantNote(args);
    },
  });
  kaya.on("session_start", (e) => {
    if (e.reason !== "startup") throw new Error("unexpected reason");
  });
}
`,
    );
    const host = new ExtensionHost(makeFacade());
    const loader = new ExtensionLoader({ cwd: tmp });
    const result = await loader.loadAll(host);
    expect(result.errors).toEqual([]);
    expect(result.loaded).toHaveLength(1);
    expect(result.loaded[0]!.endsWith("hello.ts")).toBe(true);
    expect(host.getTools().map((t) => t.name)).toEqual(["fixture_tool"]);
    expect(host.getCommand("fixture")).toBeDefined();
    expect(host.hasHandlers("session_start")).toBe(true);
  });

  it("reports per-file errors and continues loading", async () => {
    fs.writeFileSync(path.join(tmp, ".kaya", "extensions", "broken.ts"), `throw new Error("import fail");`);
    const host = new ExtensionHost(makeFacade(), { onError: () => {} });
    const loader = new ExtensionLoader({ cwd: tmp });
    const result = await loader.loadAll(host);
    expect(result.loaded.map((p) => path.basename(p))).toEqual(["hello.ts"]);
    expect(result.errors).toHaveLength(1);
    expect(path.basename(result.errors[0]!.path)).toBe("broken.ts");
  });

  it("loads a freshly edited file on the next loadAll (hot-reload path)", async () => {
    const file = path.join(tmp, ".kaya", "extensions", "versioned.ts");
    fs.writeFileSync(
      file,
      `export default function (kaya: any) { kaya.registerTool({ name: "v1", label: "v1", description: "", parameters: {}, execute: async () => ({ content: [], details: undefined }) }); }`,
    );
    const loader = new ExtensionLoader({ cwd: tmp });

    const host1 = new ExtensionHost(makeFacade());
    await loader.loadAll(host1, [file]);
    expect(host1.getTools().map((t) => t.name)).toEqual(["v1"]);

    fs.writeFileSync(
      file,
      `export default function (kaya: any) { kaya.registerTool({ name: "v2", label: "v2", description: "", parameters: {}, execute: async () => ({ content: [], details: undefined }) }); }`,
    );
    const host2 = new ExtensionHost(makeFacade());
    await loader.loadAll(host2, [file]);
    expect(host2.getTools().map((t) => t.name)).toEqual(["v2"]);
  });
});
