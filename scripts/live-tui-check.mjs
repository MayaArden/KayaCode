/**
 * Live TUI verification: drives the real kaya interactive app with a fake
 * terminal, a real provider (OpenRouter), and captures the exact frame lines
 * the app renders (what pi-tui would write to the screen).
 *
 * Usage: node scripts/live-tui-check.mjs
 * Writes: live-check-frame.ansi (raw, with color codes) and live-check-frame.txt
 */
import "./force-color.mjs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PiClient } from "@earendil-works/pi-client";
import { PiServer } from "@earendil-works/pi-server";
import { runInteractiveApp } from "../packages/cli/dist/app.js";
import { createKayaService, createLocalEndpoint } from "../packages/server/dist/index.js";

const WIDTH = 100;

class FakeTerminal {
  onInput = () => {};
  start(onInput) { this.onInput = onInput; }
  stop() {}
  drainInput() { return Promise.resolve(); }
  write(_data) {}
  get columns() { return WIDTH; }
  get rows() { return 40; }
  get kittyProtocolActive() { return false; }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
}

async function main() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kaya-live-"));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "kaya-live-config-"));
  const kaya = await createKayaService({
    cwd,
    configDir,
    model: "openrouter/anthropic/claude-haiku-4.5",
    thinkingLevel: "low",
    watchExtensions: false,
  });
  const endpoint = createLocalEndpoint();
  const server = new PiServer(kaya.service, { listeners: [endpoint.listener] });
  await server.start();
  const client = await PiClient.connect({ transportFactory: endpoint.transportFactory });

  // Large file so the read tool's expanded output needs pagination.
  fs.writeFileSync(
    path.join(cwd, "big.txt"),
    Array.from({ length: 60 }, (_, i) => `line ${i + 1} of big.txt`).join("\n"),
  );

  const prompts = [
    "Briefly reason first (one short thought), then use the bash tool to run exactly: echo kaya-blue-check",
    "Create a file named live-check.txt containing the text: kaya renders blue",
    "Now use the edit tool to change the file content to: kaya renders blue v2",
    "Now read the file live-check.txt and tell me its content.",
    "Read the file big.txt using the read tool.",
  ];

  const frames = [];
  let driver;
  const terminal = new FakeTerminal();
  const appPromise = runInteractiveApp({
    client,
    cwd,
    model: "openrouter/anthropic/claude-haiku-4.5",
    thinkingLevel: "low",
    serverLabel: "in-process",
    logDirectory: configDir,
    terminal,
    onReady: (d) => { driver = d; },
  });

  for (const prompt of prompts) {
    console.log(`>>> ${prompt}`);
    while (!driver) await new Promise((r) => setTimeout(r, 100));
    await driver.submit(prompt);
    const start = Date.now();
    while (Date.now() - start < 120_000) {
      await new Promise((r) => setTimeout(r, 1000));
      const phase = driver.phase();
      if (phase === "idle") break;
    }
    console.log(`    phase after prompt: ${driver.phase()}`);
    frames.push(...driver.renderFrame(WIDTH), "\x1b[0m", `===== frame boundary (${prompt.slice(0, 30)}) =====`, "");
  }

  // Exercise the shared expand mechanism with real keypresses: ctrl+o walks
  // collapsed blocks bottom-up (last thinking block, then the read tool box),
  // alt+down pages the expanded box.
  const press = async (bytes, note) => {
    terminal.onInput(bytes);
    await new Promise((r) => setTimeout(r, 300));
    frames.push("", `===== after keypress: ${note} =====`, ...driver.renderFrame(WIDTH));
  };
  await press("", "ctrl+o #1 (expand newest collapsed)");
  await press("", "ctrl+o #2 (expand next collapsed = read tool box)");
  await press("[1;3B", "alt+down (page down in expanded box)");
  await press("[1;3B", "alt+down again");

  const ansi = frames.join("\n");
  fs.writeFileSync("live-check-frame.ansi", ansi + "\n");
  const stripped = ansi.replaceAll(/\x1b[[0-9;?]*[A-Za-z]/g, "").replaceAll(/\x1b\][^\x07]*\x07/g, "");
  fs.writeFileSync("live-check-frame.txt", stripped + "\n");

  // Color assertions: kaya palette hexes must be present in the real frame.
  const palette = {
    primary_5CB8FF: "38;2;92;184;255",
    accent_7AA2F7: "38;2;122;162;247",
    info_89DDFF: "38;2;137;221;255",
    muted_3D59A1: "38;2;61;89;161",
    userText_C0CAF5: "38;2;192;202;245",
    ok_9ECE6A: "38;2;158;206;106",
    error_F7768E: "38;2;247;118;142",
  };
  const present = {};
  for (const [name, code] of Object.entries(palette)) present[name] = ansi.includes(code);
  console.log("palette presence:", JSON.stringify(present, null, 1));

  await driver.stop();
  await Promise.race([appPromise, new Promise((r) => setTimeout(r, 3000))]);
  await client.dispose();
  await server.close();
  await kaya.dispose();
  console.log("DONE. cwd:", cwd);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
