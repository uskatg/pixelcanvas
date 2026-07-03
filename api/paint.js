// POST /api/paint {cells:[{x,y,c},...]} — paint a batch of cells (open to all
// players). Clients queue their strokes and flush every ~200ms so a fast drag
// is one request instead of dozens. A single {x,y,c} body is also accepted.
const { PALETTE, EMPTY, getWorld, paintCells, sendJson, readJson } = require("../lib/core");

module.exports = async (req, res) => {
  if (req.method !== "POST") { sendJson(res, 405, {}); return; }
  const body = await readJson(req, 100_000);
  const { state } = await getWorld();
  const cells = (Array.isArray(body.cells) ? body.cells : [body]).slice(0, 512);
  const valid = [];
  for (const { x, y, c } of cells) {
    if (
      Number.isInteger(x) && Number.isInteger(y) &&
      x >= 0 && x < state.w && y >= 0 && y < state.h &&
      Number.isInteger(c) && c >= EMPTY && c < PALETTE.length
    ) {
      valid.push({ off: y * state.w + x, ch: c === EMPTY ? "." : String(c) });
    }
  }
  await paintCells(valid);
  res.writeHead(204);
  res.end();
};
