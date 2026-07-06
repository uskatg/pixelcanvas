// GET /api/stats?round=<deadline> — per-player pixel leaderboard for a round.
// Joins the pc:stats:<round> counts with the pc:players roster (both keyed by
// clientId) and returns the top painters. Open to all (read-only, once per
// client when the time-up modal opens).
const { pipeline, sendJson } = require("../lib/core");

module.exports = async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const round = url.searchParams.get("round");
  if (!round) { sendJson(res, 200, { players: [] }); return; }

  const [statsFlat, playersFlat] = await pipeline([
    ["HGETALL", "pc:stats:" + round],
    ["HGETALL", "pc:players"],
  ]);

  // clientId -> { name, icon } from the roster.
  const who = {};
  const pf = playersFlat || [];
  for (let i = 0; i < pf.length; i += 2) {
    try { const p = JSON.parse(pf[i + 1]); who[pf[i]] = { name: p.name, icon: p.icon }; } catch {}
  }

  const rows = [];
  const sf = statsFlat || [];
  for (let i = 0; i < sf.length; i += 2) {
    const count = parseInt(sf[i + 1], 10) || 0;
    if (count <= 0) continue;
    const info = who[sf[i]] || { name: "?", icon: "" };
    rows.push({ name: info.name, icon: info.icon, count });
  }
  rows.sort((a, b) => b.count - a.count);
  sendJson(res, 200, { players: rows.slice(0, 8) });
};
