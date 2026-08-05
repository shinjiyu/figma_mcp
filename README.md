# figma-meta-mcp

Lightweight **Figma MCP** in the same mental model as
[ae-meta-mcp](https://github.com/shinjiyu/ae_meta_mcp) (`ae_exec`) and
CocosMetaMCP (`cocosmcp_exec`): the Cursor agent runs JavaScript **inside a
running Figma** via `figma_exec`.

```text
Cursor Agent  ──stdio MCP──▶  Node (MCP + bridge :3851)
                                   ▲
                                   │ WebSocket /plugin
                              Figma Development plugin (UI + main)
                                   │
                              figma.* Plugin API
```

This path does **not** use the Figma REST API + Personal Access Token, so it
avoids the Viewer-seat REST monthly rate limits. You need the Figma desktop app
and the local Development plugin panel open.

> Repo: [shinjiyu/figma_mcp](https://github.com/shinjiyu/figma_mcp)

## Tools (MVP)

| Tool | Description |
|------|-------------|
| `figma_health` | Bridge up? Plugin WebSocket connected? |
| `figma_exec` | Run arbitrary Plugin-API JS in the main thread; return JSON |
| `figma_selection_info` | Summarize current page + selection bounds |

## Requirements

- Windows / macOS / Linux
- Node.js >= 18
- [Figma desktop app](https://www.figma.com/downloads/)
- Cursor (or any MCP client)

## Install

```bash
git clone https://github.com/shinjiyu/figma_mcp.git
cd figma_mcp
npm install
```

### Wire Cursor

```bash
npm run setup:cursor
```

Paste the printed snippet into `~/.cursor/mcp.json`, then toggle **figma-meta-mcp**
off/on under Cursor Settings → MCP.

Example:

```json
{
  "mcpServers": {
    "figma-meta-mcp": {
      "command": "node",
      "args": ["D:/workspace/figma_mcp/mcp/index.mjs"],
      "env": {
        "FIGMA_MCP_PORT": "3851"
      }
    }
  }
}
```

### Import the Figma plugin

1. Start Cursor so MCP (and the bridge on `127.0.0.1:3851`) is running.
2. Open your design file in the **Figma desktop** app.
3. Menu: **Plugins → Development → Import plugin from manifest…**
4. Select `plugin/manifest.json` from this repo.
5. Run **Plugins → Development → figma-meta-mcp** and **keep the panel open**.

The panel should show `Connected · plugin channel ready`.

## Verify

1. `figma_health` → `{ ok: true, pluginConnected: true }`
2. `figma_selection_info` → current page + selection
3. `figma_exec`:

```javascript
return {
  file: figma.root.name,
  page: figma.currentPage.name,
  count: figma.currentPage.children.length,
};
```

## Writing `figma_exec` code

- Runs in the **plugin main** thread with global `figma`.
- Write an async body; use `return` for the payload.
- Return plain JSON (id / name / type / x / y / width / height). Live node
  proxies are auto-shrunk when possible, but prefer mapping yourself.
- Need document bytes for a node? `await figma.getNodeByIdAsync(id)` (dynamic-page).

See `skills/figma-plugin-api/SKILL.md`.

## Layout

```text
mcp/      stdio MCP server (index, core, context)
bridge/   HTTP + WebSocket host used by the plugin UI
plugin/   Figma Development plugin (manifest, code.js, ui.html)
scripts/  setup-cursor.mjs
skills/   agent notes for Plugin API
examples/ cursor-mcp.json
```

## Env

| Variable | Default | Meaning |
|----------|---------|---------|
| `FIGMA_MCP_PORT` | `3851` | Bridge listen port |
| `FIGMA_MCP_HOST` | `127.0.0.1` | Bridge bind host |
| `FIGMA_MCP_EXEC_TIMEOUT_MS` | `30000` | Per-job timeout |

## Not in scope (yet)

- Official remote Figma MCP OAuth (`mcp.figma.com`) — use that separately if you want cloud tools
- REST PAT wrappers — intentionally avoided for quota reasons
- Recipe/promote layer (CocosMetaMCP-style) — add later if needed

## License

MIT
