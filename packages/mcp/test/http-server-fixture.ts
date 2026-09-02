import * as http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

/**
 * A REAL MCP server (the official SDK's McpServer over the streamable-HTTP
 * server transport) used by the loader tests. One registered tool: echo.
 */
export async function createRealHttpMcpServer(): Promise<{ url: string; close(): Promise<void> }> {
  const mcp = new McpServer({ name: "kaya-test-mcp", version: "0.0.1" });
  mcp.registerTool(
    "echo",
    { description: "Echoes text back", inputSchema: { text: z.string() } },
    ({ text }) => ({ content: [{ type: "text" as const, text: `echo: ${text}` }] }),
  );

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
  await mcp.connect(transport);

  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/mcp") {
      void transport.handleRequest(req, res);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        void transport.close().then(() => server.close(() => resolve()));
      }),
  };
}
