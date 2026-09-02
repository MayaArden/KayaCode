import * as fs from "node:fs";
import * as path from "node:path";

/**
 * MCP server configuration. Follows kaya's existing convention: config files
 * live alongside `.kaya/extensions/` — `<cwd>/.kaya/mcp.json` (project) and
 * `<configDir>/mcp.json` (global ~.kaya). Both files merge (project wins on
 * name conflicts).
 *
 * Shape (the de-facto `mcpServers` map, familiar from other MCP clients):
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
 *     "api": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ..." } },
 *     "legacy": { "url": "https://example.com/sse", "transport": "sse" }
 *   }
 * }
 * ```
 */
export interface McpServerConfig {
  name: string;
  /** stdio transport */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** remote transports: streamable HTTP by default, "sse" for legacy servers */
  url?: string;
  transport?: "http" | "sse";
  headers?: Record<string, string>;
}

export interface McpFileConfig {
  mcpServers?: Record<string, Omit<McpServerConfig, "name">>;
}

export interface McpResolvedConfig {
  servers: McpServerConfig[];
  /** Config files that were found and parsed. */
  files: string[];
}

function readConfigFile(filePath: string): McpServerConfig[] {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as McpFileConfig;
  const servers: McpServerConfig[] = [];
  for (const [name, config] of Object.entries(raw.mcpServers ?? {})) {
    servers.push({ name, ...config });
  }
  return servers;
}

/** Load and merge MCP configs. Missing/unparseable files are skipped silently. */
export function loadMcpConfig(options: { cwd: string; configDir?: string }): McpResolvedConfig {
  const files = [
    options.configDir ? path.join(options.configDir, "mcp.json") : undefined,
    path.join(options.cwd, ".kaya", "mcp.json"),
  ].filter((p): p is string => p !== undefined);

  const byName = new Map<string, McpServerConfig>();
  const found: string[] = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    try {
      found.push(file);
      for (const server of readConfigFile(file)) {
        // Later files (project) win over earlier (global).
        byName.set(server.name, server);
      }
    } catch {
      // Corrupt config: skip the file; MCP is optional infrastructure.
    }
  }
  // Reorder so project's entries land in map-order after global's.
  return { servers: [...byName.values()], files: found };
}
