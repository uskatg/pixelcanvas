// GET /api/poll?id=&name=&icon= — live sync: current grid + shared state +
// roster. Also refreshes this client's presence entry.
const { getWorld, touchAndListPlayers, sendJson } = require("../lib/core");

module.exports = async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const [world, players] = await Promise.all([
    getWorld(),
    touchAndListPlayers(url.searchParams.get("id"), url.searchParams.get("name"), url.searchParams.get("icon")),
  ]);
  sendJson(res, 200, { grid: world.grid, state: world.state, players, now: Date.now() });
};
