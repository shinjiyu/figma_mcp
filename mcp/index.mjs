#!/usr/bin/env node
/**
 * figma-meta-mcp entry: stdio MCP + local HTTP/WS bridge for the Figma plugin.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startBridge } from "../bridge/server.mjs";
import { registerTools, getBridgeUrl } from "./core.mjs";

async function main() {
  const port = Number(process.env.FIGMA_MCP_PORT || 3851);
  const host = process.env.FIGMA_MCP_HOST || "127.0.0.1";
  await startBridge(port, host);

  const server = new McpServer({
    name: "figma-meta-mcp",
    version: "0.1.0",
  });

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`[figma-meta-mcp] MCP connected. bridge=${getBridgeUrl()}`);
}

main().catch((err) => {
  console.error("[figma-meta-mcp] fatal:", err);
  process.exit(1);
});
