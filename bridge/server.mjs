/**
 * In-process + HTTP/WS bridge between MCP tools and the Figma plugin UI.
 *
 * Security:
 * - Bind loopback only (127.0.0.1 + ::1), never all interfaces
 * - CORS / WebSocket Origin allowlist (Figma + null sandbox), not "*"
 *
 * Figma plugins cannot bind a port, so the Node MCP process hosts the bridge;
 * the plugin UI connects as a WebSocket client and executes jobs in the plugin
 * main thread (figma.* API).
 */

import http from "node:http";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";

const DEFAULT_PORT = Number(process.env.FIGMA_MCP_PORT || 3851);
const EXEC_TIMEOUT_MS = Number(process.env.FIGMA_MCP_EXEC_TIMEOUT_MS || 30000);

/**
 * Origins allowed to call the bridge from a browser/plugin UI.
 * Figma plugin iframes often send Origin "null" or https://www.figma.com.
 * Override with comma-separated FIGMA_MCP_CORS_ORIGINS if needed.
 */
const DEFAULT_ALLOWED_ORIGINS = [
  "null",
  "https://www.figma.com",
  "https://figma.com",
  "https://www.figma.com:443",
  "http://localhost",
  "http://localhost:3851",
  "http://127.0.0.1",
  "http://127.0.0.1:3851",
];

function loadAllowedOrigins() {
  const raw = (process.env.FIGMA_MCP_CORS_ORIGINS || "").trim();
  if (!raw) return new Set(DEFAULT_ALLOWED_ORIGINS);
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

const ALLOWED_ORIGINS = loadAllowedOrigins();

/** @type {import('ws').WebSocket | null} */
let pluginSocket = null;
/** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
const pending = new Map();

/** @type {import('node:http').Server[]} */
const servers = [];
/** @type {import('ws').WebSocketServer[]} */
const wssList = [];

let listenInfo = {
  host: "loopback",
  port: DEFAULT_PORT,
  binds: /** @type {string[]} */ ([]),
};

function isOriginAllowed(origin) {
  // Non-browser clients (curl / same-process) may omit Origin.
  if (origin === undefined || origin === "") return true;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // Allow any https://*.figma.com subdomain used by the desktop shell.
  try {
    const u = new URL(origin);
    if (u.protocol === "https:" && /(^|\.)figma\.com$/i.test(u.hostname)) {
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  const headers = {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
  if (origin === undefined || origin === "") {
    // No Origin → not a CORS browser call; do not emit *.
    return headers;
  }
  if (isOriginAllowed(origin)) {
    // Must echo the specific origin (not *) when credentials aren't used;
    // echoing keeps the allowlist meaningful.
    headers["Access-Control-Allow-Origin"] = origin === "null" ? "null" : origin;
  }
  return headers;
}

function json(req, res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders(req),
  });
  res.end(text);
}

function rejectCors(req, res) {
  json(req, res, 403, {
    ok: false,
    error: `CORS blocked origin: ${req.headers.origin || "(missing)"}`,
  });
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
  return `http://localhost:${listenInfo.port}`;
}

export function health() {
  return {
    ok: true,
    bridge: publicBridgeBase(),
    bind: listenInfo.binds,
    pluginConnected: pluginConnected(),
    pendingJobs: pending.size,
    corsOrigins: [...ALLOWED_ORIGINS],
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
  }
}

function attachPluginSocket(socket) {
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
    for (const [id, entry] of pending.entries()) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.resolve({
        ok: false,
        error: "Figma plugin disconnected while job was pending",
      });
    }
  });
}

function createHttpHandler(port) {
  return async (req, res) => {
    const origin = req.headers.origin;
    // Browser CORS preflight / cross-origin calls must pass allowlist.
    if (origin !== undefined && origin !== "" && !isOriginAllowed(origin)) {
      return rejectCors(req, res);
    }

    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);

    if (req.method === "OPTIONS") {
      return json(req, res, 204, {});
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return json(req, res, 200, health());
    }

    if (req.method === "POST" && url.pathname === "/exec") {
      try {
        const body = await readBody(req);
        const code = body.code ?? body.source ?? "";
        const out = await exec(code);
        return json(req, res, out.ok ? 200 : 400, out);
      } catch (err) {
        return json(req, res, 400, {
          ok: false,
          error: err && err.message ? err.message : String(err),
        });
      }
    }

    json(req, res, 404, { ok: false, error: "not found" });
  };
}

function listenOne(host, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(createHttpHandler(port));
    const wss = new WebSocketServer({
      server,
      path: "/plugin",
      verifyClient(info, done) {
        const origin = info.origin;
        // ws may omit origin for non-browser clients; allow those.
        if (!origin || isOriginAllowed(origin)) {
          done(true);
          return;
        }
        done(false, 403, "CORS origin not allowed");
      },
    });

    wss.on("connection", attachPluginSocket);

    server.once("error", reject);
    server.listen({ port, host }, () => {
      servers.push(server);
      wssList.push(wss);
      resolve(`${host}:${port}`);
    });
  });
}

/**
 * Start loopback listeners on both IPv4 and IPv6 localhost.
 * @param {number} [port]
 * @param {string} [hostOverride] If set (legacy), bind only that host.
 */
export async function startBridge(port = DEFAULT_PORT, hostOverride) {
  if (servers.length) {
    return listenInfo;
  }

  listenInfo.port = port;
  const binds = [];

  if (hostOverride && hostOverride !== "loopback" && hostOverride !== "::") {
    // Explicit override for debugging (e.g. FIGMA_MCP_HOST=127.0.0.1)
    const b = await listenOne(hostOverride, port);
    binds.push(b);
  } else {
    // Prefer dual loopback so Windows `localhost` (::1) and 127.0.0.1 both work,
    // without exposing LAN interfaces (unlike bind "::" / "0.0.0.0").
    const errors = [];
    for (const host of ["127.0.0.1", "::1"]) {
      try {
        binds.push(await listenOne(host, port));
      } catch (err) {
        errors.push(`${host}: ${err && err.message ? err.message : err}`);
      }
    }
    if (!binds.length) {
      throw new Error(
        `Failed to bind loopback bridge on port ${port}: ${errors.join("; ")}`
      );
    }
  }

  listenInfo = { host: "loopback", port, binds };
  console.error(
    `[figma-meta-mcp] bridge ${publicBridgeBase()} binds=[${binds.join(", ")}] CORS allowlist on`
  );
  return listenInfo;
}

export function getBridgeUrl() {
  return publicBridgeBase();
}
