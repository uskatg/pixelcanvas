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
const DEFAULT_W = 64, DEFAULT_H = 64; // free-drawing canvas (no task open)
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
  // sampled from the Warhol Marilyn (Bild 2)
  "#e2abb7", // muted pink (skin)
  "#a1251b", // dark red (lips)
  "#64a0d2", // cornflower blue (background)
  "#6fc5c0", // turquoise (eyeshadow)
  "#a17849", // ochre (hair shadow)
  "#362522", // dark brown (outlines)
];
const EMPTY = -1;

// Canvas shape per task, matching each reference image's proportion.
// Bild 1 (720×720) → square; Bild 2 (720×475) → landscape, higher resolution
// (the Marilyn needs more cells to be recognisable).
const TASK_DIMS = { "1": { w: 32, h: 32 }, "2": { w: 48, h: 32 } };

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
const mem = { kv: new Map(), hash: new Map(), set: new Map() };
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
      case "HINCRBY": {
        const [key, field, by] = args;
        if (!mem.hash.has(key)) mem.hash.set(key, new Map());
        const h = mem.hash.get(key);
        const next = (parseInt(h.get(field) || "0", 10) || 0) + Number(by);
        h.set(field, String(next));
        return next;
      }
      case "EXPIRE": return 1; // no-op locally (mem store isn't persisted long-term)
      case "SADD": {
        const [key, ...members] = args;
        if (!mem.set.has(key)) mem.set.set(key, new Set());
        const s = mem.set.get(key); let added = 0;
        members.forEach((m) => { if (!s.has(m)) { s.add(m); added++; } });
        return added;
      }
      case "SREM": {
        const [key, ...members] = args;
        const s = mem.set.get(key); let removed = 0;
        if (s) members.forEach((m) => { if (s.delete(m)) removed++; });
        return removed;
      }
      case "SISMEMBER": { const s = mem.set.get(args[0]); return s && s.has(args[1]) ? 1 : 0; }
      case "SMEMBERS": { const s = mem.set.get(args[0]); return s ? [...s] : []; }
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
// state.ts is a write timestamp: clients ignore any state older than the newest
// one they have applied, so a poll response that raced a task switch can't
// flap the UI back to the previous task.
function defaultState() {
  return { w: DEFAULT_W, h: DEFAULT_H, task: null, deadline: null, paused: null, duration: DEFAULT_SECONDS, verdict: null, ts: 0 };
}

function emptyGrid(w, h) { return ".".repeat(w * h); }

// Write grid + state atomically. Non-atomic SETs let a concurrent reader see a
// new grid with the old state mid-switch, which used to trigger a "repair"
// that reverted the task — Redis EVAL scripts execute atomically.
async function setWorld(grid, state) {
  if (REDIS_URL) {
    await redisPipeline([[
      "EVAL",
      "redis.call('SET', KEYS[1], ARGV[1]) redis.call('SET', KEYS[2], ARGV[2]) return 1",
      "2", "pc:grid", "pc:state", grid, JSON.stringify(state),
    ]]);
  } else {
    memPipeline([["SET", "pc:grid", grid], ["SET", "pc:state", JSON.stringify(state)]]);
  }
}

// Paint cells, guarded by the grid's current length so a paint that raced a
// task switch can't SETRANGE past the end (which would pad with NUL bytes).
// Optional stats = { key, id, n } records per-player pixel counts for the round
// in the SAME pipeline round-trip (HINCRBY + EXPIRE so old rounds self-clean).
async function paintCells(cells, stats) { // cells: [{ off, ch }]
  if (!cells.length) return;
  const withStats = stats && stats.key && stats.id && stats.n > 0;
  if (REDIS_URL) {
    const argv = [];
    for (const c of cells) argv.push(String(c.off), c.ch);
    const cmds = [[
      "EVAL",
      "local len = redis.call('STRLEN', KEYS[1]) " +
      "for i = 1, #ARGV, 2 do local off = tonumber(ARGV[i]) " +
      "if off + 1 <= len then redis.call('SETRANGE', KEYS[1], off, ARGV[i + 1]) end end return len",
      "1", "pc:grid", ...argv,
    ]];
    if (withStats) {
      cmds.push(["HINCRBY", stats.key, stats.id, String(stats.n)]);
      cmds.push(["EXPIRE", stats.key, "3600"]);
    }
    await redisPipeline(cmds);
  } else {
    let g = mem.kv.get("pc:grid") || "";
    for (const c of cells) if (c.off < g.length) g = g.slice(0, c.off) + c.ch + g.slice(c.off + 1);
    mem.kv.set("pc:grid", g);
    if (withStats) memPipeline([["HINCRBY", stats.key, stats.id, stats.n]]);
    scheduleLocalSave();
  }
}

// Wipe the canvas at whatever size it currently is (atomic, dims-agnostic).
async function clearGrid() {
  if (REDIS_URL) {
    await redisPipeline([[
      "EVAL",
      "local len = redis.call('STRLEN', KEYS[1]) redis.call('SET', KEYS[1], string.rep('.', len)) return len",
      "1", "pc:grid",
    ]]);
  } else {
    const g = mem.kv.get("pc:grid") || "";
    mem.kv.set("pc:grid", ".".repeat(g.length));
    scheduleLocalSave();
  }
}

// Read state + grid. Never writes on mismatch — a length mismatch can only be
// a transient race with a task switch, and the next read is consistent again.
async function getWorld() {
  const [stateRaw, grid] = await pipeline([["GET", "pc:state"], ["GET", "pc:grid"]]);
  let state = null;
  try { state = JSON.parse(stateRaw); } catch {}
  let g = typeof grid === "string" ? grid : "";
  if (!state || !Number.isInteger(state.w) || !Number.isInteger(state.h)) {
    state = defaultState();
    if (!g) { // first boot: initialise the world once
      g = emptyGrid(state.w, state.h);
      await setWorld(g, state);
    }
  }
  if (g.length !== state.w * state.h) g = emptyGrid(state.w, state.h);
  return { state, grid: g };
}

async function saveState(state) {
  state.ts = Date.now();
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
      else players.push({ id: flat[i], name: p.name, icon: p.icon });
    } catch { stale.push(flat[i]); }
  }
  if (stale.length) pipeline([["HDEL", "pc:players", ...stale]]).catch(() => {});
  return players;
}

// ---- HTTP helpers -----------------------------------------------------------------
function isAdmin(req) {
  // No token AND no Redis → local dev, everything open. With Redis configured
  // (production) a missing ADMIN_TOKEN fails closed — otherwise every visitor
  // could clear the canvas and trigger paid /api/evaluate calls.
  if (!ADMIN_TOKEN) return !REDIS_URL;
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
  pipeline, getWorld, saveState, setWorld, paintCells, clearGrid, emptyGrid, defaultState,
  touchAndListPlayers, isAdmin, sendJson, readJson,
};
