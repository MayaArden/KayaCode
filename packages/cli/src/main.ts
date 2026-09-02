#!/usr/bin/env node
import * as os from "node:os";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import { realpathSync } from "node:fs";
import { PiClient, type ByteTransportFactory } from "@earendil-works/pi-client";
import type { ThinkingLevel } from "@earendil-works/pi-protocol";
import { PiServer } from "@earendil-works/pi-server";
import { createKayaService, createLocalEndpoint, createTcpListener, createTcpTransportFactory, type KayaServerConfig } from "@kaya/server";
import { runInteractiveApp } from "./app.js";
import { runPrintMode } from "./print.js";

const DEFAULT_LISTEN = "tcp://127.0.0.1:7878";

interface ParsedArgs {
  command: "chat" | "serve";
  serverAddress?: string; // split mode: connect to this
  listen: string; // serve mode
  print?: string; // -p
  model?: string;
  thinking?: ThinkingLevel;
  sessionId?: string;
  extensions: string[];
  watchExtensions: boolean;
  telemetryFile?: string;
  cwd: string;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    command: "chat",
    listen: DEFAULT_LISTEN,
    extensions: [],
    watchExtensions: true,
    cwd: process.cwd(),
    help: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const takeValue = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Flag ${arg} expects a value`);
      return value;
    };
    if (arg === "serve") args.command = "serve";
    else if (arg === "--server" || arg === "--connect") args.serverAddress = takeValue();
    else if (arg === "--listen") args.listen = takeValue();
    else if (arg === "-p" || arg === "--print") args.print = takeValue();
    else if (arg === "--model" || arg === "-m") args.model = takeValue();
    else if (arg === "--thinking") args.thinking = takeValue() as ThinkingLevel;
    else if (arg === "--session") args.sessionId = takeValue();
    else if (arg === "-e" || arg === "--extension") args.extensions.push(takeValue());
    else if (arg === "--no-watch") args.watchExtensions = false;
    else if (arg === "--telemetry") args.telemetryFile = takeValue();
    else if (arg === "-h" || arg === "--help") args.help = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown flag: ${arg}`);
    else positional.push(arg);
  }
  if (args.print === undefined && positional.length > 0) args.print = positional.join(" ");
  return args;
}

const HELP = `kaya — AI coding agent client (pi-agent-core + pi-tui)

Usage:
  kaya [flags]                 Start interactive TUI (server runs in-process by default)
  kaya -p "prompt"             One-shot print mode
  kaya serve [flags]           Run a standalone server (default ${DEFAULT_LISTEN})
  kaya --server tcp://H:P      Connect to a remote/split server instead

Flags:
  --listen tcp://host:port     Listen address for "serve" (unix:///abs/path also supported)
  --server tcp://host:port     Connect to a running server (split mode)
  -m, --model provider/id      Model (env KAYA_MODEL; default anthropic/claude-sonnet-4-6)
  --thinking LEVEL             off|minimal|low|medium|high|xhigh|max
  --session ID                 Attach to an existing session
  -e, --extension PATH         Extra extension file/dir (repeatable)
  --no-watch                   Disable extension hot-reload watcher
  --telemetry FILE             Write JSONL telemetry spans to FILE
  -p, --print PROMPT           Print mode (non-interactive)
  -h, --help                   This help

Extensions load from .kaya/extensions/ (project) and ~/.kaya/extensions/ (global).
`;

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const serviceConfig: KayaServerConfig = {
    cwd: args.cwd,
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.thinking !== undefined ? { thinkingLevel: args.thinking } : {}),
    ...(args.telemetryFile !== undefined ? { telemetryFile: args.telemetryFile } : {}),
    extraExtensionPaths: args.extensions,
    watchExtensions: args.watchExtensions,
  };

  if (args.command === "serve") {
    return runServe(args, serviceConfig);
  }

  // Chat modes.
  if (args.serverAddress !== undefined) {
    const transportFactory = await createTransportFactory(args.serverAddress);
    const client = await PiClient.connect({ transportFactory });
    return runClient(args, client, args.serverAddress, () => client.dispose());
  }

  // Combined mode: server in-process, client connected over pi-protocol frames.
  const kaya = await createKayaService(serviceConfig);
  const endpoint = createLocalEndpoint();
  const server = new PiServer(kaya.service, { listeners: [endpoint.listener] });
  await server.start();
  const client = await PiClient.connect({ transportFactory: endpoint.transportFactory });
  // Combined mode: the client can see server-registered commands (extension +
  // built-in) directly from the live session runtime for autocomplete.
  const getExtensionCommands = (sessionId: string) =>
    kaya.service.getLiveSession(sessionId)?.host.getCommands() ?? [];
  return runClient(args, client, "in-process", async () => {
    await client.dispose();
    await server.close();
    await kaya.dispose();
  }, getExtensionCommands);
}

async function runClient(
  args: ParsedArgs,
  client: PiClient,
  serverLabel: string,
  cleanup: () => Promise<void>,
  getExtensionCommands?: (sessionId: string) => import("./app.js").ServerCommandInfo[],
): Promise<number> {
  try {
    const exitCode =
      args.print !== undefined
        ? await runPrintMode({
            client,
            cwd: args.cwd,
            prompt: args.print,
            ...(args.model !== undefined ? { model: args.model } : {}),
            ...(args.thinking !== undefined ? { thinkingLevel: args.thinking } : {}),
          })
        : await runInteractiveApp({
            client,
            cwd: args.cwd,
            ...(args.model !== undefined ? { model: args.model } : {}),
            ...(args.thinking !== undefined ? { thinkingLevel: args.thinking } : {}),
            ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
            serverLabel,
            logDirectory: path.join(os.homedir(), ".kaya", "logs"),
            ...(getExtensionCommands !== undefined ? { getExtensionCommands } : {}),
          });
    return exitCode;
  } finally {
    await cleanup();
  }
}

async function runServe(args: ParsedArgs, config: KayaServerConfig): Promise<number> {
  const kaya = await createKayaService(config);
  const listener = await createListener(args.listen);
  const server = new PiServer(kaya.service, { listeners: [listener] });
  await server.start();
  const address = server.addresses[0] ?? args.listen;
  process.stdout.write(`kaya server listening on ${address}\n`);
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      void server
        .close()
        .then(() => kaya.dispose())
        .then(() => resolve());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  return 0;
}

async function createListener(address: string) {
  if (address.startsWith("tcp://")) {
    const { host, port } = parseTcpAddress(address);
    return createTcpListener({ host, port });
  }
  if (address.startsWith("unix://")) {
    if (process.platform === "win32") {
      throw new Error("unix:// listeners are not supported on Windows; use tcp://127.0.0.1:PORT");
    }
    const { createUnixListener } = await import("@earendil-works/pi-server/unix");
    return createUnixListener({ path: address.slice("unix://".length + 1) });
  }
  throw new Error(`Unsupported listen address "${address}" — use tcp://host:port or unix:///path`);
}

async function createTransportFactory(address: string): Promise<ByteTransportFactory> {
  if (address.startsWith("tcp://")) {
    return createTcpTransportFactory(parseTcpAddress(address)) as ByteTransportFactory;
  }
  if (address.startsWith("unix://")) {
    if (process.platform === "win32") {
      throw new Error("unix:// connections are not supported on Windows; use tcp://127.0.0.1:PORT");
    }
    const { createUnixTransportFactory } = await import("@earendil-works/pi-client/unix");
    return createUnixTransportFactory({ path: address.slice("unix://".length + 1) });
  }
  throw new Error(`Unsupported server address "${address}" — use tcp://host:port or unix:///path`);
}

function parseTcpAddress(address: string): { host: string; port: number } {
  const rest = address.slice("tcp://".length);
  const colon = rest.lastIndexOf(":");
  if (colon === -1) throw new Error(`Invalid tcp address "${address}" — expected tcp://host:port`);
  const host = rest.slice(0, colon);
  const port = Number.parseInt(rest.slice(colon + 1), 10);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid tcp address "${address}" — expected tcp://host:port`);
  }
  return { host, port };
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
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}
`);
      process.exit(1);
    },
  );
}
