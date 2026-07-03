// GET /api/boot — everything a freshly loaded client needs.
const { PALETTE, EMPTY, ICONS, getWorld, isAdmin, sendJson, ADMIN_TOKEN } = require("../lib/core");

module.exports = async (req, res) => {
  const { state, grid } = await getWorld();
  sendJson(res, 200, {
    palette: PALETTE,
    empty: EMPTY,
    icons: ICONS,
    admin: isAdmin(req),
    adminConfigured: Boolean(ADMIN_TOKEN),
    now: Date.now(),
    state,
    grid,
  });
};
