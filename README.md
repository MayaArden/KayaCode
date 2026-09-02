# Kaya

Built by **MayaArden**.

Kaya is a standalone terminal AI coding agent built **on top of Pi's published
packages** as real npm dependencies. It is not a fork or rebrand of
`pi-coding-agent`: the extension system, the server wiring, and the client are
original code, while everything that Pi already does well — the agent loop, the
provider layer, the terminal UI toolkit, the wire protocol — is used directly.

## How it differs from pi-coding-agent

- **Client-server by construction.** Kaya always runs a `pi-server`/`pi-protocol`
  session, even in the default single-process mode (the two halves talk over an
  in-process transport carrying real protocol frames). Split server/client
  deployment over TCP is first-class, not experimental glue.
- **Own extension system** (`@kaya/extensions`). Smaller and deliberately
  server-side: extensions register lifecycle hooks, real `AgentTool`s, and slash
  commands — but there is no UI surface (renderers/widgets/shortcuts), because
  extensions run where the `Agent` runs, not where the screen is.
- **Own defaults.** Kaya's own system prompt, its own default tool set
  (pi-agent-core's `bash`/`read`/`edit`/`write`), blue-first theme, and its own
  config dir (`.kaya/`).
- **Slash commands dispatch server-side** through the extension command
  registry (pi's wire protocol has no command concept; kaya's session runtime
  intercepts them before they reach the model).
- **Observability built in.** The server wraps runs, tool calls, and compaction
  in `pi-telemetry` spans with kaya's own schema and a JSONL exporter
  (pi-telemetry ships contracts only; the exporter is kaya's).

## Packages

| Package | Role |
| --- | --- |
| `@kaya/extensions` | Extension host: `KayaExtensionAPI` (`on` / `registerTool` / `registerCommand`), registry, dispatcher, jiti-based `.ts` loader with hot reload |
| `@kaya/mcp` | MCP client loader (official `@modelcontextprotocol/sdk`): connects to configured MCP servers and registers their tools into the same host |
| `@kaya/server` | Hosts `pi-agent-core` Agents behind `pi-server`: session runtime, transcript/progress bridge, providers (Anthropic, OpenAI, Ollama via OpenAI-compatible config), JSON session store, telemetry, TCP + in-process transports |
| `@kaya/cli` | `kaya` binary: interactive TUI (`pi-tui`), print mode, `serve` subcommand, split-mode client |
| `@kaya/telegram-client` | `kaya-telegram` binary: Telegram bot client over the same pi-client/pi-protocol wire; one persistent session per chat |

## Install

```bash
git clone <repo-url> && cd kaya
npm install && npm run build

# Make `kaya` (and `kaya-telegram`) available globally:
npm link -w @kaya/cli
npm link -w @kaya/telegram-client   # optional, only for the Telegram bot

kaya            # interactive TUI
kaya-telegram   # Telegram bot
```

## Requirements

Node.js >= 22.19. API keys picked up from the environment (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, ...). Default model: `anthropic/claude-sonnet-4-6`; override
with `--model provider/id` or `KAYA_MODEL`. Ollama: `--model ollama/llama3.1`
(`OLLAMA_BASE_URL`, `OLLAMA_MODELS` to extend the model list).

## Running

```bash
npm install
npm run build

# Combined mode (default): server + client in one process
node packages/cli/dist/main.js

# One-shot print mode
node packages/cli/dist/main.js -p "Say exactly: ok"

# Split mode: standalone server + separate client
node packages/cli/dist/main.js serve --listen tcp://127.0.0.1:7878
node packages/cli/dist/main.js --server tcp://127.0.0.1:7878
```

## Interactive client

- Slash commands autocomplete with structured argument suggestions as you type:
  `/model <provider/id>`, `/provider <name>` (keeps the current model id when the
  new provider has it, else the provider's default), `/thinking <level>`. In
  combined mode, extension-registered commands appear too, including their own
  argument completions.
- Collapsible blocks (thinking, tool output) collapse to a summary line when
  they finish. `ctrl+o` expands the bottom-most collapsed block (repeated
  presses walk upward; press again to collapse back). Expanded tool output
  pages 20 lines at a time inside the box — `alt+up`/`alt+down` to page.
- User messages render in a double-bordered box; tool calls in single-bordered
  blue boxes; the status bar sits below the input.

## Extensions

Extensions are TypeScript files, loaded at runtime (no build step) from
`<cwd>/.kaya/extensions/`, `~/.kaya/extensions/`, or `--extension <path>`.
Edit a file and it hot-reloads (or `/reload`).

```ts
import { Type } from "@kaya/extensions";
import type { KayaExtensionAPI } from "@kaya/extensions";

export default function (kaya: KayaExtensionAPI) {
  kaya.on("session_start", (_event, ctx) => {
    ctx.appendAssistantNote(`extension active in ${ctx.cwd}`);
  });

  kaya.registerTool({
    name: "get_current_time",
    label: "Get current time",
    description: "Returns the current local time.",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: new Date().toISOString() }], details: undefined }),
  });

  kaya.registerCommand("hello", {
    description: "Greet someone",
    handler: (args, ctx) => ctx.appendAssistantNote(`Hello, ${args || "there"}!`),
  });
}
```

A runnable version lives in `examples/hello-extension/`.

## MCP servers

Kaya is an MCP **client** (via the official `@modelcontextprotocol/sdk` v1.30).
Configure servers in `.kaya/mcp.json` (project) or `~/.kaya/mcp.json` (global);
they merge, project wins on name conflicts:

```json
{
  "mcpServers": {
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "api": { "url": "https://example.com/mcp" },
    "legacy": { "url": "https://example.com/sse", "transport": "sse" }
  }
}
```

`command` selects the stdio transport, `url` the streamable-HTTP transport
(`"transport": "sse"` for legacy SSE servers), `headers` for auth. On session
start each server is connected (10s timeout), its tools are listed, converted
(JSON Schema -> TypeBox), and registered as `mcp__<server>__<tool>` real
`AgentTool`s — through the exact same `registerTool()` pipeline local
extensions use, so MCP tools are indistinguishable to the agent and the client.
An unreachable or misconfigured server is skipped with a transcript note; it
never blocks the session. `/reload` reconnects MCP servers too.

**v1 scope:** tools only. MCP resources and prompts are deliberately excluded —
they don't map onto `AgentTool`; support is a documented future gap.

## Telegram

Two pieces, sharing one bot/token (`~/.kaya/telegram.json` or `TELEGRAM_BOT_TOKEN`):

```json
{
  "botToken": "123:...",           // or env TELEGRAM_BOT_TOKEN
  "allowedChatIds": [123456789],
  "allowedUserIds": [987654321],    // optional user-level restriction
  "server": "tcp://127.0.0.1:7878"  // optional; default is self-hosted
}
```

**Bot client** (`packages/telegram-client`, bin `kaya-telegram`): connects to a
running `kaya serve` via real `pi-client`/`pi-protocol` frames (or self-hosts
in combined mode when no server is configured). Each Telegram chat maps to its
own persistent kaya session (`~/.kaya/telegram-sessions.json`). Non-allowlisted
chats get no response at all. Answers stream by editing a message in place
(debounced); tool calls arrive as condensed one-line summaries (mirroring the
CLI's collapse-by-default); `/output [n]` shows full tool output as `<pre>`
chunks. Telegram bot commands `/model /provider /thinking /new /status /output
/abort /compact /tools /reload` bridge to the same commands the TUI has;
extension/MCP slash commands work by prefixing any message text with `/`.

**Notify tool**: when Telegram is configured, the server registers a built-in
`notify_telegram` AgentTool so the agent can proactively message you mid-run
(task done / input needed / error) — restricted to allowlisted (or linked) chat
ids only. Link and allowlist management from the terminal (persisted to `telegram.json`,
picked up by a running bot without restart): `/telegram` (status), `/telegram
link <chatId>`, `/telegram unlink`, `/telegram test`, and
`/telegram allow|deny chat|user <id>`.

### Lifecycle events (`kaya.on(event, handler)`)

Pass-through of the `pi-agent-core` event stream:
`agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start`,
`message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`,
`tool_execution_end`.

Synthesized by `@kaya/server`:
`session_start` / `session_shutdown` (`reason`), `before_provider_request`
(may return a replacement payload), `after_provider_response`,
`before_compact` (may `{ cancel: true }`), `tool_call` (may mutate `input` in
place or return `{ block, reason?, terminate? }`), `tool_result` (may return
replacement `content` / `details` / `isError`).

Handlers run sequentially in load order; a throwing handler is reported to the
client as a transcript note and never breaks the loop.

## Architecture notes and known gaps

- **No sandboxing or permission system.** Inherited from pi-agent-core (it has
  none either). Tool calls run with the agent process's full privileges. Use
  the `tool_call` hook to build your own gating.
- **Sessions** are plain JSON files under `~/.kaya/sessions/`. The Pi SQLite
  session backend is the intended upgrade path when durability matters.
- **Extension commands in split mode** execute server-side but are not visible
  in the client's `/` autocomplete (server metadata doesn't cross the wire in
  protocol v1). Combined mode is unaffected in behavior; autocomplete lists
  client-side + built-in server commands either way.
- **Unix sockets** are used only on non-Windows platforms; TCP-on-localhost is
  the default everywhere (`pi-client`'s unix transport rejects Windows).
- **Plugins / skills** are out of scope for v1. The registration pipeline is
  source-agnostic by design (`registerTool` accepts any well-formed
  `AgentTool`); MCP support shipped exactly this way — as an additional loader
  (`@kaya/mcp`) feeding the same host, with no change to the extension API.

## Development

```bash
npm run build   # tsc per package, in dependency order
npm run check   # typecheck (tsc --noEmit) per package
npm test        # vitest: extension host + loader, server runtime, wire stack

# Live-render check against a real provider (requires OPENROUTER_API_KEY):
node scripts/live-tui-check.mjs   # writes live-check-frame.ansi / .txt
```
