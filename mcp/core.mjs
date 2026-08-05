/**
 * MVP tools: figma_health, figma_exec, figma_selection_info.
 */

import { z } from "zod";
import { exec, health, getBridgeUrl } from "../bridge/server.mjs";
import { bridgeUnreachableHint } from "./context.mjs";

function textResult(value, isError = false) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], isError };
}

const SELECTION_INFO_JS = `
const nodes = figma.currentPage.selection || [];
return {
  fileName: figma.root.name,
  currentPage: { id: figma.currentPage.id, name: figma.currentPage.name },
  selectionCount: nodes.length,
  selection: nodes.map((n) => ({
    id: n.id,
    name: n.name,
    type: n.type,
    x: "x" in n ? n.x : null,
    y: "y" in n ? n.y : null,
    width: "width" in n ? n.width : null,
    height: "height" in n ? n.height : null,
  })),
};
`;

const FIGMA_EXEC_DESCRIPTION = [
  "Execute JavaScript inside the running Figma plugin main thread (like ae_exec / cocosmcp_exec / Blender execute_blender_code).",
  "The code runs with access to the global `figma` Plugin API.",
  "Write an async body; the final expression / return value is JSON-serialized back.",
  "Prefer plain data (id/name/type/x/y/width/height). Avoid returning live node proxies.",
  "Example:",
  "  return figma.currentPage.selection.map(n => ({ id: n.id, name: n.name, type: n.type }));",
].join("\n");

export function registerTools(server) {
  server.tool(
    "figma_health",
    "Check whether the local Figma bridge is up and whether the Development plugin is connected.",
    {},
    async () => {
      try {
        const body = {
          ...health(),
          bridge: getBridgeUrl(),
        };
        return textResult(body, !body.pluginConnected);
      } catch (err) {
        return textResult(bridgeUnreachableHint(err), true);
      }
    }
  );

  server.tool(
    "figma_exec",
    FIGMA_EXEC_DESCRIPTION,
    {
      code: z
        .string()
        .describe(
          "Plugin-main JavaScript body. Can use await. Return JSON-serializable data."
        ),
    },
    async ({ code }) => {
      try {
        const body = await exec(code);
        return textResult(body, body && body.ok === false);
      } catch (err) {
        return textResult(bridgeUnreachableHint(err), true);
      }
    }
  );

  server.tool(
    "figma_selection_info",
    "Summarize the current page and selection (id/name/type/bounds).",
    {},
    async () => {
      try {
        const body = await exec(SELECTION_INFO_JS);
        return textResult(body, body && body.ok === false);
      } catch (err) {
        return textResult(bridgeUnreachableHint(err), true);
      }
    }
  );
}

export { getBridgeUrl };
