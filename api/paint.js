// POST /api/paint {cells:[{x,y,c},...]} — paint a batch of cells (open to all
// players). Clients queue their strokes and flush every ~200ms so a fast drag
// is one request instead of dozens. A single {x,y,c} body is also accepted.
const { PALETTE, EMPTY, getWorld, paintCells, pipeline, sendJson, readJson } = require("../lib/core");

module.exports = async (req, res) => {
  if (req.method !== "POST") { sendJson(res, 405, {}); return; }
  const body = await readJson(req, 100_000);
  const id = typeof body.id === "string" && body.id ? body.id.slice(0, 40) : null;
  // Muted by the host → silently drop (offender still sees their local strokes,
  // which revert on the next poll; everyone else is unaffected).
  if (id) {
    const [muted] = await pipeline([["SISMEMBER", "pc:muted", id]]);
    if (Number(muted) === 1) { res.writeHead(204); res.end(); return; }
  }
  const { state, grid } = await getWorld();
  // Round over → the canvas is frozen so the AI rating matches what everyone
  // painted. 1.5s grace covers a flush that was in flight when the clock hit 0.
  if (state.task && state.deadline !== null && Date.now() > state.deadline + 1500) {
    res.writeHead(204);
    res.end();
    return;
  }
  const cells = (Array.isArray(body.cells) ? body.cells : [body]).slice(0, 512);
  const valid = [];
  for (const { x, y, c } of cells) {
    if (
      Number.isInteger(x) && Number.isInteger(y) &&
      x >= 0 && x < state.w && y >= 0 && y < state.h &&
      Number.isInteger(c) && c >= EMPTY && c < PALETTE.length
    ) {
      // one char per cell: '.' = empty, then '0','1',… ('0'+index — indexes
      // past 9 become ':',';','<'… so this works beyond ten colors)
      valid.push({ off: y * state.w + x, ch: c === EMPTY ? "." : String.fromCharCode(48 + c) });
    }
  }
  // Per-round pixel tally per player (leaderboard on the time-up screen). Only
  // while a round is live; the key is scoped to the round's deadline.
  const stats = (id && state.task && state.deadline !== null)
    ? { key: "pc:stats:" + state.deadline, id, n: valid.length }
    : null;
  await paintCells(valid, stats);
  // Return the world that was read above: active painters apply it like a poll
  // response, so they see others' strokes at flush cadence (~200ms) instead of
  // waiting for the next poll. Costs no extra Redis commands — the grid was
  // already fetched for validation. (It predates this batch's write; the
  // client's pending-cell protection keeps its own strokes intact.)
  sendJson(res, 200, { grid, state, now: Date.now() });
};
