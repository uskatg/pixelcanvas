// POST /api/mute {id, muted: true|false} — mute/unmute a player by clientId.
// Admin only. Muted players' paints are silently dropped (see api/paint.js).
// Soft moderation: a determined griefer can regenerate their id, but this stops
// casual scribbling without nuking the whole canvas.
const { pipeline, isAdmin, sendJson, readJson } = require("../lib/core");

module.exports = async (req, res) => {
  if (req.method !== "POST") { sendJson(res, 405, {}); return; }
  if (!isAdmin(req)) { sendJson(res, 403, { error: "admin token required" }); return; }
  const { id, muted } = await readJson(req, 500);
  if (typeof id !== "string" || !id) { sendJson(res, 400, { error: "id required" }); return; }
  const key = String(id).slice(0, 40);
  await pipeline([[muted ? "SADD" : "SREM", "pc:muted", key]]);
  sendJson(res, 200, { id: key, muted: Boolean(muted) });
};
