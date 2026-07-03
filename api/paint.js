// POST /api/paint {x, y, c} — paint one cell (open to all players).
const { PALETTE, EMPTY, getWorld, pipeline, sendJson, readJson } = require("../lib/core");

module.exports = async (req, res) => {
  if (req.method !== "POST") { sendJson(res, 405, {}); return; }
  const { x, y, c } = await readJson(req, 1000);
  const { state } = await getWorld();
  if (
    Number.isInteger(x) && Number.isInteger(y) &&
    x >= 0 && x < state.w && y >= 0 && y < state.h &&
    Number.isInteger(c) && c >= EMPTY && c < PALETTE.length
  ) {
    const ch = c === EMPTY ? "." : String(c);
    await pipeline([["SETRANGE", "pc:grid", y * state.w + x, ch]]);
  }
  res.writeHead(204);
  res.end();
};
