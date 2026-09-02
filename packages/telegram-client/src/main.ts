#!/usr/bin/env node
import * as os from "node:os";
import * as path from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PiClient, type ByteTransportFactory } from "@earendil-works/pi-client";
import { PiServer } from "@earendil-works/pi-server";
import {
  createKayaService,
  createLocalEndpoint,
  createTcpTransportFactory,
  requireTelegramConfig,
} from "@kaya/server";
import { createKayaTelegramBot } from "./bot.js";
import { ChatSessions } from "./sessions.js";

/**
 * kaya-telegram — persistent bot process.
 *
 * Default: split mode — connects to a running `kaya serve` instance
 * (`--server tcp://host:port` or `"server"` in ~/.kaya/telegram.json).
 * With no server configured it self-hosts (combined mode), mirroring the CLI.
 */
export async function main(argv: string[]): Promise<number> {
  let serverAddress: string | undefined;
  let configDir = path.join(os.homedir(), ".kaya");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--server") serverAddress = argv[++i];
    else if (arg === "--config-dir") configDir = argv[++i]!;
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        "kaya-telegram [--server tcp://host:port] [--config-dir DIR]\n" +
          "  Bot token/allowlist: ~/.kaya/telegram.json or TELEGRAM_BOT_TOKEN.\n",
      );
      return 0;
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  const config = requireTelegramConfig(configDir);
  if (!config.allowedChatIds.length) {
    throw new Error("telegram.json has an empty allowedChatIds — refusing to start an open bot.");
  }

  process.stdout.write(`kaya-telegram: allowlisted chats: ${config.allowedChatIds.join(", ")}\n`);

  let client: PiClient;
  let cleanup = async (): Promise<void> => {};
  const address = serverAddress ?? config.server;
  if (address) {
    if (!address.startsWith("tcp://")) throw new Error("Only tcp:// server addresses are supported on this platform.");
    client = await PiClient.connect({ transportFactory: createTcpTransportFactoryFactory(address) });
  } else {
    // Self-hosted combined mode: in-process server, real protocol frames.
    const kaya = await createKayaService({ cwd: process.cwd(), configDir });
    const endpoint = createLocalEndpoint();
    const server = new PiServer(kaya.service, { listeners: [endpoint.listener] });
    await server.start();
    client = await PiClient.connect({ transportFactory: endpoint.transportFactory });
    cleanup = async () => {
      await server.close();
      await kaya.dispose();
    };
  }

  const sessions = new ChatSessions(client, process.cwd(), configDir);
  const bot = createKayaTelegramBot({ config, configDir, client, sessions });

  await bot.api.setMyCommands([
    { command: "model", description: "Set model (provider/id)" },
    { command: "provider", description: "Switch provider" },
    { command: "thinking", description: "Set thinking level" },
    { command: "new", description: "Start a new session for this chat" },
    { command: "status", description: "Session phase and model" },
    { command: "output", description: "Full output of the last tool call" },
    { command: "compact", description: "Compact context (server)" },
    { command: "tools", description: "List tools (server)" },
    { command: "reload", description: "Reload extensions/MCP (server)" },
    { command: "abort", description: "Abort the current run" },
  ]);

  process.once("SIGINT", () => bot.stop());
  process.once("SIGTERM", () => bot.stop());
  process.on("beforeExit", () => void cleanup());

  process.stdout.write("kaya-telegram: starting long polling as @" + (await bot.api.getMe()).username + "\n");
  // Await polling: bot.start() resolves only when the bot stops (SIGINT/SIGTERM
  // call bot.stop()). Returning earlier would hit process.exit() in the
  // entrypoint and kill the bot right after startup — no getUpdates loop, so
  // inbound messages are never received while outbound notify (plain HTTP
  // from the server) keeps working.
  await bot.start({
    onStart: () => {
      process.stdout.write("kaya-telegram: polling started — send the bot a message\n");
    },
  });
  return 0;
}

function createTcpTransportFactoryFactory(address: string): ByteTransportFactory {
  const rest = address.slice("tcp://".length);
  const colon = rest.lastIndexOf(":");
  const host = rest.slice(0, colon);
  const port = Number.parseInt(rest.slice(colon + 1), 10);
  return createTcpTransportFactory({ host, port }) as ByteTransportFactory;
}

// Entrypoint guard: run when executed directly (bin) but not when imported.
// argv[1] may be a symlink/junction (npm link shim), so resolve it to the real
// path before comparing — import.meta.url is always the real path.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main(process.argv.slice(2)).then(
    (code) => {
      // Only force-exit on failure; a success exit lets the event loop drain
      // naturally (process.exit() mid-cleanup trips a libuv assertion on Windows).
      if (code !== 0) process.exit(code);
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exit(1);
    },
  );
}
