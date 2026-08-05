#!/usr/bin/env node
/**
 * Print a ready-to-paste Cursor mcp.json snippet for this checkout.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "mcp", "index.mjs");
const entryPosix = entry.replace(/\\/g, "/");

const snippet = {
  mcpServers: {
    "figma-meta-mcp": {
      command: "node",
      args: [entryPosix],
      env: {
        FIGMA_MCP_PORT: "3851",
      },
    },
  },
};

console.log("Paste into ~/.cursor/mcp.json (merge under mcpServers):\n");
console.log(JSON.stringify(snippet, null, 2));
console.log("\nThen:");
console.log("  1. Toggle figma-meta-mcp in Cursor Settings → MCP");
console.log("  2. Figma → Plugins → Development → Import plugin from manifest…");
console.log(`     ${path.join(root, "plugin", "manifest.json").replace(/\\/g, "/")}`);
console.log("  3. Run the plugin and keep the panel open");
