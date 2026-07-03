// POST /api/clear — wipe the shared canvas. Admin only.
const { getWorld, pipeline, emptyGrid, isAdmin, sendJson } = require("../lib/core");

module.exports = async (req, res) => {
  if (req.method !== "POST") { sendJson(res, 405, {}); return; }
  if (!isAdmin(req)) { sendJson(res, 403, { error: "admin token required" }); return; }
  const { state } = await getWorld();
  await pipeline([["SET", "pc:grid", emptyGrid(state.w, state.h)]]);
  res.writeHead(204);
  res.end();
};
