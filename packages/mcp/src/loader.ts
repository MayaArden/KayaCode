import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionHost } from "@kaya/extensions";
import { loadMcpConfig, type McpResolvedConfig, type McpServerConfig } from "./config.js";
import { jsonSchemaToTypeBox } from "./schema.js";

export interface McpLoadOptions {
  cwd: string;
  configDir?: string;
  /** Per-server connect timeout. Default 10s. */
  connectTimeoutMs?: number;
}

export interface McpLoadResult {
  connected: { name: string; transport: string; toolNames: string[] }[];
  errors: { name: string; error: string }[];
  config: McpResolvedConfig;
}

function sanitizeName(part: string): string {
  return part.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Registered tool name: `mcp__<server>__<tool>` (collision-safe convention). */
export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${sanitizeName(serverName)}__${sanitizeName(toolName)}`;
}

function createTransport(server: McpServerConfig): { transport: Transport; kind: string } {
  if (server.url) {
    const init: { requestInit?: RequestInit } = {};
    if (server.headers) init.requestInit = { headers: server.headers };
    if (server.transport === "sse") {
      return { transport: new SSEClientTransport(new URL(server.url), init), kind: "sse" };
    }
    return { transport: new StreamableHTTPClientTransport(new URL(server.url), init), kind: "http" };
  }
  if (server.command) {
    const params = {
      command: server.command,
      args: server.args ?? [],
      env: { ...process.env, ...server.env } as Record<string, string>,
      cwd: server.cwd,
      stderr: "pipe" as const,
    };
    if (params.cwd === undefined) delete (params as { cwd?: string }).cwd;
    return { transport: new StdioClientTransport(params), kind: "stdio" };
  }
  throw new Error(`MCP server "${server.name}" has neither "command" nor "url"`);
}

function toAgentTool(serverName: string, tool: Tool, client: Client): AgentTool {
  const name = mcpToolName(serverName, tool.name);
  return {
    name,
    label: `${serverName}: ${tool.title ?? tool.name}`,
    description: tool.description ?? `MCP tool ${tool.name} from server ${serverName}`,
    parameters: jsonSchemaToTypeBox(tool.inputSchema),
    execute: async (_toolCallId, params) => {
      const result = await client.callTool({
        name: tool.name,
        arguments: (params ?? {}) as Record<string, unknown>,
      });
      const content: { type: "text"; text: string }[] = [];
      const raw = Array.isArray((result as { content?: unknown }).content)
        ? ((result as { content: unknown[] }).content as Record<string, unknown>[])
        : [];
      for (const block of raw) {
        if (block.type === "text" && typeof block.text === "string") {
          content.push({ type: "text", text: block.text });
        } else if (block.type === "image" && typeof block.data === "string") {
          content.push({ type: "text", text: `[image ${String(block.mimeType ?? "")}: ${(block.data as string).length} bytes base64]` });
        } else {
          content.push({ type: "text", text: JSON.stringify(block) });
        }
      }
      if (content.length === 0) content.push({ type: "text", text: "(no output)" });
      if ((result as { isError?: boolean }).isError) {
        throw new Error(content.map((c) => c.text).join("\n"));
      }
      return {
        content,
        details: {
          mcpServer: serverName,
          mcpTool: tool.name,
          structuredContent: (result as { structuredContent?: unknown }).structuredContent,
        },
      };
    },
  };
}

/**
 * Connects to each configured MCP server and registers its tools into the
 * given ExtensionHost — through the same registerTool() pipeline as local
 * extensions, so MCP is purely an additional loader source. A broken or
 * unreachable server is skipped with an error entry; it never throws.
 */
export class McpLoader {
  readonly #options: McpLoadOptions;
  readonly #clients = new Map<string, Client>();

  constructor(options: McpLoadOptions) {
    this.#options = options;
  }

  async loadInto(host: ExtensionHost): Promise<McpLoadResult> {
    const config = loadMcpConfig(this.#options);
    const result: McpLoadResult = { connected: [], errors: [], config };
    const timeoutMs = this.#options.connectTimeoutMs ?? 10_000;

    for (const server of config.servers) {
      try {
        const client = new Client({ name: "kaya", version: "0.1.0" });
        const { transport, kind } = createTransport(server);
        await Promise.race([
          client.connect(transport),
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error(`connect timeout after ${timeoutMs}ms`)), timeoutMs),
          ),
        ]);
        const tools = await client.listTools();
        const toolNames: string[] = [];
        for (const tool of tools.tools) {
          host.loadFactory(
            (kaya) => {
              kaya.registerTool(toAgentTool(server.name, tool, client));
            },
            { path: `<mcp:${server.name}>`, kind: "inline" },
          );
          toolNames.push(mcpToolName(server.name, tool.name));
        }
        this.#clients.set(server.name, client);
        result.connected.push({ name: server.name, transport: kind, toolNames });
      } catch (error) {
        result.errors.push({
          name: server.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }

  /** Close all MCP client connections (called on session dispose/reload). */
  async close(): Promise<void> {
    for (const client of this.#clients.values()) {
      await client.close().catch(() => {});
    }
    this.#clients.clear();
  }
}
