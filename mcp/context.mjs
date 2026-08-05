/**
 * Shared MCP context for figma-meta-mcp.
 */

export const FIGMA_BRIDGE =
  process.env.FIGMA_MCP_BRIDGE || "http://127.0.0.1:3851";

export function bridgeUnreachableHint(err) {
  return [
    `Cannot reach Figma bridge at ${FIGMA_BRIDGE}.`,
    `Reason: ${err && err.message ? err.message : String(err)}`,
    "",
    "Checklist:",
    "  1. Cursor MCP `figma-meta-mcp` is running (it hosts the bridge).",
    "  2. Figma desktop is open on the target file.",
    "  3. Plugins → Development → Import plugin from manifest… → plugin/manifest.json",
    "  4. Run the plugin and keep its panel open (WebSocket stays connected).",
  ].join("\n");
}
