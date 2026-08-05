---
name: figma-plugin-api
description: >-
  Constraints and recipes for figma-meta-mcp figma_exec against the Figma
  Plugin API. Use when writing or reviewing figma_exec code.
---

# figma_exec (Plugin API)

Code runs in the **plugin main thread** with global `figma`.

## Do

- `return` plain objects / arrays / numbers / strings
- `await figma.getNodeByIdAsync(id)` under `documentAccess: dynamic-page`
- Map nodes yourself:

```javascript
return figma.currentPage.selection.map((n) => ({
  id: n.id,
  name: n.name,
  type: n.type,
  x: n.x,
  y: n.y,
  width: n.width,
  height: n.height,
}));
```

## Don't

- Rely on REST / Personal Access Tokens (not used by this MCP)
- Return giant binary / image bytes unless asked
- Expect the plugin panel to stay connected if the user closed it

## Useful snippets

### Find frames by name

```javascript
const hits = figma.currentPage.findAll(
  (n) => n.type === "FRAME" && n.name.includes("主界面")
);
return hits.map((n) => ({
  id: n.id,
  name: n.name,
  w: n.width,
  h: n.height,
}));
```

### Export PNG (base64) for one node

```javascript
const node = figma.currentPage.selection[0];
if (!node) return { ok: false, error: "no selection" };
const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } });
// Return length only by default — full base64 can be huge.
return { id: node.id, name: node.name, byteLength: bytes.byteLength };
```
