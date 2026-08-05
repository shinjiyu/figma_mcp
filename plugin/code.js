/**
 * Figma plugin main thread — receives exec jobs from ui.html and runs them
 * against the Plugin API (`figma`).
 */

function jsonSafe(value) {
  const seen = new WeakSet();
  return JSON.parse(
    JSON.stringify(value, (_key, v) => {
      if (typeof v === "function" || typeof v === "symbol") return undefined;
      if (v && typeof v === "object") {
        // SceneNode-like: shrink to plain fields
        if (typeof v.id === "string" && typeof v.type === "string" && "name" in v) {
          const out = {
            id: v.id,
            name: v.name,
            type: v.type,
          };
          if ("x" in v) out.x = v.x;
          if ("y" in v) out.y = v.y;
          if ("width" in v) out.width = v.width;
          if ("height" in v) out.height = v.height;
          return out;
        }
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }
      return v;
    })
  );
}

async function runUserCode(code) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  // User writes a body; we wrap so both `return x` and bare expressions work.
  const wrapped =
    `"use strict";\n` +
    `return await (async () => {\n${code}\n})();`;
  const fn = new AsyncFunction("figma", wrapped);
  const result = await fn(figma);
  return jsonSafe(result === undefined ? null : result);
}

figma.showUI(__html__, { width: 320, height: 160, themeColors: true });

figma.ui.onmessage = async (msg) => {
  if (!msg || msg.type !== "exec") return;
  try {
    const result = await runUserCode(String(msg.code || ""));
    figma.ui.postMessage({ type: "result", id: msg.id, ok: true, result });
  } catch (err) {
    figma.ui.postMessage({
      type: "result",
      id: msg.id,
      ok: false,
      error: err && err.stack ? err.stack : String(err),
    });
  }
};
