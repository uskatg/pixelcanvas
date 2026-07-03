// Shared logic for the Pixel-Canvas API — works both on Vercel (serverless +
// Upstash Redis) and locally via server.js (in-memory store, persisted to
// canvas.json). Pure Node, no dependencies.

const fs = require("fs");
const path = require("path");

// ---- .env loader (local dev; on Vercel the platform provides env vars) ------
(function loadEnv() {
  try {
    const text = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
    for (let line of text.split("\n")) {
      line = line.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch { /* no .env file — that's fine */ }
})();

// ---- Configuration ----------------------------------------------------------
const DEFAULT_W = 64, DEFAULT_H = 64;
const DEFAULT_SECONDS = 180;
const MAX_CELLS = 12000;
const PLAYER_TTL_MS = 15000; // presence expires if a client stops polling

const PALETTE = [
  "#e8402a", // red
  "#2d68b2", // blue
  "#f4c026", // yellow
  "#1a1a1a", // black
  "#ffffff", // white
  "#e63d8f", // synthwave pink
  "#8b4ba8", // synthwave purple
  "#f47a3f", // synthwave orange
  "#2b1840", // synthwave deep purple
];
const EMPTY = -1;

// Canvas shape per task, matching each reference image's proportion.
const TASK_DIMS = { "1": { w: 64, h: 64 }, "2": { w: 64, h: 42 } };

// Player avatar icons (public/players is served statically; serverless functions
// can't readdir it, so the list is fixed here).
const ICONS = ["BlackCat", "Bunny", "Cat", "Dog", "Dragon", "Frog"]
  .map((id) => ({ id, src: "/players/" + id + ".webp" }));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const EVAL_MODEL = "claude-opus-4-8";

// ---- Store: Upstash Redis (REST) or in-memory fallback -----------------------
// Redis keys:  pc:grid  — the canvas as a string, one char per cell
//                          ('.' = empty, '0'-'8' = palette index)
//              pc:state — JSON { w, h, task, deadline, paused, duration, verdict }
//              pc:players — hash  clientId -> JSON { name, icon, ts }

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

async function redisPipeline(commands) {
  const r = await fetch(REDIS_URL + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error("Redis error " + r.status + ": " + (await r.text().catch(() => "")));
  const out = await r.json();
  for (const item of out) if (item.error) throw new Error("Redis: " + item.error);
  return out.map((item) => item.result);
}

// In-memory fallback for local dev — persisted to canvas.json so the canvas
// survives a restart, like the original server did.
const SAVE_FILE = path.join(__dirname, "..", "canvas.json");
const mem = { kv: new Map(), hash: new Map() };
(function loadLocal() {
  if (REDIS_URL) return;
  try {
    const saved = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
    if (saved && typeof saved.grid === "string" && saved.state) {
      mem.kv.set("pc:grid", saved.grid);
      mem.kv.set("pc:state", JSON.stringify(saved.state));
    }
  } catch {}
})();
let saveTimer = null;
function scheduleLocalSave() {
  if (REDIS_URL || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const data = {
      grid: mem.kv.get("pc:grid") || "",
      state: JSON.parse(mem.kv.get("pc:state") || "null"),
    };
    fs.writeFile(SAVE_FILE, JSON.stringify(data), () => {});
  }, 500);
}

function memPipeline(commands) {
  return commands.map(([cmd, ...args]) => {
    switch (cmd) {
      case "GET": return mem.kv.get(args[0]) ?? null;
      case "SET": { mem.kv.set(args[0], args[1]); scheduleLocalSave(); return "OK"; }
      case "SETRANGE": {
        const [key, off, chunk] = args;
        let s = mem.kv.get(key) || "";
        if (s.length < off + chunk.length) s = s.padEnd(off + chunk.length, ".");
        mem.kv.set(key, s.slice(0, off) + chunk + s.slice(off + chunk.length));
        scheduleLocalSave();
        return s.length;
      }
      case "HSET": {
        const [key, field, val] = args;
        if (!mem.hash.has(key)) mem.hash.set(key, new Map());
        mem.hash.get(key).set(field, val);
        return 1;
      }
      case "HGETALL": {
        const flat = [];
        for (const [f, v] of mem.hash.get(args[0]) || []) flat.push(f, v);
        return flat;
      }
      case "HDEL": {
        const [key, ...fields] = args;
        const h = mem.hash.get(key);
        if (h) fields.forEach((f) => h.delete(f));
        return fields.length;
      }
      case "DEL": { args.forEach((k) => { mem.kv.delete(k); mem.hash.delete(k); }); return args.length; }
      default: throw new Error("memPipeline: unsupported command " + cmd);
    }
  });
}

async function pipeline(commands) {
  return REDIS_URL ? redisPipeline(commands) : memPipeline(commands);
}

// ---- State helpers ------------------------------------------------------------
function defaultState() {
  return { w: DEFAULT_W, h: DEFAULT_H, task: null, deadline: null, paused: null, duration: DEFAULT_SECONDS, verdict: null };
}

function emptyGrid(w, h) { return ".".repeat(w * h); }

// Read state + grid, repairing anything missing/inconsistent.
async function getWorld() {
  const [stateRaw, grid] = await pipeline([["GET", "pc:state"], ["GET", "pc:grid"]]);
  let state = null;
  try { state = JSON.parse(stateRaw); } catch {}
  if (!state || !Number.isInteger(state.w) || !Number.isInteger(state.h)) state = defaultState();
  let g = typeof grid === "string" ? grid : "";
  if (g.length !== state.w * state.h) {
    g = emptyGrid(state.w, state.h);
    await pipeline([["SET", "pc:grid", g], ["SET", "pc:state", JSON.stringify(state)]]);
  }
  return { state, grid: g };
}

async function saveState(state) {
  await pipeline([["SET", "pc:state", JSON.stringify(state)]]);
}

// ---- Presence -------------------------------------------------------------------
async function touchAndListPlayers(id, name, icon) {
  const cmds = [];
  if (id && name) {
    cmds.push(["HSET", "pc:players", String(id).slice(0, 40),
      JSON.stringify({ name: String(name).slice(0, 24), icon: String(icon || "").slice(0, 60), ts: Date.now() })]);
  }
  cmds.push(["HGETALL", "pc:players"]);
  const res = await pipeline(cmds);
  const flat = res[res.length - 1] || [];
  const players = [], stale = [];
  const now = Date.now();
  for (let i = 0; i < flat.length; i += 2) {
    try {
      const p = JSON.parse(flat[i + 1]);
      if (now - p.ts > PLAYER_TTL_MS) stale.push(flat[i]);
      else players.push({ name: p.name, icon: p.icon });
    } catch { stale.push(flat[i]); }
  }
  if (stale.length) pipeline([["HDEL", "pc:players", ...stale]]).catch(() => {});
  return players;
}

// ---- HTTP helpers -----------------------------------------------------------------
function isAdmin(req) {
  if (!ADMIN_TOKEN) return true; // no token configured → open (local dev mode)
  return req.headers["x-admin-token"] === ADMIN_TOKEN;
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

async function readJson(req, maxBytes = 1_000_000) {
  // Vercel's Node runtime may have parsed the body already.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "object") return req.body;
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > maxBytes) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

module.exports = {
  PALETTE, EMPTY, TASK_DIMS, ICONS, MAX_CELLS, DEFAULT_SECONDS,
  ANTHROPIC_API_KEY, ADMIN_TOKEN, EVAL_MODEL,
  pipeline, getWorld, saveState, emptyGrid, defaultState,
  touchAndListPlayers, isAdmin, sendJson, readJson,
};
