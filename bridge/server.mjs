/**
 * In-process + HTTP/WS bridge between MCP tools and the Figma plugin UI.
 *
 * Figma plugins cannot bind a port, so the Node MCP process hosts the bridge;
 * the plugin UI connects as a WebSocket client and executes jobs in the plugin
 * main thread (figma.* API).
 */

import http from "node:http";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";

// Omit / use "::" so Windows `localhost` (often ::1) and 127.0.0.1 both work.
// Binding only 127.0.0.1 makes plugin `ws://localhost:3851` flaky (IPv6 first).
const DEFAULT_HOST = process.env.FIGMA_MCP_HOST || "::";
const DEFAULT_PORT = Number(process.env.FIGMA_MCP_PORT || 3851);
const EXEC_TIMEOUT_MS = Number(process.env.FIGMA_MCP_EXEC_TIMEOUT_MS || 30000);

/** @type {import('ws').WebSocket | null} */
let pluginSocket = null;
/** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
const pending = new Map();

let server = null;
let wss = null;
let listenInfo = { host: DEFAULT_HOST, port: DEFAULT_PORT };

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function pluginConnected() {
  return !!(pluginSocket && pluginSocket.readyState === 1);
}

function settle(id, payload) {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(id);
  entry.resolve(payload);
}

/**
 * Run code inside the connected Figma plugin main thread.
 * @param {string} code
 * @returns {Promise<{ ok: boolean, result?: unknown, error?: string, ms?: number }>}
 */
export function exec(code) {
  if (!pluginConnected()) {
    return Promise.resolve({
      ok: false,
      error:
        "Figma plugin not connected. Open Plugins → Development → figma-meta-mcp and keep the panel open.",
    });
  }

  const id = randomUUID();
  const started = Date.now();

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({
        ok: false,
        error: `exec timed out after ${EXEC_TIMEOUT_MS}ms`,
        ms: Date.now() - started,
      });
    }, EXEC_TIMEOUT_MS);

    pending.set(id, {
      resolve: (payload) =>
        resolve({ ...payload, ms: Date.now() - started }),
      reject: () => {},
      timer,
    });

    try {
      pluginSocket.send(
        JSON.stringify({ type: "exec", id, code: String(code ?? "") })
      );
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      resolve({
        ok: false,
        error: err && err.message ? err.message : String(err),
        ms: Date.now() - started,
      });
    }
  });
}

function publicBridgeBase() {
  // Prefer localhost in status strings (matches Figma manifest allowlist).
  const host = listenInfo.host === "::" || listenInfo.host === "0.0.0.0"
    ? "localhost"
    : listenInfo.host;
  return `http://${host}:${listenInfo.port}`;
}

export function health() {
  return {
    ok: true,
    bridge: publicBridgeBase(),
    bind: `${listenInfo.host}:${listenInfo.port}`,
    pluginConnected: pluginConnected(),
    pendingJobs: pending.size,
    pid: process.pid,
  };
}

function handlePluginMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (msg && msg.type === "result" && msg.id) {
    settle(msg.id, {
      ok: !!msg.ok,
      result: msg.result,
      error: msg.error,
    });
  } else if (msg && msg.type === "hello") {
    // no-op; connection already tracked
  }
}

export function startBridge(port = DEFAULT_PORT, host = DEFAULT_HOST) {
  if (server) {
    return Promise.resolve(listenInfo);
  }

  listenInfo = { host, port };

  server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${host}:${port}`);

    if (req.method === "OPTIONS") {
      return json(res, 204, {});
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, health());
    }

    if (req.method === "POST" && url.pathname === "/exec") {
      try {
        const body = await readBody(req);
        const code = body.code ?? body.source ?? "";
        const out = await exec(code);
        return json(res, out.ok ? 200 : 400, out);
      } catch (err) {
        return json(res, 400, {
          ok: false,
          error: err && err.message ? err.message : String(err),
        });
      }
    }

    json(res, 404, { ok: false, error: "not found" });
  });

  wss = new WebSocketServer({ server, path: "/plugin" });

  wss.on("connection", (socket) => {
    if (pluginSocket && pluginSocket.readyState === 1) {
      try {
        pluginSocket.close(4000, "replaced by new plugin connection");
      } catch {
        /* ignore */
      }
    }
    pluginSocket = socket;
    socket.send(JSON.stringify({ type: "welcome", bridge: health() }));

    socket.on("message", handlePluginMessage);
    socket.on("close", () => {
      if (pluginSocket === socket) pluginSocket = null;
      // Fail pending jobs so MCP callers are not stuck.
      for (const [id, entry] of pending.entries()) {
        clearTimeout(entry.timer);
        pending.delete(id);
        entry.resolve({
          ok: false,
          error: "Figma plugin disconnected while job was pending",
        });
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // ipv6Only:false → :: also accepts IPv4-mapped (127.0.0.1) on most platforms
    const listenOpts =
      host === "::"
        ? { port, host: "::", ipv6Only: false }
        : { port, host };
    server.listen(listenOpts, () => {
      console.error(
        `[figma-meta-mcp] bridge listening on ${publicBridgeBase()} (bind ${host}:${port}, ws /plugin)`
      );
      resolve(listenInfo);
    });
  });
}

export function getBridgeUrl() {
  return publicBridgeBase();
}
